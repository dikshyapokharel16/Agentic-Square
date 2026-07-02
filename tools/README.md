# Model scale-correction tools

SketchUp/Blender exports for this project come in ~20x oversized. Run each raw
export through the matching script before dropping it into `demo/models/stage-NN/`.

## `.glb` (Android)

One-time setup: `npm install` in this folder (installs `@gltf-transform/core`).

```
node fix-glb-scale.mjs <raw.glb> ../models/stage-NN/model.glb
```

Optional third argument overrides the default factor of `0.05` (i.e. divide by 20).

## `.usdz` (iOS)

Requires Python with the `usd-core` package: `pip install usd-core`.

```
python fix-usdz-scale.py <raw.usdz> ../models/stage-NN/model.usdz
```

Add `--factor 0.05` explicitly if you want to override the default.
