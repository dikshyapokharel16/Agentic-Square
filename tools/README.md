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
pass `0.0114` to match the current room-scale sizing used for stages 00-05.

## `.usdz` (iOS)

Requires Python with the `usd-core` package: `pip install usd-core`.

```
python fix-usdz-scale.py <raw.usdz> ../models/stage-NN/model.usdz --factor 0.04556
```

`--factor` here is an **absolute** scale on the raw export (not a multiplier
on the current file, unlike the `.glb` script) — `0.04556` is what currently
gets stages 00-05 to the same ~1.8m longest side as their `.glb` counterparts,
but if a new raw `.usdz` export starts from a different native scale, this
number won't automatically be right. Always confirm with:

```
python inspect-usdz.py ../models/stage-NN/model.usdz
```

which prints both the baked-in scale op and the actual world-space size in
meters — check the size is ~1.8m on the longest side, don't just trust the
factor number.

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
