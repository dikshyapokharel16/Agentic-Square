import argparse
import os
import shutil
import tempfile
import zipfile

from pxr import Usd, UsdGeom, Gf, UsdUtils

# Two points are considered "the same vertex" if within this distance (meters).
# Original exports are already only precise to ~1mm, so this doesn't lose
# visible detail; it's how we tolerate float noise between separately-exported
# copies of what is conceptually the same object placed at different spots.
EPSILON = 0.001

# Normals are unit vectors. Measured on real duplicate instances in this
# project's exports, benign per-instance float noise goes up to ~0.001; a
# genuinely different orientation (e.g. a mirrored instance) shows up as a
# ~1.0 deviation (flipped direction), nowhere close to this threshold - so
# there's a wide, safe margin between "noise" and "actually different".
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
    """Max per-component absolute difference between two same-length sequences
    of Vec3f/Vec2f-like tuples. Used for both points (meters) and normals
    (unit vectors) - the same absolute epsilon is conservative for normals
    since their components are bounded to [-1, 1]."""
    return max(
        max(abs(a[i] - b[i]) for i in range(len(a)))
        for a, b in zip(seq_a, seq_b)
    )


def dedupe(stage):
    groups = {}  # key -> list of (prim, origin, points)
    skipped_no_points = 0

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

    total_points_before = 0
    total_points_after = 0
    prims_rejected_epsilon = 0
    groups_used = 0

    for key, members in groups.items():
        n = len(members[0][2])
        total_points_before += n * len(members)
        if len(members) == 1:
            total_points_after += n
            continue

        prototype_prim, prototype_origin, prototype_points = members[0]
        prototype_normalized = [p - prototype_origin for p in prototype_points]
        prototype_mesh = UsdGeom.Mesh(prototype_prim)
        prototype_normals = prototype_mesh.GetNormalsAttr().Get()
        prototype_st_pv = UsdGeom.PrimvarsAPI(prototype_prim).GetPrimvar("st")
        prototype_has_st = bool(prototype_st_pv) and prototype_st_pv.HasValue()
        prototype_st = prototype_st_pv.Get() if prototype_has_st else None
        prototype_sti = prototype_st_pv.GetIndices() if prototype_has_st else None
        prototype_extent = [Gf.Vec3f(*bbox_min(prototype_normalized)),
                             Gf.Vec3f(*bbox_max(prototype_normalized))]

        accepted = []
        for prim, origin, points in members:
            local = [p - origin for p in points]
            dev = max_deviation(local, prototype_normalized)
            if dev > EPSILON:
                prims_rejected_epsilon += 1
                total_points_after += n  # left as its own unique data
                continue

            # Normals/UVs don't depend on translation, so a genuine duplicate
            # should already match closely - anything further off suggests a
            # different orientation/mapping that the points-only key missed,
            # so play it safe and leave that instance untouched.
            mesh = UsdGeom.Mesh(prim)
            normals = mesh.GetNormalsAttr().Get()
            if (normals is None) != (prototype_normals is None):
                prims_rejected_epsilon += 1
                total_points_after += n
                continue
            if normals is not None and (
                len(normals) != len(prototype_normals)
                or max_deviation(normals, prototype_normals) > NORMAL_EPSILON
            ):
                prims_rejected_epsilon += 1
                total_points_after += n
                continue

            st_pv = UsdGeom.PrimvarsAPI(prim).GetPrimvar("st")
            has_st = bool(st_pv) and st_pv.HasValue()
            if has_st != prototype_has_st:
                prims_rejected_epsilon += 1
                total_points_after += n
                continue

            accepted.append((prim, origin, st_pv if has_st else None))

        if len(accepted) < 2:
            # Nothing to share after epsilon-filtering; leave everyone alone.
            continue

        groups_used += 1
        for prim, origin, st_pv in accepted:
            mesh = UsdGeom.Mesh(prim)
            mesh.GetPointsAttr().Set(prototype_normalized)
            if prototype_normals is not None:
                mesh.GetNormalsAttr().Set(prototype_normals)
            if st_pv is not None:
                st_pv.Set(prototype_st)
                if prototype_sti:
                    st_pv.SetIndices(prototype_sti)
            mesh.GetExtentAttr().Set(prototype_extent)
            UsdGeom.XformCommonAPI(prim).SetTranslate(Gf.Vec3d(origin[0], origin[1], origin[2]))
        total_points_after += n  # one shared copy for the whole accepted group

    return {
        "skipped_no_points": skipped_no_points,
        "total_points_before": total_points_before,
        "total_points_after": total_points_after,
        "groups_used": groups_used,
        "prims_rejected_epsilon": prims_rejected_epsilon,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Deduplicate repeated mesh geometry in a .usdz (e.g. many copies of the "
        "same pallet/brick) so USD's crate format can store the shared shape once instead "
        "of once per instance. Position is preserved via a per-instance translate op."
    )
    parser.add_argument("input_usdz")
    parser.add_argument("output_usdz")
    args = parser.parse_args()

    input_usdz = os.path.abspath(args.input_usdz)
    output_usdz = os.path.abspath(args.output_usdz)
    before_size = os.path.getsize(input_usdz)

    workdir = tempfile.mkdtemp(prefix="usdz-dedupe-")
    original_cwd = os.getcwd()
    try:
        with zipfile.ZipFile(input_usdz) as zf:
            usdc_name = zf.namelist()[0]
            zf.extractall(workdir)

        os.chdir(workdir)
        stage = Usd.Stage.Open(usdc_name)
        stats = dedupe(stage)
        # Export (full rewrite), not Save (incremental update): Save() only
        # patches the fields that changed and leaves prior value storage
        # alone, so two attributes that are now byte-identical still get
        # stored twice. Export forces USD's crate writer to rebuild the file
        # from scratch, which is what actually collapses duplicate arrays
        # down to one shared copy - confirmed experimentally, ~150x smaller
        # in a synthetic test where Save() gave no reduction at all.
        stage.GetRootLayer().Export(usdc_name)

        os.makedirs(os.path.dirname(output_usdz) or ".", exist_ok=True)
        ok = UsdUtils.CreateNewUsdzPackage(usdc_name, output_usdz)
        if not ok:
            raise RuntimeError("UsdUtils.CreateNewUsdzPackage failed")

        after_size = os.path.getsize(output_usdz)
        pct = 100 * (1 - after_size / before_size)
        print(f"Deduped {input_usdz} -> {output_usdz}")
        print(f"  groups shared: {stats['groups_used']}")
        print(f"  prims rejected (>1mm deviation from prototype): {stats['prims_rejected_epsilon']}")
        print(f"  points: {stats['total_points_before']} -> {stats['total_points_after']} "
              f"({100 * (1 - stats['total_points_after'] / stats['total_points_before']):.1f}% fewer stored)")
        print(f"  file size: {before_size / 1e6:.1f}MB -> {after_size / 1e6:.1f}MB ({pct:.0f}% smaller)")
    finally:
        os.chdir(original_cwd)
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
