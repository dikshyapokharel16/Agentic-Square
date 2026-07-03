import argparse
import glob
import os
import shutil
import tempfile
import zipfile

from PIL import Image
from pxr import Usd, UsdGeom, Gf, UsdUtils, Sdf

MAX_TEXTURE_SIZE = (2048, 2048)

# SketchUp exports for this project are legitimately huge (up to ~140MP source
# textures), not a decompression-bomb attack — raise Pillow's default safety
# limit rather than let every run print a warning.
Image.MAX_IMAGE_PIXELS = 200_000_000


def resize_textures(workdir):
    # SketchUp/Blender exports have shown up with textures as large as
    # 11811x11811px — geometry is not the size problem for these models,
    # textures are. PNG (lossless) barely shrinks this kind of photographic
    # texture even at lower resolution, so opaque (no-alpha) images are
    # converted to JPEG, which compresses far better for this content.
    # Returns {old relative asset path -> new relative asset path} for any
    # file that got renamed, so USD material references can be updated.
    renames = {}
    for path in glob.glob(os.path.join(workdir, "**", "textures", "*.*"), recursive=True):
        ext = os.path.splitext(path)[1].lower()
        if ext not in (".png", ".jpg", ".jpeg"):
            continue  # leave .exr and anything else untouched
        with Image.open(path) as img:
            oversized = img.width > MAX_TEXTURE_SIZE[0] or img.height > MAX_TEXTURE_SIZE[1]
            has_alpha = "A" in img.mode and img.getchannel("A").getextrema() != (255, 255)
            if not oversized and ext != ".png":
                continue
            before = os.path.getsize(path)
            if oversized:
                img.thumbnail(MAX_TEXTURE_SIZE, Image.LANCZOS)
            if ext == ".png" and not has_alpha:
                new_path = os.path.splitext(path)[0] + ".jpg"
                img.convert("RGB").save(new_path, quality=85, optimize=True)
                os.remove(path)
                rel_old = os.path.relpath(path, workdir).replace(os.sep, "/")
                rel_new = os.path.relpath(new_path, workdir).replace(os.sep, "/")
                renames[rel_old] = rel_new
                after = os.path.getsize(new_path)
                print(f"  {os.path.basename(path)} -> {os.path.basename(new_path)}: "
                      f"{img.width}x{img.height}, {before // 1024}KB -> {after // 1024}KB")
            else:
                img.save(path, optimize=True)
                after = os.path.getsize(path)
                print(f"  resized {os.path.basename(path)}: {img.width}x{img.height}, {before // 1024}KB -> {after // 1024}KB")
    return renames


def _strip_dot_slash(path):
    return path[2:] if path.startswith("./") else path


def apply_renames(stage, renames):
    if not renames:
        return
    # USD stores asset paths with a "./" prefix (e.g. "./textures/foo.png"),
    # but our rename keys are plain relative paths — normalize both sides.
    normalized = {_strip_dot_slash(k): v for k, v in renames.items()}
    for prim in stage.Traverse():
        for attr in prim.GetAttributes():
            if attr.GetTypeName() != Sdf.ValueTypeNames.Asset:
                continue
            val = attr.Get()
            if not val:
                continue
            key = _strip_dot_slash(val.path)
            if key in normalized:
                prefix = "./" if val.path.startswith("./") else ""
                attr.Set(Sdf.AssetPath(prefix + normalized[key]))


def main():
    parser = argparse.ArgumentParser(description="Scale a .usdz model's root prim and repackage it.")
    parser.add_argument("input_usdz")
    parser.add_argument("output_usdz")
    parser.add_argument("--factor", type=float, default=0.05)
    args = parser.parse_args()

    input_usdz = os.path.abspath(args.input_usdz)
    output_usdz = os.path.abspath(args.output_usdz)

    before_size = os.path.getsize(input_usdz)

    workdir = tempfile.mkdtemp(prefix="usdz-scale-")
    original_cwd = os.getcwd()
    try:
        with zipfile.ZipFile(input_usdz) as zf:
            usdc_name = zf.namelist()[0]
            zf.extractall(workdir)

        renames = resize_textures(workdir)

        os.chdir(workdir)

        stage = Usd.Stage.Open(usdc_name)
        default_prim = stage.GetDefaultPrim()
        # XformCommonAPI safely sets scale whether or not a scale op already
        # exists on this prim (AddScaleOp() would throw on a re-run/already-scaled file).
        xform_api = UsdGeom.XformCommonAPI(default_prim)
        xform_api.SetScale(Gf.Vec3f(args.factor, args.factor, args.factor))
        apply_renames(stage, renames)
        stage.GetRootLayer().Save()

        os.makedirs(os.path.dirname(output_usdz) or ".", exist_ok=True)
        ok = UsdUtils.CreateNewUsdzPackage(usdc_name, output_usdz)
        if not ok:
            raise RuntimeError("UsdUtils.CreateNewUsdzPackage failed")
        after_size = os.path.getsize(output_usdz)
        pct = 100 * (1 - after_size / before_size)
        print(f"Scaled {input_usdz} by {args.factor} -> {output_usdz}")
        print(f"Textures resized: {before_size // 1024}KB -> {after_size // 1024}KB ({pct:.0f}% smaller)")
    finally:
        os.chdir(original_cwd)
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
