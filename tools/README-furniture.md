# Furniture AR models

A separate set of AR-only models (no inline display model, unlike `stages.json`'s
stages) for six furniture pieces, viewable in AR at **true 1:1 real-world scale**
instead of the "fit a 2m x 2m room" sizing used for the square stages.

## Folders

```
ARmodels/furniture/furniture-01/model.glb   model.usdz
ARmodels/furniture/furniture-02/model.glb   model.usdz
...
ARmodels/furniture/furniture-06/model.glb   model.usdz
```

Placeholder names (`furniture-01`..`furniture-06`) — rename the folders (and
update `furniture.json` at the repo root) once the actual pieces are known.
`furniture.json` mirrors `stages.json`'s shape (`id`/`name`/`arGlb`/`arUsdz`)
but is its own file so it doesn't collide with `stages.json`.

## The key difference from the stage pipeline

Stages all target the same fixed size (~1.8m longest side, to fit a 2m x 2m AR
tracking area) — see `tools/README.md`. Furniture has no such shared target:
**each piece needs its own real-world measurement** (height/width/depth in
meters, from a spec sheet or a tape measure against the actual object) before
you can pick a scale factor, since there's nothing else to check the exported
model's scale against.

Workflow per item, same underlying scripts as the stage pipeline:

```
node fix-glb-scale.mjs <raw.glb> ../ARmodels/furniture/furniture-NN/model.glb <factor>
python fix-usdz-scale.py <raw.usdz> ../ARmodels/furniture/furniture-NN/model.usdz --factor <factor>
python dedupe-usdz-mesh.py ../ARmodels/furniture/furniture-NN/model.usdz ../ARmodels/furniture/furniture-NN/model.usdz   # only if the piece has repeated geometry (legs, slats, etc.)
```

1. Export raw `.glb` (Android) and `.usdz` (iOS) from SketchUp/Blender as usual
   (SketchUp exports still come in ~20x oversized, per `tools/README.md`).
2. Before guessing a factor, get the item's **real-world size** — e.g. "this
   chair is 0.82m tall."
3. Run `node inspect-glb.mjs <raw.glb>` / `python inspect-usdz.py <raw.usdz>`
   on the *unscaled* raw export to see its current (wrong) size, then compute
   a starting factor as `target_meters / current_wrong_meters`. Treat this as
   a first guess, not the final answer — same as the stage pipeline, `.glb`
   and `.usdz` need independently-verified factor values, they are not
   interchangeable (see `tools/README.md`'s scale section for why).
4. Re-run the inspect script on the *output* file and confirm it matches the
   real-world measurement (not the stages' 1.8m target — there is no shared
   target here, only whatever that specific piece actually measures).
5. Texture resizing/compression and Draco/meshopt (`.glb`) happen
   automatically as part of `fix-glb-scale.mjs` / `fix-usdz-scale.py`, same as
   stages. Only run `dedupe-usdz-mesh.py` if the piece has genuinely repeated
   sub-geometry (e.g. identical chair legs, slats) — small single-piece
   furniture may not need it at all.

## Not yet built

The landing/gallery page (a background image with six AR-icon buttons, one
per piece, launching straight into AR at 1:1 scale) doesn't exist yet — this
is scaffolding only. Also still open: how the kiosk returns to the intro
screen after this page (planned: a manual "done" button plus an inactivity
timeout as fallback, so it doesn't strand a visitor there indefinitely).
