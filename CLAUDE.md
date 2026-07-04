# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, no-build kiosk web app ("Agentic Square") for a touchscreen device: a split-screen experience showing an AR/3D model of a public square's redesign (left) next to a scroll-revealed WhatsApp-style chat that narrates the design process (right, phone mockup — group name "Westhagen", AI persona "Marktplatz"). A visitor scans a QR code, types their name, and scrolls the chat to reveal it — `{{name}}` tokens in the script get personalized live. Each `type:"image"` message advances the 3D model shown in the AR panel to the next stage. Periodic `type:"level"` cards pop up next to a specific chat message to mark a new chapter of the story (see Architecture).

Content: `messages.json` (chat script, currently the "Westhagen Plays!" story) — sourced from `Westhagen_Plays_Exhibition_Script.docx` — deployed at Vercel, repo `dikshyapokharel16/Agentic-Square`.

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

- Only `date`/`system`/`event`/`msg`/`image`/`level` entries round-trip through Word. `poll`, `file`, and `userPrompt` entries have no Word representation — they appear as a `[LOCKED: ...]` marker line matched back up by position within their type when syncing; editing them must happen directly in `messages.json`.
- `sync` matches `msg`/`image` `reactions` back onto entries by exact `(type, sender, text)` key — rewording a line drops its reactions.
- `MSG`/`IMAGE` lines can carry a `[Role]` tag before the sender (e.g. `MSG [Designer] Marktplatz 12:04`) to set that message's avatar icon/accent color — see "Role-based styling" below. `LEVEL` lines can carry a trailing `(auto:N)` tag — see "Level pop-ups" below.
- `entry.anchorIndex` on a `level` entry (which chat row it pops up next to) is a raw position in `messages.json` and has **no Word representation at all** — it doesn't survive `sync`, and reordering/adding/removing entries elsewhere silently invalidates it. Set/fix it directly in `messages.json` after any reorder.
- `export` always regenerates from the current `messages.json` — rerun it after any direct JSON edit to keep the doc in sync. **`chat-script.docx` in the repo is currently stale** (predates the level/role/choice/keyword-prompt features below) — regenerate it before handing it to a Word editor. `python-docx` (and Python itself) may not be available in every dev environment; if so, either ask the user to run `export`/`sync` themselves, or read/edit `messages.json` directly and skip the Word round-trip for that change.

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

**Tabler icons CDN path:** the jsDelivr URL is `@tabler/icons-webfont@<version>/tabler-icons.min.css` — **no `/dist/`**. That version's package puts the CSS at the package root; a `/dist/` path 404s silently (the page loads fine, every `<i class="ti ti-*">` just renders as an empty box forever). Double-check this if the pinned version ever gets bumped.

### Two independent state machines driven by scroll, not a timer

- **`STAGES`** (from `stages.json`): ordered list of `{glb, usdz, poster}` per design stage. `applyStage(i)` swaps the `<model-viewer>` `src`/`ios-src`/`poster`. Stages without a `glb` yet (currently 6–12) keep showing whichever model is already loaded — the story never looks "broken" just because a later stage's model hasn't been dropped in.
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

- **`entry.autoReveal: N`** — the N entries right after this one in `messages.json` play out first, automatically (typing beats and all, normal chat, no card visible yet) — *then* the card appears. This ordering is deliberate: the card only shows once its coupled message has actually appeared, already sitting at the right height, rather than popping up early and jumping into position later.
- **`entry.anchorIndex`** — the `messages.json` index of the chat row the card should sit level with (`positionLevelCaption`, keyed off `data-msg-index` attributes `renderEntry` stamps on every row). That row is scrolled into view (`scrollIntoView({block:"center"})`) right before the card shows, since a multi-entry `autoReveal` batch doesn't auto-scroll the chat and can otherwise leave the anchor below the fold. Omit `anchorIndex` to fall back to a fixed spot near the phone's bottom edge (`positionArCaption`).
- **Dismissal is tap-only** — tapping the card anywhere resolves `handleLevelPopup`'s promise and `revealNext()` continues. (An earlier scroll-to-dismiss version was replaced — scroll events fired mid-gesture could close a card in the same motion that revealed it, before it was even visible.)
- **A level's own `autoReveal` batch cannot safely cross a `userPrompt` entry** — both a level card and a userPrompt share `#arCaption`, and the auto-reveal loop (`revealPlainEntry`) doesn't know how to pause for one. If a level needs to anchor to a message on the far side of a touchpoint, **move the level entry's position in `messages.json`** to sit just before that message instead (as done for Level 4, moved from before Thursday's content to just before the Documentation hand-off, after Touchpoint 3) — don't try to `autoReveal` through the touchpoint.
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
