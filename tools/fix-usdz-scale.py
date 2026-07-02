import argparse
import os
import shutil
import tempfile
import zipfile

from pxr import Usd, UsdGeom, Gf, UsdUtils


def main():
    parser = argparse.ArgumentParser(description="Scale a .usdz model's root prim and repackage it.")
    parser.add_argument("input_usdz")
    parser.add_argument("output_usdz")
    parser.add_argument("--factor", type=float, default=0.05)
    args = parser.parse_args()

    input_usdz = os.path.abspath(args.input_usdz)
    output_usdz = os.path.abspath(args.output_usdz)

    workdir = tempfile.mkdtemp(prefix="usdz-scale-")
    original_cwd = os.getcwd()
    try:
        with zipfile.ZipFile(input_usdz) as zf:
            usdc_name = zf.namelist()[0]
            zf.extractall(workdir)

        os.chdir(workdir)

        stage = Usd.Stage.Open(usdc_name)
        default_prim = stage.GetDefaultPrim()
        # XformCommonAPI safely sets scale whether or not a scale op already
        # exists on this prim (AddScaleOp() would throw on a re-run/already-scaled file).
        xform_api = UsdGeom.XformCommonAPI(default_prim)
        xform_api.SetScale(Gf.Vec3f(args.factor, args.factor, args.factor))
        stage.GetRootLayer().Save()

        os.makedirs(os.path.dirname(output_usdz) or ".", exist_ok=True)
        ok = UsdUtils.CreateNewUsdzPackage(usdc_name, output_usdz)
        if not ok:
            raise RuntimeError("UsdUtils.CreateNewUsdzPackage failed")
        print(f"Scaled {input_usdz} by {args.factor} -> {output_usdz}")
    finally:
        os.chdir(original_cwd)
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
