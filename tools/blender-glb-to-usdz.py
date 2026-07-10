# Regenerate an iOS AR .usdz from an (already optimized) AR .glb, using
# Blender headless. Exists because the .usdz pipeline had no way to reduce
# geometry (see tools/README.md "Known limitation") — the stage .usdz files
# measured 2026-07-10 still carried 4,452-7,627 mesh prims (one draw call
# each in RealityKit) and 1.2-1.3M points, which is what made Quick Look lag
# on-device even though the *files* were only 5-7MB (USD's crate dedup hides
# repeated geometry on disk but Quick Look still renders every copy).
#
# Sourcing from the optimized AR .glb (tools/optimize-glb.mjs output) starts
# us at single-digit prims, 1024px textures, and correct ~1.8m scale +
# recentering; this script welds seams (SketchUp exports are unwelded, which
# is also why meshopt simplify plateaued at ~50%), decimates what welding
# unlocks, converts every texture to JPEG (RealityKit/Quick Look does not
# support the WebP the .glb pipeline uses — and fix-usdz-scale.py only
# converts PNG, it *skips* WebP), and exports a packed .usdz.
#
# Usage:
#   blender -b -P blender-glb-to-usdz.py -- <in.glb> <out.usdz> [decimate_ratio=0.4] [weld_dist=0.0005]
#
# Verify afterwards with inspect-usdz.py (expect ~1.8m longest side, upAxis
# handled via stage metadata) and a real device — file must stay well under
# ~8MB for venue wifi.
import bpy
import sys
import os
import tempfile

argv = sys.argv[sys.argv.index("--") + 1:]
in_glb = os.path.abspath(argv[0])
out_usdz = os.path.abspath(argv[1])
ratio = float(argv[2]) if len(argv) > 2 else 0.4
weld_dist = float(argv[3]) if len(argv) > 3 else 0.0005

# Fresh scene (factory startup file may contain a default cube etc.)
bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.import_scene.gltf(filepath=in_glb)

import bmesh

total_before = 0
total_after = 0
for obj in list(bpy.data.objects):
    if obj.type != "MESH":
        continue
    me = obj.data
    total_before += len(me.vertices)

    # Weld: merge vertices closer than weld_dist. The glb pipeline's exact-
    # match weld couldn't cross SketchUp's hard-edge seams (per-face normals
    # differ); a distance weld here merges them, unlocking real decimation.
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld_dist)
    bm.to_mesh(me)
    bm.free()
    me.update()

    # Decimate (collapse) what welding just made collapsible.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new(name="dec", type="DECIMATE")
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)

    total_after += len(obj.data.vertices)

# RealityKit/Quick Look cannot read WebP — re-encode every image as JPEG in
# a temp dir and re-point the datablocks there so the USD exporter writes
# JPEG references into the package.
texdir = tempfile.mkdtemp(prefix="usdz-tex-")
for img in bpy.data.images:
    if not img.has_data:
        continue
    name = bpy.path.clean_name(os.path.splitext(img.name)[0]) or "image"
    img.filepath_raw = os.path.join(texdir, name + ".jpg")
    img.file_format = "JPEG"
    img.save()

bpy.ops.wm.usd_export(filepath=out_usdz)

print(f"[blender-glb-to-usdz] {in_glb} -> {out_usdz}")
print(f"[blender-glb-to-usdz] verts: {total_before:,} -> {total_after:,} (weld {weld_dist} + decimate {ratio})")
print(f"[blender-glb-to-usdz] size: {os.path.getsize(out_usdz)/1048576:.2f}MB")
