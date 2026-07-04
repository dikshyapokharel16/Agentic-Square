# Model scale-correction tools

SketchUp/Blender exports for this project come in ~20x oversized. Run each raw
export through the matching script before dropping it into `demo/models/stage-NN/`.

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
node fix-glb-scale.mjs <raw.glb> ../models/stage-NN/model.glb 0.0114
```

Optional third argument overrides the default factor of `0.05` (i.e. divide by 20) —
pass `0.0114` to match the current room-scale sizing used for stages 00-03.
Verify with `node inspect-glb.mjs ../models/stage-NN/model.glb` (prints material
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
python fix-usdz-scale.py <raw.usdz> ../models/stage-NN/model.usdz --factor 0.04556
```

`--factor` here is an **absolute** scale on the raw export (not a multiplier
on the current file, unlike the `.glb` script) — `0.04556` is what currently
gets stages 00-03 to the same ~1.8m longest side as their `.glb` counterparts,
but if a new raw `.usdz` export starts from a different native scale, this
number won't automatically be right. Always confirm with:

```
python inspect-usdz.py ../models/stage-NN/model.usdz
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

**Known limitation: geometry is not compressed or simplified for `.usdz`.**
Unlike `.glb` (Draco + meshoptimizer), there's no mesh-compression tool in
this pipeline for USD — file size scales directly with polygon count. Heavy
raw exports (stage-01..03: 73MB+ of raw mesh alone) stay heavy after this
script since only textures/scale get fixed, not geometry. If a model needs
to be smaller and `dedupe-usdz-mesh.py` below doesn't apply (no repeated
objects), decimate it in Blender (Decimate modifier, ~0.3-0.5 ratio) *before*
exporting to `.usdz` — reducing polygon count at the source is the only
remaining fix.

## `.usdz` mesh deduplication (repeated objects)

SketchUp/Blender exports for this project don't preserve component/instance
reuse — every copy of a repeated object (a pallet, a brick in a wall) is
exported as its own fully-baked, independent copy of the geometry, at up to
20-30x the vertex count actually needed. `fix-usdz-scale.py` doesn't touch
this (see limitation above), but it's fixable separately:

```
python dedupe-usdz-mesh.py ../models/stage-NN/model.usdz ../models/stage-NN/model.usdz
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
   normal scale/compress step: `node fix-glb-scale.mjs <raw.glb> ../models/stage-NN/model.glb 0.0114`.
   This only touches node scale and Draco-compresses geometry — it doesn't
   touch materials/textures, so the occlusion texture passes through untouched.

After processing, confirm the texture actually made it through:

```
node inspect-glb.mjs ../models/stage-NN/model.glb
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
