# Model scale-correction tools

SketchUp/Blender exports for this project come in ~20x oversized. Run each raw
export through the matching script before dropping it into `demo/models/stage-NN/`.

The model is sized to fit a 2m x 2m room (longest side ~1.8m, with a small
margin for AR tracking drift), which works out to an absolute factor of
`0.0114` (divide by ~88) from the raw export.

## `.glb` (Android)

One-time setup: `npm install` in this folder (installs `@gltf-transform/core`).

```
node fix-glb-scale.mjs <raw.glb> ../models/stage-NN/model.glb 0.0114
```

Optional third argument overrides the default factor of `0.05` (i.e. divide by 20) —
pass `0.0114` to match the current room-scale sizing used for stages 00-05.

## `.usdz` (iOS)

Requires Python with the `usd-core` package: `pip install usd-core`.

```
python fix-usdz-scale.py <raw.usdz> ../models/stage-NN/model.usdz --factor 0.0114
```

Add `--factor 0.0114` explicitly to match the current room-scale sizing (default is `0.05`).
