# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, no-build kiosk web app ("Agentic Square") for a touchscreen device: a split-screen experience showing an AR/3D model of a public square's redesign (left) next to a scroll-revealed WhatsApp-style chat that narrates the design process (right, phone mockup — group name "Westhagen", AI persona "Marktplatz"). A visitor scans a QR code, types their name, and scrolls the chat to reveal it — `{{name}}` tokens in the script get personalized live. Each `type:"image"` message advances the 3D model shown in the AR panel to the next stage. Periodic `type:"level"` cards pop up next to a specific chat message to mark a new chapter of the story (see Architecture).

Content: `messages.json` (chat script, currently the "Westhagen Plays!" story). Sourced from `Westhagen_Plays_Exhibition_Script.docx`, a narrative/screenplay-style Word doc the content editor writes and hands over — there's no automated round-trip for it; translating a docx update into `messages.json` changes is a manual/assisted diff-and-edit job (a prior machine-round-trippable `chat-script.docx` + `tools/chat_docx.py` setup was retired once this narrative-doc workflow took over). Deployed at Vercel, repo `dikshyapokharel16/Agentic-Square`.

## Commands

No build step — `index.html`, `main.js`, `styles.css` are loaded directly as static files. There is no root `package.json`, no bundler, no test suite.

**Local dev:** serve the repo root over HTTP (relative `fetch("stages.json")` / `fetch("messages.json")` calls fail under `file://`), e.g. `npx serve .`, then open `index.html`.

**Deploy:** push to `main` — Vercel auto-deploys from GitHub (see commit `096336f`). `vercel.json` only sets `Content-Type`/`Cache-Control` headers for `models/*.glb`/`*.usdz`/`*.webp`.

### 3D model scaling (`tools/`, see `tools/README.md` for the full pipeline)

SketchUp/Blender exports come in ~20x oversized. Run raw exports through these before dropping into `models/stage-NN/`:

```
node fix-glb-scale.mjs <raw.glb> ../models/stage-NN/model.glb 0.0114        # Android — multiplier on the current file
python fix-usdz-scale.py <raw.usdz> ../models/stage-NN/model.usdz --factor 0.04556   # iOS — absolute factor on the raw export, NOT the same number as .glb's
```

**`.glb` and `.usdz` need different factor *values*, not just different flags** — they're independent export pipelines with different baked-in prior scale corrections, so the same raw model needs a different number per format. Verify actual size (not just the factor) with `node inspect-glb.mjs <path>` / `python inspect-usdz.py <path>` — target ~1.8m longest side in a 2m×2m AR tracking area. `fix-glb-scale.mjs` and `fix-usdz-scale.py` also resize/re-encode textures (2048×2048 max) — oversized textures, not geometry, are usually the biggest win on load time; `fix-glb-scale.mjs` additionally simplifies geometry (meshoptimizer) and Draco-compresses on the way out. One-time setup: `npm install` in `tools/` (needs `@gltf-transform/core`); Python side needs `pip install usd-core Pillow`.

**Cache-busting for models:** `.glb`/`.usdz`/`.webp` are served with `Cache-Control: max-age=3600` (`vercel.json`) and their URLs never change between deploys. `main.js`'s `MODEL_VERSION` constant is appended as `?v=N` to every model/poster URL — **bump it whenever a stage's model file is regenerated**, or devices that fetched the old file within the last hour keep serving the stale one.

## Architecture

Everything runs client-side in `main.js` after `index.html` loads `stages.json` and `messages.json` in parallel. No frameworks, no modules besides the external CDN scripts (`<model-viewer>`, `qrcode`, Tabler icons, Google Fonts).

**Tabler icons CDN path:** the jsDelivr URL is `@tabler/icons-webfont@<version>/tabler-icons.min.css` — **no `/dist/`**. That version's package puts the CSS at the package root; a `/dist/` path 404s silently (the page loads fine, every `<i class="ti ti-*">` just renders as an empty box forever). Double-check this if the pinned version ever gets bumped.

### Two independent state machines driven by scroll, not a timer

- **`STAGES`** (from `stages.json`): ordered list of `{glb, usdz, poster}` per design stage — currently 4 stages (00–03), all populated. `applyStage(i)` swaps the `<model-viewer>` `src`/`ios-src`/`poster`; if a stage ever ships without a `glb` (e.g. while a new one is mid-production), it keeps showing whichever model is already loaded rather than looking "broken".
- **`MESSAGES`** (from `messages.json`, personalized copy of `RAW_MESSAGES`): the chat script. Content is **scroll-revealed, not autoplayed** — `revealIdx` only advances when the visitor scrolls `.chatbody` toward its current bottom (`fillViewport()`, triggered by a scroll listener, `resize`, and after every reveal). `revealNext()` plays the typing-dots beat first for every message-shaped entry (`msg`/`poll`/`image`/`file` — sender or visitor alike) before swapping it for the real bubble via `renderEntry()`. A `#reveal-spacer` element keeps `.chatbody` scrollable even when revealed content doesn't yet overflow it, so the scroll listener always has something to fire on; it's removed once the story ends.
- A `type:"image"` entry is the sync point: `renderEntry` increments `currentStage` and calls `applyStage()` — so the *order and count* of `image` entries in `messages.json` must match the intended stage sequence in `stages.json`.

### Playback control flow

`intro (name entry) -> startExperience(name) -> personalize all messages -> fillViewport()`. Once `revealIdx` reaches the end, `revealNext()` runs the finish sequence: pause, fade the chat out, clear it, and reset to the intro screen instead of silently looping the same visitor's name — each playthrough is meant to be one visitor's session. Entering AR (`ar-status` event from `<model-viewer>`) sets `arPaused`, which blocks further reveals until the visitor exits AR (`fillViewport()` resumes them).

`type:"userPrompt"` entries pause revealing and show a caption over the AR panel (`#arCaption`, `handleUserPrompt`); `entry.mode` picks the interaction:
- `"text"` (default) — compact on-screen keyboard (see below); the typed reply becomes a synthetic outgoing `msg` appended live, not part of `messages.json`.
- `"choice"` — `entry.options[]` render as tap buttons instead of a keyboard; each option has its own `text` (posted as the visitor) and optional `reply` (Marktplatz's follow-up, `{role, text}`).
- `"keywords"` — same keyboard as `"text"`, but the typed reply is also scanned against `entry.buckets[].match` (case-insensitive substring match); the first matching bucket's `reply` plays as a follow-up (typing beat included), or `entry.fallbackReply` if nothing matches.

There's a `.scroll-hint` pill (`#scrollHint`) that fades in whenever unrevealed story content exists but the visitor hasn't scrolled far enough to trigger it yet — it's force-hidden while the reply keyboard is open (`updateScrollHint` checks `#replyKeyboard.show`), since the two would otherwise overlap.

### Level pop-ups (`type:"level"`)

A chapter-break card ("LEVEL 1 — The idea", etc.) that pops up **next to the chat** over the AR panel — it reuses the exact same `#arCaption` element as the reply prompt, just switched into `.level-mode` (swaps in a level number/title row, hides the tap-to-reply/skip row). Handled by `handleLevelPopup` in `main.js`.

- **A `type:"level"` entry carries no visible row of its own.** When `revealNext()` reaches one, it stores it as `pendingLevelEntry` and immediately advances past it — costing the visitor no extra scroll — then keeps revealing whatever comes next through the exact same one-at-a-time, scroll-gated path as any other content (including `userPrompt` entries in between; there's nothing special to route around anymore). Only once the entry actually revealed matches `pendingLevelEntry.anchorIndex` does the card appear, positioned next to that row via `positionLevelCaption` (keyed off the `data-msg-index` attributes `renderEntry` stamps on every row). Omit `anchorIndex` to fall back to a fixed spot near the phone's bottom edge (`positionArCaption`) instead.
- **No forced scrolling.** Because the anchor row only ever gets revealed through the visitor's own scroll pace (never auto-played ahead of it), it's already on-screen right where it just rendered — `positionLevelCaption` just reads its current `getBoundingClientRect()`, no `scrollIntoView`/scrollTop adjustment needed. (An earlier version auto-played a batch of messages and force-scrolled to center the anchor — that made the chat visibly jump 1–3 messages ahead of where the visitor had actually scrolled to, which is exactly what this design avoids.)
- **`entry.anchorIndex`** is a raw array position, not a stable reference — reordering/adding/removing entries elsewhere in `messages.json` silently invalidates it, so double-check it after any reorder.
- **Dismissal is tap-only** — tapping the card anywhere resolves `handleLevelPopup`'s promise and `revealNext()` continues. (An earlier scroll-to-dismiss version was replaced — scroll events fired mid-gesture could close a card in the same motion that revealed it, before it was even visible.)
- The level-mode card is narrower (`max-width: min(290px, 27vw)`) and tucks in less far under the phone (`overlap: 15` vs. `positionArCaption`'s `36`) than the reply prompt's own box, so it doesn't sit on top of the sender avatar column.

### Role-based avatars & bubble color

Marktplatz speaks with a different institutional "hat" depending on the story beat (`entry.role`, e.g. `"Host"`, `"Voting officer"`, `"Designer"`, `"Mediator"`, `"Resource manager"`, `"Administrative liaison"`, `"Event planner"`, `"Documentation"`) — see `ROLE_STYLES` in `main.js` for the full icon/color table. When `role` is set, `avatarHTML` draws a Tabler-icon circle in that color instead of initials, `nameColorFor` colors the sender name to match, and `bubbleStyleFor` washes the bubble background with a light tint of the same color (`color-mix(in srgb, <color> 14%, #fff)`) — applies to `msg`/`image`/`file`/`poll` bubbles. Resident (non-Marktplatz) senders are unaffected and keep the existing hash-based initials/color scheme.

### Kiosk-specific UI choices (don't "fix" without re-reading the comments in `main.js`)

- **No real `<input>` anywhere.** This is a touchscreen kiosk with no physical keyboard; a real `<input>` would summon the OS's native on-screen keyboard over the whole display. `buildKeyboard()` renders a plain QWERTY button grid instead, shared between full-screen name entry and the compact in-phone reply keyboard.
- **Parallax intro background** uses mouse movement on desktop and `deviceorientation` tilt on the actual kiosk (no mouse there). iOS gates motion-sensor access behind a user gesture — requested on first tap on the intro overlay.
- **AR panel centering/caption positioning** (`centerViewerAroundVisibleArea`, `positionArCaption`) is computed from the floating phone panel's actual `getBoundingClientRect()` on resize, not fixed CSS offsets, since the model-viewer's own centering logic doesn't know the phone panel is covering part of the screen.
- **Custom AR button** replaces model-viewer's built-in one via its `slot="ar-button"` mechanism — the built-in icon-only button can render blank if its internal asset fails to load.

### Poll state & reactions

Polls track scripted (`pollVotes` entries elsewhere in the script) vote counts separately from the visitor's own vote (`POLL_STATE[pollIdx]`), added together for display — so narrated percentages (e.g. "94% in favor") stay consistent regardless of whether the visitor votes. `multi` polls allow multiple selections (`Set`), single-choice polls store one index. `entry.needed: [n, ...]` switches a poll's per-option display from a percentage to a `current/needed` count (used for the Building Day helper sign-up poll). A later `msg` entry can carry `pollVotes: [...]` (updates the currently-active poll's scripted counts — `activePollIndex`) and `pollClose: true` (locks further voting); place these on whichever chat message narrates the poll closing/results so the numbers shown line up with what's said (e.g. "around 280 kids registered" ⇒ scripted counts summing to ~280). `msg`/`image` entries can also carry `reactions: [{emoji, count}]` — everyday resident suggestions read naturally with up to ~20-30, major Marktplatz announcements (city approval, etc.) with counts in the hundreds.
