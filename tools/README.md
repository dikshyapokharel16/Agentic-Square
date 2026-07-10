# Model scale-correction tools

SketchUp/Blender exports for this project come in ~20x oversized. Run each raw
export through the matching script before dropping it into `websitemodels/stage-NN/`.

Each stage also has a separate, simpler model used only for AR (the inline
view next to the chat and the AR placement are decoupled — see `stages.json`'s
`glb`/`poster` vs. `arGlb`/`arUsdz` fields, and `main.js`'s AR button handler).
These scripts work the same way for that pair, just pointed at
`../ARmodels/stage-NN/model.glb` / `.usdz` as the output path instead.

The model is sized to fit a 2m x 2m room (longest side ~1.8m, with a small
margin for AR tracking drift).

**Important: `.glb` and `.usdz` need different factor values.** They're
independent exports (the `.usdz` pipeline had its own prior scale-correction
of `0.2` baked in, vs `0.05` for `.glb`), so the same raw model produces a
different absolute factor per format. Always verify the *actual* resulting
size with the inspect scripts below rather than assuming a factor carries
over between formats — this exact mismatch previously caused the `.usdz`
files to never get the room-scale fix that `.glb` got, breaking AR on iOS
while Android looked fine.

## `.glb` (Android)

One-time setup: `npm install` in this folder (installs `@gltf-transform/core`).

```
node fix-glb-scale.mjs <raw.glb> ../websitemodels/stage-NN/model.glb 0.0114
```

Optional third argument overrides the default factor of `0.05` (i.e. divide by 20) —
pass `0.0114` to match the current room-scale sizing used for stages 00-03.
Verify with `node inspect-glb.mjs ../websitemodels/stage-NN/model.glb` (prints material
info, not size) or check bounds by eye in a viewer — target is ~1.8m longest side.

**This script also resizes/re-encodes textures (2048x2048 max, WebP)** and
**simplifies geometry (meshoptimizer, ratio 0.5)** before Draco-compressing.
SketchUp/Blender exports have shown up with textures as large as 11811x11811
px, and separately with far more polygons than a small AR model needs —
stage-01..03 raw exports ran 85-90MB *before* any of this. Texture resize is
usually the bigger win (one stage-00 re-export: 22.8MB before, 2.2MB after);
simplify is a smaller but real cut on top (~8% further, plus fewer triangles
for smoother real-time rendering). If a model looks unusually slow to load,
check texture dimensions and vertex count with `inspect-glb.mjs` before
assuming it's a network issue.

## `.usdz` (iOS)

Requires Python with the `usd-core` and `Pillow` packages:
`pip install usd-core Pillow`.

```
python fix-usdz-scale.py <raw.usdz> ../websitemodels/stage-NN/model.usdz --factor 0.04556
```

`--factor` here is an **absolute** scale on the raw export (not a multiplier
on the current file, unlike the `.glb` script) — `0.04556` is what currently
gets stages 00-03 to the same ~1.8m longest side as their `.glb` counterparts,
but if a new raw `.usdz` export starts from a different native scale, this
number won't automatically be right. Always confirm with:

```
python inspect-usdz.py ../websitemodels/stage-NN/model.usdz
```

which prints both the baked-in scale op and the actual world-space size in
meters — check the size is ~1.8m on the longest side, don't just trust the
factor number.

**This script also resizes/re-encodes textures** the same way the `.glb`
script does — 2048x2048 max, and any opaque (no-alpha) PNG gets converted to
JPEG (USDZ/RealityKit doesn't support WebP, unlike `<model-viewer>`/three.js).
One stage-00 re-export went from 22.7MB of textures to 3.4MB with no visible
quality loss. Converting format means the USD material's texture references
get rewired automatically to the new filename — this happens in-script, you
don't need to do anything extra.

**Known limitation: geometry is not compressed or simplified for `.usdz`**
by this script — but `blender-glb-to-usdz.py` (below) now covers that:
rather than fixing a heavy raw `.usdz` export, regenerate the `.usdz` from
the already-optimized `.glb`. Use that route whenever a `.usdz` feels heavy
or laggy in Quick Look; this script remains the right tool only for scaling
a fresh raw export that's otherwise light.

## Recentering (AR rotation pivot)

SketchUp/Blender exports keep whatever origin the source scene happened to
use — often far from the model's own visual center. `<model-viewer>`'s
inline turntable camera auto-centers around the bounding box regardless, so
this never shows up in the split-screen display panel — but native AR
handoff (Android Scene Viewer, iOS Quick Look) and even model-viewer's own
in-page WebXR AR rotate the placed model around the file's *raw local
origin*, not its visual center. An off-center origin makes AR rotation
gestures orbit a point that can be well outside the model.

`fix-glb-scale.mjs` and `fix-usdz-scale.py` both recenter the footprint
(X/Z for `.glb`'s Y-up convention, X/Y for `.usdz`'s — these SketchUp/Blender
exports are Z-up, read per-file via `UsdGeom.GetStageUpAxis()` rather than
assumed) as part of the normal pipeline now, so this is handled automatically
for new exports. Height is deliberately left untouched — these exports
already sit on the ground plane at zero.

To fix already-processed files without redoing the whole pipeline (no raw
export needed — this is a pure transform edit, doesn't touch mesh/texture
data):

```
node recenter-glb.mjs <in.glb> <out.glb> [--target-longest-side=1.8]
python recenter-usdz.py <in.usdz> <out.usdz>
```

`recenter-glb.mjs` explicitly re-applies whatever Draco method (sequential
vs. edgebreaker) the input file already used — gltf-transform's own
read/write round-trip doesn't preserve that choice and silently defaults to
edgebreaker on write, which would silently undo a deliberate per-stage
encoding choice (e.g. a stage switched to sequential to work around an
Android decoder bug) if left unhandled.

## `.glb` GPU-footprint optimization (`optimize-glb.mjs`)

Run this on every processed `.glb` (website display models, AR stage models,
furniture models) after `fix-glb-scale.mjs`. It exists because file size and
GPU cost are almost unrelated for these models, and iOS Safari fails on GPU
cost: a 2048x2048 WebP that's 0.1MB on disk is ~21MB decompressed on the GPU
(raw RGBA + mipmaps), and when iPad Safari can't allocate a texture it fails
*silently per-texture*, rendering just those surfaces black while geometry
survives. Measured 2026-07-10: stages 01-03 shipped ~1.5M vertices,
4,600-7,800 primitives (one draw call each) and 109-136MB of GPU texture
memory per model, which is what was blacking out textures on iOS and making
the Quick-Look-and-back reinit fail on every stage except the small stage-00.

```
node optimize-glb.mjs <in.glb> <out.glb> [--ratio=0.1] [--error=0.01] [--max-texture=1024]
```

Pipeline: dedup -> palette (folds flat-color materials into one shared
palette texture so join can merge across them; alphaMode differences keep
translucent glass separate) -> flatten + join (thousands of per-object
primitives down to a handful of per-material draws) -> weld -> simplify
(meshoptimizer) -> prune -> textures capped at 1024px -> Draco. Scale and
recentering are untouched, so it's safe on already-shipped files.

Two calibration notes from the 2026-07-10 run:

- **Vertex reduction bottoms out around 50%, not the requested ratio.** The
  SketchUp exports' hard-edge normals block welding across seams (weld only
  merges byte-identical vertices in gltf-transform v4), so simplify is
  topology-locked — raising `--error` from 0.01 to 0.03 gained ~100 vertices
  out of 780k. Don't chase a lower ratio here; if a model genuinely needs
  fewer polygons, decimate in Blender before export, same as the `.usdz`
  advice below.
- **The draw-call and texture wins are the ones that matter anyway**: 4,987
  prims -> 10 and ~109MB -> ~29MB GPU textures on stage-01, with file size
  8.68MB -> 1.55MB as a side effect.

Verify with `inspect-glb-textures.mjs` (below); target profile is roughly
stage-00's (~25k verts, single-digit prims after optimization, <40MB GPU
textures) — the profile that has held up on real iOS hardware.

## `.glb` texture/GPU inspection (`inspect-glb-textures.mjs`)

`inspect-glb.mjs` prints materials only; this one prints what iOS actually
chokes on — per-texture pixel dimensions and estimated decompressed GPU
memory, plus total vertex and primitive counts:

```
node inspect-glb-textures.mjs <model.glb> [more.glb ...]
```

Use it before assuming a model is "small" because its file size is small —
Draco and WebP hide an order of magnitude between disk and GPU.

## `.usdz` regeneration from optimized `.glb` (`blender-glb-to-usdz.py`)

The Quick Look lag fix. Measured 2026-07-10, the stage `.usdz` files carried
4,452-7,627 mesh prims (one RealityKit draw call each) and 1.2-1.3M points —
the crate-level dedup below hides repeated geometry *on disk*, but Quick
Look still expands and renders every copy, so the files looked small (5-7MB)
while lagging hard on-device. Since the `.glb` side already gets fully
optimized (`optimize-glb.mjs`: single-digit prims, 1024px textures, correct
scale and recentering), the fix is to regenerate the `.usdz` *from that
optimized `.glb`* instead of trying to repair the raw `.usdz` export:

```
blender -b -P blender-glb-to-usdz.py -- <in.glb> <out.usdz> [decimate_ratio=0.4] [weld_dist=0.0005]
python fix-usdz-scale.py <out.usdz> <out.usdz> --factor 1.0
```

(Blender is not on PATH on this machine — it lives at
`D:\Softwares\Blender Software Installation file\blender.exe`.)

Step 1 (Blender headless) welds seams with a *distance* weld — this is the
step the `.glb` pipeline can't do (gltf-transform v4's weld is exact-match
only, and SketchUp's hard-edge seams block it), and it's why decimation
works here after plateauing at ~50% in `optimize-glb.mjs`. **Calibration
warning (2026-07-10):** the default ratio 0.4 visibly mangled close-up
detail — the stage runs (787k -> 40-55k verts) were rejected on visual
quality (their iOS AR is disabled instead; see CLAUDE.md), and the Stepped
Playground only passed review at a gentle `0.9 0.0002`, which still cut its
file 14.9MB -> 3.8MB because welding does most of the work. Start gentle
and render-check (a headless Blender render of the .usdz works; see git
log for the scratchpad script) before trusting any ratio. Step 2
exists because Blender exports the `.glb`'s WebP textures as-is and
**RealityKit/Quick Look cannot read WebP** (the material silently breaks) —
`fix-usdz-scale.py` converts them (opaque -> JPEG, alpha -> PNG) and rewires
the USD material references; `--factor 1.0` leaves the already-correct
scale alone while its recentering pass runs as a harmless no-op.

Always verify with `inspect-usdz.py` afterwards: expect the same world-space
size as the source `.glb` (~1.8m longest side for stages, true 1:1 for
furniture) — the up-axis differs from hand-exported files (Z instead of Y)
but is carried in stage metadata, which Quick Look respects.

## `.usdz` mesh deduplication (repeated objects)

SketchUp/Blender exports for this project don't preserve component/instance
reuse — every copy of a repeated object (a pallet, a brick in a wall) is
exported as its own fully-baked, independent copy of the geometry, at up to
20-30x the vertex count actually needed. `fix-usdz-scale.py` doesn't touch
this (see limitation above), but it's fixable separately:

```
python dedupe-usdz-mesh.py ../websitemodels/stage-NN/model.usdz ../websitemodels/stage-NN/model.usdz
```

USD's crate (`.usdc`) format automatically stores only one copy of any array
value that's byte-identical to one already in the file — but "the same
object placed somewhere else" isn't byte-identical, because the raw export
bakes each instance's world position directly into its `points` array (no
shared local-space mesh + transform). This script finds mesh prims that are
the same shape (points, translation-normalized to a common origin, plus
matching face topology and normals, within a small tolerance) and rewrites
each instance to share one prototype's `points`/`normals`/`primvars:st`
arrays, moved into place with a `xformOp:translate` instead of baked-in
coordinates. That makes the arrays byte-identical across instances, which is
what lets USD's own dedup collapse them — this script does not do the
byte-level compaction itself, it just makes the existing mechanism able to
see the duplication.

**Important: use `Export()`, not `Save()`, to write the result.** `Save()`
only patches the fields that changed and leaves prior value storage alone —
even if two attributes are now byte-identical, they stay stored twice.
`Export()` forces a full rewrite of the crate file, which is what actually
performs the dedup. (Confirmed experimentally: editing an existing layer in
place and calling `Save()` gave 0% size reduction on a synthetic test where
`Export()` gave ~150x.) This script uses `Export()` internally — if you're
scripting further edits on top of it, keep that in mind.

On stage-02 (the first model this was needed for): 4464 mesh prims, of which
~1400 across 123 groups turned out to be exact-shape duplicates (mostly
wooden pallets and repeated brick coursing) — 78MB raw mesh down to ~25MB,
no visible difference. A handful of near-matches (e.g. mirrored instances,
where normals come out ~180° off instead of matching to noise-level
tolerance) are detected and left untouched rather than merged. The script
prints how many groups were shared and how many prims were rejected as
not-actually-duplicates; verify with `inspect-usdz.py` afterwards (scale/size
should be unchanged) same as any other edit in this pipeline.

## Ambient occlusion

There are currently 4 stages (`stage-00`…`stage-03`). Each will eventually be
replaced by a new Blender export with baked ambient occlusion. `<model-viewer>`
(three.js under the hood) already respects glTF's `occlusionTexture` material
slot natively — no site code changes needed, only new textures in the `.glb`.

Per model, in Blender:

1. Make sure the model has UVs (unwrap if the raw export doesn't have them).
2. Switch to Cycles, create a new bake-target image texture, select it as the
   active node, and bake **Ambient Occlusion** (start around 128–256 samples,
   raise if noisy).
3. Wire the baked image into Blender's **glTF Material Output** node group
   (from the glTF I/O add-on) → `Occlusion` input. This is what makes the
   exporter write `material.occlusionTexture` on export — without this node,
   the bake exists as an image but never reaches the glTF file.
4. Export the raw (still oversized) `.glb` as usual, then run it through the
   normal scale/compress step: `node fix-glb-scale.mjs <raw.glb> ../websitemodels/stage-NN/model.glb 0.0114`.
   This only touches node scale and Draco-compresses geometry — it doesn't
   touch materials/textures, so the occlusion texture passes through untouched.

After processing, confirm the texture actually made it through:

```
node inspect-glb.mjs ../websitemodels/stage-NN/model.glb
```

Look for `occlusionTexture: true` on the relevant material(s).

## Previewing on a phone/tablet

WebXR/camera access requires HTTPS (or `localhost`) — a plain `http://<lan-ip>`
origin won't work for AR on most devices, even on the same Wi-Fi.

- **Fast iteration loop:** serve the folder locally and tunnel it over HTTPS:
  ```
  npx serve .                                   # from the repo root
  cloudflared tunnel --url http://localhost:3000  # no account needed
  ```
  Open the printed `https://*.trycloudflare.com` URL on the device.
- **Confirm on the real pipeline:** push the branch — this repo is linked to
  Vercel, so every push gets a normal HTTPS preview deployment URL to check
  before merging.
