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

**This script also resizes/re-encodes textures (2048x2048 max, WebP).**
SketchUp/Blender exports have shown up with textures as large as 11811x11811
px — geometry (Draco-compressed) is not the size problem for these models,
textures are. One stage-00 re-export was 22.8MB before this step, 2.2MB after,
with no visible quality loss at AR viewing distance on a ~1.8m model. If a
model looks unusually slow to load, check texture dimensions with the inline
inspection snippet in `inspect-glb.mjs`'s style before assuming it's a network
issue.

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

## Chat script (`chat-script.docx`)

The chat script lives in `../chat-script.docx` — a Word document editors (no
JSON knowledge needed) use to write dialogue. Requires Python with
`python-docx`: `pip install python-docx`.

```
python chat_docx.py export   # regenerate chat-script.docx from messages.json
python chat_docx.py sync     # regenerate messages.json from chat-script.docx
```

Only plain dialogue (dates, system notes, messages, image/stage changes) is
editable in the doc — see the instructions at the top of the document itself.
Polls, file shares, and the visitor reply-prompt show up as non-editable
`[LOCKED: ...]` lines; edit those directly in `messages.json` instead.
`export` always regenerates from the current `messages.json`, so run it again
after any direct JSON edits to keep the Word doc in sync.
