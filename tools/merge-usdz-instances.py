import argparse
import os
import shutil
import tempfile
import zipfile

from pxr import Usd, UsdGeom, Gf, Vt, UsdUtils

# See dedupe-usdz-mesh.py for the rationale behind these thresholds - same
# duplicate-detection logic, just a different fix applied to what's found.
EPSILON = 0.001
NORMAL_EPSILON = 0.01


def bbox_min(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    zs = [p[2] for p in points]
    return Gf.Vec3f(min(xs), min(ys), min(zs))


def bbox_max(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    zs = [p[2] for p in points]
    return Gf.Vec3f(max(xs), max(ys), max(zs))


def normalized_key(points, face_counts, face_indices):
    origin = bbox_min(points)
    rounded = tuple(
        (round(p[0] - origin[0], 3), round(p[1] - origin[1], 3), round(p[2] - origin[2], 3))
        for p in points
    )
    return (rounded, tuple(face_counts), tuple(face_indices)), origin


def max_deviation(seq_a, seq_b):
    return max(
        max(abs(a[i] - b[i]) for i in range(len(a)))
        for a, b in zip(seq_a, seq_b)
    )


def merge_instances(stage, max_prototype_points=None):
    """Unlike dedupe-usdz-mesh.py (which keeps every instance prim and only
    makes their arrays byte-identical so the crate file can store the shape
    once), this collapses each group of duplicate instances into ONE new
    mesh prim with all instances' geometry baked into world-space and
    concatenated, deleting the rest. That directly cuts the number of
    separate mesh prims the renderer has to process/draw each frame -
    dedupe-usdz-mesh.py's approach shrinks the file on disk but leaves that
    per-instance render-time cost completely unchanged, which is what was
    still causing slow/laggy/crashing AR despite already being deduped.

    max_prototype_points caps which groups get merged: merging concatenates
    N copies of the prototype's full geometry into one prim, which no longer
    benefits from the crate-level "store one shared copy" trick a same-array
    dedupe gets, so merging a genuinely large/detailed prototype can bloat
    the file far more than the draw-call win is worth. Restricting this to
    small, heavily-repeated props (pallets, bricks, etc.) targets the actual
    draw-call flood without merging the handful of bigger, already-unique
    objects that were never the problem."""
    groups = {}
    skipped_no_points = 0
    skipped_too_large = 0

    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(prim)
        points = mesh.GetPointsAttr().Get()
        face_counts = mesh.GetFaceVertexCountsAttr().Get()
        face_indices = mesh.GetFaceVertexIndicesAttr().Get()
        if not points:
            skipped_no_points += 1
            continue
        key, origin = normalized_key(points, face_counts, face_indices)
        groups.setdefault(key, []).append((prim, origin, points))

    total_prims_before = sum(len(members) for members in groups.values())
    total_prims_after = 0
    prims_rejected_epsilon = 0
    groups_merged = 0

    for key, members in groups.items():
        if len(members) == 1:
            total_prims_after += 1
            continue

        prototype_prim, prototype_origin, prototype_points = members[0]
        if max_prototype_points is not None and len(prototype_points) > max_prototype_points:
            skipped_too_large += 1
            total_prims_after += len(members)
            continue
        prototype_normalized = [p - prototype_origin for p in prototype_points]
        prototype_mesh = UsdGeom.Mesh(prototype_prim)
        face_counts = prototype_mesh.GetFaceVertexCountsAttr().Get()
        face_indices = prototype_mesh.GetFaceVertexIndicesAttr().Get()
        prototype_normals = prototype_mesh.GetNormalsAttr().Get()
        prototype_st_pv = UsdGeom.PrimvarsAPI(prototype_prim).GetPrimvar("st")
        prototype_has_st = bool(prototype_st_pv) and prototype_st_pv.HasValue()
        prototype_st = prototype_st_pv.Get() if prototype_has_st else None
        prototype_sti = prototype_st_pv.GetIndices() if prototype_has_st else None

        accepted = []
        for prim, origin, points in members:
            local = [p - origin for p in points]
            dev = max_deviation(local, prototype_normalized)
            if dev > EPSILON:
                prims_rejected_epsilon += 1
                total_prims_after += 1
                continue
            mesh = UsdGeom.Mesh(prim)
            normals = mesh.GetNormalsAttr().Get()
            if (normals is None) != (prototype_normals is None):
                prims_rejected_epsilon += 1
                total_prims_after += 1
                continue
            if normals is not None and (
                len(normals) != len(prototype_normals)
                or max_deviation(normals, prototype_normals) > NORMAL_EPSILON
            ):
                prims_rejected_epsilon += 1
                total_prims_after += 1
                continue
            st_pv = UsdGeom.PrimvarsAPI(prim).GetPrimvar("st")
            has_st = bool(st_pv) and st_pv.HasValue()
            if has_st != prototype_has_st:
                prims_rejected_epsilon += 1
                total_prims_after += 1
                continue
            accepted.append((prim, origin))

        if len(accepted) < 2:
            total_prims_after += len(members)
            continue

        groups_merged += 1
        n_proto_points = len(prototype_points)

        merged_points = []
        merged_face_counts = []
        merged_face_indices = []
        merged_normals = [] if prototype_normals is not None else None
        merged_sti = [] if prototype_sti else None

        for i, (prim, origin) in enumerate(accepted):
            offset = Gf.Vec3f(origin[0], origin[1], origin[2])
            merged_points.extend(p + offset for p in prototype_normalized)
            merged_face_counts.extend(face_counts)
            merged_face_indices.extend(idx + i * n_proto_points for idx in face_indices)
            if merged_normals is not None:
                merged_normals.extend(prototype_normals)
            if merged_sti is not None:
                merged_sti.extend(prototype_sti)

        # Reuse the first accepted prim as the merged mesh; delete the rest.
        keep_prim, _ = accepted[0]
        keep_mesh = UsdGeom.Mesh(keep_prim)
        keep_mesh.GetPointsAttr().Set(Vt.Vec3fArray(merged_points))
        keep_mesh.GetFaceVertexCountsAttr().Set(Vt.IntArray(merged_face_counts))
        keep_mesh.GetFaceVertexIndicesAttr().Set(Vt.IntArray(merged_face_indices))
        if merged_normals is not None:
            keep_mesh.GetNormalsAttr().Set(Vt.Vec3fArray(merged_normals))
        if prototype_has_st:
            keep_st_pv = UsdGeom.PrimvarsAPI(keep_prim).GetPrimvar("st")
            keep_st_pv.Set(prototype_st)
            if merged_sti is not None:
                keep_st_pv.SetIndices(Vt.IntArray(merged_sti))
        keep_mesh.GetExtentAttr().Set(
            [Gf.Vec3f(*bbox_min(merged_points)), Gf.Vec3f(*bbox_max(merged_points))]
        )
        # Points are now baked to this prim's own local space directly - any
        # existing per-instance translate (from a prior dedupe-usdz-mesh.py
        # run, or none at all) no longer applies and must be cleared.
        UsdGeom.XformCommonAPI(keep_prim).SetTranslate(Gf.Vec3d(0, 0, 0))

        for prim, _ in accepted[1:]:
            stage.RemovePrim(prim.GetPath())
        total_prims_after += 1

    return {
        "skipped_no_points": skipped_no_points,
        "skipped_too_large": skipped_too_large,
        "total_prims_before": total_prims_before,
        "total_prims_after": total_prims_after,
        "groups_merged": groups_merged,
        "prims_rejected_epsilon": prims_rejected_epsilon,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Merge repeated mesh instances in a .usdz (e.g. many copies of the same "
        "pallet/brick) into one combined mesh per group, baking each instance's world-space "
        "position into its points directly. Unlike dedupe-usdz-mesh.py (storage-only, keeps "
        "every instance prim), this actually reduces the number of separate objects the "
        "renderer has to process each frame."
    )
    parser.add_argument("input_usdz")
    parser.add_argument("output_usdz")
    parser.add_argument(
        "--max-prototype-points",
        type=int,
        default=None,
        help="Skip merging any duplicate group whose prototype has more than this many "
        "points - keeps the merge targeted at small, heavily-repeated props instead of "
        "also merging (and bloating) larger, less-repeated objects. Omit to merge every "
        "duplicate group found, regardless of size.",
    )
    args = parser.parse_args()

    input_usdz = os.path.abspath(args.input_usdz)
    output_usdz = os.path.abspath(args.output_usdz)
    before_size = os.path.getsize(input_usdz)

    workdir = tempfile.mkdtemp(prefix="usdz-merge-")
    original_cwd = os.getcwd()
    try:
        with zipfile.ZipFile(input_usdz) as zf:
            usdc_name = zf.namelist()[0]
            zf.extractall(workdir)

        os.chdir(workdir)
        stage = Usd.Stage.Open(usdc_name)
        stats = merge_instances(stage, max_prototype_points=args.max_prototype_points)
        stage.GetRootLayer().Export(usdc_name)

        os.makedirs(os.path.dirname(output_usdz) or ".", exist_ok=True)
        ok = UsdUtils.CreateNewUsdzPackage(usdc_name, output_usdz)
        if not ok:
            raise RuntimeError("UsdUtils.CreateNewUsdzPackage failed")

        after_size = os.path.getsize(output_usdz)
        pct = 100 * (1 - after_size / before_size)
        print(f"Merged {input_usdz} -> {output_usdz}")
        print(f"  groups merged: {stats['groups_merged']}")
        print(f"  groups skipped (prototype over --max-prototype-points): {stats['skipped_too_large']}")
        print(f"  prims rejected (>1mm deviation from prototype): {stats['prims_rejected_epsilon']}")
        print(f"  mesh prims: {stats['total_prims_before']} -> {stats['total_prims_after']} "
              f"({100 * (1 - stats['total_prims_after'] / stats['total_prims_before']):.1f}% fewer)")
        print(f"  file size: {before_size / 1e6:.1f}MB -> {after_size / 1e6:.1f}MB ({pct:.0f}% smaller)")
    finally:
        os.chdir(original_cwd)
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
