import argparse
import os
import shutil
import tempfile
import zipfile

from pxr import Usd, UsdGeom, Gf, UsdUtils

# Recenters a .usdz's footprint on the local origin, the usdz counterpart to
# recenter-glb.mjs — see that script's header comment for why this matters
# (AR rotation gestures pivot around the file's raw local origin, not the
# model's visual center, on every platform/AR mode).
#
# USD stages default to Y-up, but these exports are Z-up (Blender's native
# convention) — UsdGeom.GetStageUpAxis() confirms this per-file rather than
# assuming, since getting the up-axis wrong here would recenter the wrong
# plane. The "up" axis is left untouched; the other two are recentered.


def main():
    parser = argparse.ArgumentParser(description="Recenter a .usdz model's footprint on the local origin.")
    parser.add_argument("input_usdz")
    parser.add_argument("output_usdz")
    args = parser.parse_args()

    input_usdz = os.path.abspath(args.input_usdz)
    output_usdz = os.path.abspath(args.output_usdz)

    workdir = tempfile.mkdtemp(prefix="usdz-recenter-")
    original_cwd = os.getcwd()
    try:
        with zipfile.ZipFile(input_usdz) as zf:
            usdc_name = zf.namelist()[0]
            zf.extractall(workdir)

        os.chdir(workdir)
        stage = Usd.Stage.Open(usdc_name)
        default_prim = stage.GetDefaultPrim()

        up_axis = UsdGeom.GetStageUpAxis(stage)
        axis_index = {"X": 0, "Y": 1, "Z": 2}[up_axis]

        bbox_cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_])
        bbox = bbox_cache.ComputeWorldBound(default_prim).ComputeAlignedBox()
        mn, mx = bbox.GetMin(), bbox.GetMax()
        center = [(mn[i] + mx[i]) / 2 for i in range(3)]
        longest_before = max(mx[i] - mn[i] for i in range(3))

        xform_api = UsdGeom.XformCommonAPI(default_prim)
        translate, _, _, _, _ = xform_api.GetXformVectors(Usd.TimeCode.Default())
        shift = [-center[i] if i != axis_index else 0.0 for i in range(3)]
        new_translate = Gf.Vec3d(
            translate[0] + shift[0],
            translate[1] + shift[1],
            translate[2] + shift[2],
        )
        xform_api.SetTranslate(new_translate)
        stage.GetRootLayer().Export(usdc_name)

        os.makedirs(os.path.dirname(output_usdz) or ".", exist_ok=True)
        ok = UsdUtils.CreateNewUsdzPackage(usdc_name, output_usdz)
        if not ok:
            raise RuntimeError("UsdUtils.CreateNewUsdzPackage failed")

        # Verify against the freshly-written package.
        check_stage = Usd.Stage.Open(output_usdz)
        check_prim = check_stage.GetDefaultPrim()
        check_bbox = bbox_cache.ComputeWorldBound(check_prim).ComputeAlignedBox()
        cmn, cmx = check_bbox.GetMin(), check_bbox.GetMax()
        after_center = [(cmn[i] + cmx[i]) / 2 for i in range(3)]
        longest_after = max(cmx[i] - cmn[i] for i in range(3))

        print(f"{input_usdz} -> {output_usdz}")
        print(f"  up axis: {up_axis}")
        print(f"  longest side: {longest_before:.3f}m -> {longest_after:.3f}m")
        print(f"  footprint center was {[round(c, 3) for c in center]} -> now {[round(c, 4) for c in after_center]}")
    finally:
        os.chdir(original_cwd)
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
