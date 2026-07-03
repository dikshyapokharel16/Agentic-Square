# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, no-build kiosk web app ("Agentic Square") for a touchscreen device: a split-screen experience showing an AR/3D model of a public square's redesign (left) next to an auto-playing WhatsApp-style chat that narrates the design process (right, phone mockup). A visitor scans a QR code, types their name, and watches the chat play out — `{{name}}` tokens in the script get personalized live. Each `type:"image"` message in the chat advances the 3D model shown in the AR panel to the next stage.

Content: `messages.json` (chat script) — deployed at Vercel, repo `dikshyapokharel16/Agentic-Square`.

## Commands

No build step — `index.html`, `main.js`, `styles.css` are loaded directly as static files. There is no root `package.json`, no bundler, no test suite.

**Local dev:** serve the repo root over HTTP (relative `fetch("stages.json")` / `fetch("messages.json")` calls fail under `file://`), e.g. `npx serve .`, then open `index.html`.

**Deploy:** push to `main` — Vercel auto-deploys from GitHub (see commit `096336f`). `vercel.json` only sets `Content-Type`/`Cache-Control` headers for `models/*.glb`/`*.usdz`/`*.webp`.

### Chat script editing (`tools/chat_docx.py`)

The chat script (`messages.json`) is also maintained as a Word doc (`chat-script.docx`) so non-technical editors can reword dialogue without touching JSON. Requires `pip install python-docx`.

```
python tools/chat_docx.py export   # messages.json -> chat-script.docx
python tools/chat_docx.py sync     # chat-script.docx -> messages.json
```

- Only `date`/`system`/`event`/`msg`/`image` entries round-trip through Word. `poll`, `file`, and `userPrompt` entries have no Word representation — they appear as a `[LOCKED: ...]` marker line matched back up by position within their type when syncing; editing them must happen directly in `messages.json`.
- `sync` matches `msg`/`image` `reactions` back onto entries by exact `(type, sender, text)` key — rewording a line drops its reactions.
- `export` always regenerates from the current `messages.json` — rerun it after any direct JSON edit to keep the doc in sync.

### 3D model scaling (`tools/`)

SketchUp/Blender exports come in ~20x oversized. Run raw exports through these before dropping into `models/stage-NN/`:

```
node fix-glb-scale.mjs <raw.glb> ../models/stage-NN/model.glb 0.0114   # Android
python fix-usdz-scale.py <raw.usdz> ../models/stage-NN/model.usdz --factor 0.0114   # iOS
```

`0.0114` is the current room-scale factor (fits a 2m×2m AR tracking area, longest side ~1.8m) — used for stages 00–05. One-time setup: `npm install` in `tools/` (needs `@gltf-transform/core`); Python side needs `pip install usd-core`.

`fix-glb-scale.mjs` also Draco-compresses geometry on the way out — expect a size reduction printed to the console.

**Cache-busting for models:** `.glb`/`.usdz`/`.webp` are served with `Cache-Control: max-age=3600` (`vercel.json`) and their URLs never change between deploys. `main.js`'s `MODEL_VERSION` constant is appended as `?v=N` to every model/poster URL — **bump it whenever a stage's model file is regenerated**, or devices that fetched the old file within the last hour keep serving the stale one.

## Architecture

Everything runs client-side in `main.js` after `index.html` loads `stages.json` and `messages.json` in parallel. No frameworks, no modules besides the external CDN scripts (`<model-viewer>`, `qrcode`, Tabler icons, Google Fonts).

### Two independent state machines driven by scroll, not a timer

- **`STAGES`** (from `stages.json`): ordered list of `{glb, usdz, poster}` per design stage. `applyStage(i)` swaps the `<model-viewer>` `src`/`ios-src`/`poster`. Stages without a `glb` yet (currently 6–12) keep showing whichever model is already loaded — the story never looks "broken" just because a later stage's model hasn't been dropped in.
- **`MESSAGES`** (from `messages.json`, personalized copy of `RAW_MESSAGES`): the chat script. Content is **scroll-revealed, not autoplayed** — `revealIdx` only advances when the visitor scrolls `.chatbody` toward its current bottom (`fillViewport()`, triggered by a scroll listener, `resize`, and after every reveal). `revealNext()` plays the typing-dots beat first for every message-shaped entry (`msg`/`poll`/`image`/`file` — sender or visitor alike) before swapping it for the real bubble via `renderEntry()`. A `#reveal-spacer` element keeps `.chatbody` scrollable even when revealed content doesn't yet overflow it, so the scroll listener always has something to fire on; it's removed once the story ends.
- A `type:"image"` entry is the sync point: `renderEntry` increments `currentStage` and calls `applyStage()` — so the *order and count* of `image` entries in `messages.json` must match the intended stage sequence in `stages.json`.

### Playback control flow

`intro (name entry) -> startExperience(name) -> personalize all messages -> fillViewport()`. Once `revealIdx` reaches the end, `revealNext()` runs the finish sequence: pause, fade the chat out, clear it, and reset to the intro screen instead of silently looping the same visitor's name — each playthrough is meant to be one visitor's session. Entering AR (`ar-status` event from `<model-viewer>`) sets `arPaused`, which blocks further reveals until the visitor exits AR (`fillViewport()` resumes them).

`type:"userPrompt"` entries pause revealing and show a caption over the AR panel with a compact on-screen keyboard (see below); the typed reply becomes a synthetic outgoing `msg` appended live, not part of `messages.json`. There's a `.scroll-hint` pill (`#scrollHint`) that fades in whenever unrevealed story content exists but the visitor hasn't scrolled far enough to trigger it yet.

### Kiosk-specific UI choices (don't "fix" without re-reading the comments in `main.js`)

- **No real `<input>` anywhere.** This is a touchscreen kiosk with no physical keyboard; a real `<input>` would summon the OS's native on-screen keyboard over the whole display. `buildKeyboard()` renders a plain QWERTY button grid instead, shared between full-screen name entry and the compact in-phone reply keyboard.
- **Parallax intro background** uses mouse movement on desktop and `deviceorientation` tilt on the actual kiosk (no mouse there). iOS gates motion-sensor access behind a user gesture — requested on first tap on the intro overlay.
- **AR panel centering/caption positioning** (`centerViewerAroundVisibleArea`, `positionArCaption`) is computed from the floating phone panel's actual `getBoundingClientRect()` on resize, not fixed CSS offsets, since the model-viewer's own centering logic doesn't know the phone panel is covering part of the screen.
- **Custom AR button** replaces model-viewer's built-in one via its `slot="ar-button"` mechanism — the built-in icon-only button can render blank if its internal asset fails to load.

### Poll state

Polls track scripted (`pollVotes` entries elsewhere in the script) vote counts separately from the visitor's own vote (`POLL_STATE[pollIdx]`), added together for display — so narrated percentages (e.g. "76% in favor") stay consistent regardless of whether the visitor votes. `multi` polls allow multiple selections (`Set`), single-choice polls store one index.
