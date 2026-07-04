let STAGES = [];
let MESSAGES = [];
let RAW_MESSAGES = []; // unpersonalized script, kept so a fresh visitor can re-personalize from scratch
let visitorName = "";
let viewer = null;
let currentStage = 0;

let POLL_STATE = {};
let activePollIndex = null;
let revealIdx = 0;
let revealing = false;
let arPaused = false;
let storyFinished = false;
let firstImageIdx = -1; // computed once MESSAGES loads — see init

async function loadJSON(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path} (${response.status})`);
  }
  return response.json();
}

function stageAt(i) {
  return STAGES[Math.max(0, Math.min(i, STAGES.length - 1))];
}

// .glb/.usdz are served with a 1-hour Cache-Control (vercel.json) and their
// paths never change between deploys, so a device that fetched a model
// before a re-scale can keep serving the stale one for up to an hour.
// Bump this whenever a stage's model file is regenerated so every deploy
// forces a fresh fetch regardless of that cache.
const MODEL_VERSION = "10";

function withVersion(url) {
  return url ? `${url}?v=${MODEL_VERSION}` : url;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/* ---------- shared on-screen keyboard ----------
   Kiosk touchscreen, no physical keyboard — a real <input> would summon the
   OS's native on-screen keyboard over the whole physical display. This
   renders a QWERTY grid of plain buttons instead; typed text lives in a JS
   string that callers own, never in a focusable form field. Used both by
   the full-screen name entry and the compact in-phone reply keyboard. */
const KEYBOARD_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"].map((row) => row.split(""));

function buildKeyboard(container, { onChar, onBackspace }) {
  container.innerHTML = "";
  KEYBOARD_ROWS.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "key-row";
    row.forEach((ch) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "key";
      key.textContent = ch;
      key.addEventListener("click", () => onChar(ch.toLowerCase()));
      rowEl.appendChild(key);
    });
    container.appendChild(rowEl);
  });

  const lastRow = document.createElement("div");
  lastRow.className = "key-row";
  const spaceKey = document.createElement("button");
  spaceKey.type = "button";
  spaceKey.className = "key key-space";
  spaceKey.textContent = "Space";
  spaceKey.addEventListener("click", () => onChar(" "));
  const backspaceKey = document.createElement("button");
  backspaceKey.type = "button";
  backspaceKey.className = "key key-backspace";
  backspaceKey.textContent = "⌫";
  backspaceKey.addEventListener("click", onBackspace);
  lastRow.appendChild(spaceKey);
  lastRow.appendChild(backspaceKey);
  container.appendChild(lastRow);
}

/* ---------- intro / onboarding ---------- */

const introOverlay = document.getElementById("intro-overlay");
const introStory = document.getElementById("intro-story");
const introName = document.getElementById("intro-name");
const nameDisplay = document.getElementById("nameDisplay");
const startBtn = document.getElementById("startBtn");
const scanQrBtn = document.getElementById("scanQrBtn");

/* ---------- intro: parallax background ----------
   Mouse for desktop/browser preview; device-tilt for the actual touchscreen
   kiosk, which has no mouse at all. If neither ever fires, the image just
   stays centered — no error states, nothing else gated on this working. */
const introBg = document.getElementById("introBg");
const PARALLAX_MAX_SHIFT = 24; // px

function setParallax(x, y) {
  const dx = Math.max(-1, Math.min(1, x)) * PARALLAX_MAX_SHIFT;
  const dy = Math.max(-1, Math.min(1, y)) * PARALLAX_MAX_SHIFT;
  introBg.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

window.addEventListener("mousemove", (event) => {
  setParallax((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
});

function handleOrientation(event) {
  if (event.gamma == null || event.beta == null) return;
  setParallax(event.gamma / 30, (event.beta - 45) / 30);
}

let orientationBound = false;
function bindDeviceOrientation() {
  if (orientationBound || typeof DeviceOrientationEvent === "undefined") return;
  orientationBound = true;
  window.addEventListener("deviceorientation", handleOrientation);
}

// iOS requires an explicit user gesture to grant motion-sensor access —
// piggyback on the first tap anywhere on the intro overlay. A silent no-op
// (no prompt at all) on Android/desktop, where this API doesn't exist.
introOverlay.addEventListener(
  "click",
  () => {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then((state) => {
          if (state === "granted") bindDeviceOrientation();
        })
        .catch(() => {});
    } else {
      bindDeviceOrientation();
    }
  },
  { once: true }
);

/* ---------- intro: story sequence ----------
   Auto-advancing narrative beats in a single reusable speech-bubble panel
   (.story-bubble, same visual recipe as .ar-caption / Speech bubble.png).
   Tapping the bubble skips the current wait immediately instead of making
   an impatient visitor sit through the full hold. */
const STORY_BEATS = [
  "You are one of 9,200 residents living in Westhagen.",
  "Walking through the square, you noticed something new — a cluster of wooden pallets that wasn't there before.",
  "Beside them, a QR code. You scanned it.",
];
const STORY_BEAT_HOLD_MS = 3500;
const STORY_BEAT_FADE_MS = 500;

// Scattered across the screen (top/left as % of the intro-story section)
// rather than stacked in one spot, so each beat reads like a caption placed
// somewhere new over the illustration — matching the reference site.
const STORY_POSITIONS = [
  { top: "16%", left: "8%" },
  { top: "58%", left: "54%" },
  { top: "70%", left: "12%" },
];

const storyBubble = document.getElementById("storyBubble");
let storyTimer = null;
let storyBeatIdx = 0;
let storyAdvancing = false;

function showStoryBeat(i) {
  storyBeatIdx = i;
  storyBubble.textContent = STORY_BEATS[i];
  const pos = STORY_POSITIONS[i];
  storyBubble.style.top = pos.top;
  storyBubble.style.left = pos.left;
  requestAnimationFrame(() => storyBubble.classList.add("show"));
  storyTimer = setTimeout(advanceStory, STORY_BEAT_HOLD_MS);
}

function advanceStory() {
  if (storyAdvancing) return;
  storyAdvancing = true;
  clearTimeout(storyTimer);
  storyBubble.classList.remove("show");
  setTimeout(() => {
    storyAdvancing = false;
    if (storyBeatIdx + 1 < STORY_BEATS.length) {
      showStoryBeat(storyBeatIdx + 1);
    } else {
      scanQrBtn.classList.remove("hidden");
    }
  }, STORY_BEAT_FADE_MS);
}

storyBubble.addEventListener("click", advanceStory);

function startStorySequence() {
  clearTimeout(storyTimer);
  storyAdvancing = false;
  scanQrBtn.classList.add("hidden");
  storyBubble.classList.remove("show");
  showStoryBeat(0);
}

const MAX_NAME_LEN = 16;
let typedName = "";

function renderNameDisplay() {
  nameDisplay.textContent = typedName;
  startBtn.disabled = typedName.trim().length === 0;
}

function appendNameChar(ch) {
  if (typedName.length >= MAX_NAME_LEN) return;
  typedName += ch;
  renderNameDisplay();
}

function backspaceName() {
  typedName = typedName.slice(0, -1);
  renderNameDisplay();
}

function showIntro() {
  typedName = "";
  renderNameDisplay();
  introName.classList.remove("active");
  introStory.classList.add("active");
  introOverlay.classList.remove("hidden");
  startStorySequence();
}

scanQrBtn.addEventListener("click", () => {
  introStory.classList.remove("active");
  introName.classList.add("active");
  buildKeyboard(document.getElementById("onscreenKeyboard"), {
    onChar: appendNameChar,
    onBackspace: backspaceName,
  });
});

startBtn.addEventListener("click", () => {
  if (startBtn.disabled) return;
  startExperience(typedName.trim());
});

// Recursively swaps the {{name}} token in every string value of the parsed
// script for the visitor's own name, so messages.json stays a single
// reusable source of truth instead of needing per-visitor copies.
function personalize(value, name) {
  if (typeof value === "string") return value.replaceAll("{{name}}", name);
  if (Array.isArray(value)) return value.map((v) => personalize(v, name));
  if (value && typeof value === "object") {
    const out = {};
    for (const key in value) out[key] = personalize(value[key], name);
    return out;
  }
  return value;
}

function startExperience(name) {
  visitorName = capitalize(name) || "Guest";
  MESSAGES = RAW_MESSAGES.map((entry) => personalize(entry, visitorName));
  introOverlay.classList.add("hidden");
  currentStage = 0;
  applyStage(0);
  revealIdx = 0;
  storyFinished = false;
  arPaused = false;
  // Defensive: normally already empty (the end-of-story reset clears it),
  // but guarantees a clean slate regardless of how chatbody got into
  // whatever state it was in before this particular start.
  chatbody().innerHTML = "";
  ensureScrollable();
  fillViewport();
}

function resetToIntro() {
  revealIdx = 0;
  storyFinished = false;
  POLL_STATE = {};
  activePollIndex = null;
  currentStage = 0;
  showIntro();
}

/* ---------- AR panel ---------- */

function createViewer(stage) {
  const root = document.getElementById("viewer-root");
  root.innerHTML = "";

  viewer = document.createElement("model-viewer");
  viewer.setAttribute("src", withVersion(stage.glb));
  if (stage.usdz) viewer.setAttribute("ios-src", withVersion(stage.usdz));
  if (stage.poster) viewer.setAttribute("poster", stage.poster);
  viewer.setAttribute("alt", `${stage.name || "3D model"} — preview`);
  viewer.setAttribute("ar", "");
  viewer.setAttribute("ar-modes", "webxr scene-viewer quick-look");
  viewer.setAttribute("ar-scale", "fixed");
  viewer.setAttribute("ar-placement", "floor");
  viewer.setAttribute("camera-controls", "");
  viewer.setAttribute("auto-rotate", "");
  viewer.setAttribute("shadow-intensity", "1");
  viewer.setAttribute("shadow-softness", "0.75");
  viewer.setAttribute("loading", "eager");

  // Pause the story while the user is actually in AR, so it doesn't keep
  // revealing without them — resume exactly where it left off once they exit.
  viewer.addEventListener("ar-status", (event) => {
    if (event.detail.status === "session-started") {
      arPaused = true;
      updateScrollHint();
    } else if (event.detail.status === "not-presenting" && arPaused) {
      arPaused = false;
      fillViewport();
    }
  });

  // Replace model-viewer's built-in AR button (an icon-only graphic that can
  // render as a blank/black shape if its internal asset fails to load) with
  // our own clearly-labeled button, using model-viewer's documented
  // slot="ar-button" mechanism — clicks on it are wired to AR automatically.
  const arButton = document.createElement("button");
  arButton.slot = "ar-button";
  arButton.className = "ar-button";
  arButton.textContent = "View AR";
  viewer.appendChild(arButton);

  // Visible loading feedback — model files can be several MB, and swapping
  // `src` with no indicator at all reads as a frozen page rather than a model
  // that's downloading. This listener stays attached across future src
  // changes too (it's on the persistent `viewer` element, not per-load).
  const progressBar = document.createElement("div");
  progressBar.slot = "progress-bar";
  progressBar.className = "progress-bar";
  progressBar.innerHTML = `<div class="update-bar"></div>`;
  viewer.appendChild(progressBar);
  viewer.addEventListener("progress", (event) => {
    const pct = event.detail.totalProgress * 100;
    progressBar.querySelector(".update-bar").style.width = `${pct}%`;
    progressBar.classList.toggle("hide", event.detail.totalProgress >= 1);
  });

  root.appendChild(viewer);
  watchArAvailability(viewer);
  centerViewerAroundVisibleArea();
}

// Warm the browser's HTTP cache for the next stage's model while the current
// one is still being viewed/chatted about, so by the time the chat actually
// advances to it, the file is already local and the swap is instant instead
// of triggering a fresh multi-MB download in the middle of the story.
const preloadedStages = new Set();
function preloadStage(i) {
  const stage = stageAt(i);
  if (!stage || !stage.glb || preloadedStages.has(i)) return;
  preloadedStages.add(i);
  fetch(withVersion(stage.glb)).catch(() => {});
}

function applyStage(i) {
  currentStage = Math.max(0, Math.min(i, STAGES.length - 1));
  const stage = stageAt(currentStage);
  if (!stage) return;

  // Stages without a model yet keep whichever model is already showing —
  // the chat picture (poster) still advances regardless, so playback never
  // looks broken just because a later stage's AR model hasn't been dropped in yet.
  if (!stage.glb) return;

  preloadStage(currentStage + 1);

  if (!viewer) {
    createViewer(stage);
    return;
  }

  viewer.src = withVersion(stage.glb);
  if (stage.usdz) viewer.setAttribute("ios-src", withVersion(stage.usdz));
  else viewer.removeAttribute("ios-src");
  if (stage.poster) viewer.setAttribute("poster", stage.poster);
}

// model-viewer centers the model within its own box — but that box spans
// the full screen while the floating phone panel covers the right portion,
// so the model reads as off-center relative to the space that's actually
// visible. Shrink the viewer's box to exclude the phone's footprint so its
// own centering lands the model in the middle of the uncovered area instead.
function centerViewerAroundVisibleArea() {
  const phone = document.querySelector(".phone-wrap");
  const root = document.getElementById("viewer-root");
  if (!phone || !root) return;
  const phoneWidth = phone.getBoundingClientRect().width;
  root.style.paddingRight = phoneWidth ? `${phoneWidth + 24}px` : "";
}

window.addEventListener("resize", centerViewerAroundVisibleArea);

// The nudge caption should read as bridging the AR scene and the phone —
// its right edge tucked under the phone's left edge — rather than sitting
// in a fixed screen corner unrelated to where the floating phone actually
// is. Positioned from JS (like centerViewerAroundVisibleArea above) since
// the phone's on-screen position depends on viewport size and isn't a
// fixed CSS offset.
function positionArCaption() {
  const caption = document.getElementById("arCaption");
  const phone = document.querySelector(".phone-wrap");
  if (!caption || !phone) return;
  const phoneRect = phone.getBoundingClientRect();
  const overlap = 36; // px the bubble's right edge tucks under the phone frame
  caption.style.left = "auto";
  caption.style.right = `${Math.max(8, window.innerWidth - phoneRect.left - overlap)}px`;
  // Anchored near the phone's bottom edge — close to where the reply
  // keyboard itself slides up from — instead of the top, so the nudge and
  // the control it opens read as connected.
  caption.style.top = "auto";
  caption.style.bottom = `${Math.max(24, window.innerHeight - phoneRect.bottom + 64)}px`;
}

window.addEventListener("resize", positionArCaption);
positionArCaption();

// Every rendered chat row is tagged with its MESSAGES array index (see
// renderEntry) so a level pop-up can be pinned to a specific already-
// revealed message instead of always sitting at a fixed spot.
function findRowByIndex(idx) {
  return chatbody().querySelector(`[data-msg-index="${idx}"]`);
}

// Same horizontal tuck as positionArCaption, but the vertical offset
// tracks a specific chat row's on-screen height instead of always sitting
// near the phone's bottom edge — used by level pop-ups that declare an
// entry.anchorIndex. Falls back to positionArCaption's fixed spot if the
// anchor row isn't found (e.g. anchorIndex omitted, or not yet rendered).
// Pulled in further than positionArCaption's own tuck: at that anchor
// height a full 36px reaches past the chat's left padding and into the
// avatar column, covering it. A card can land at any row (not just a
// fixed bottom spot), so it needs the extra clearance every time.
function positionLevelCaption(anchorRow) {
  if (!anchorRow) {
    positionArCaption();
    return;
  }
  const caption = document.getElementById("arCaption");
  const phone = document.querySelector(".phone-wrap");
  if (!caption || !phone) return;
  const phoneRect = phone.getBoundingClientRect();
  const overlap = 15; // px — clear of the avatar column (positionArCaption uses 36)
  caption.style.left = "auto";
  caption.style.right = `${Math.max(8, window.innerWidth - phoneRect.left - overlap)}px`;

  const rowRect = anchorRow.getBoundingClientRect();
  const centerY = rowRect.top + rowRect.height / 2;
  const captionHeight = caption.offsetHeight;
  const top = Math.min(
    Math.max(16, centerY - captionHeight / 2),
    window.innerHeight - captionHeight - 16
  );
  caption.style.bottom = "auto";
  caption.style.top = `${top}px`;
}

function watchArAvailability(el) {
  const evaluate = () => {
    if (el.canActivateAR) hideQrFallback();
    else showQrFallback();
  };
  el.addEventListener("load", evaluate, { once: true });
  setTimeout(evaluate, 600);
}

function showQrFallback() {
  if (document.getElementById("qr-fallback")) return;
  const panel = document.createElement("div");
  panel.id = "qr-fallback";
  const canvas = document.createElement("canvas");
  panel.appendChild(canvas);
  const caption = document.createElement("p");
  caption.textContent = "AR isn't available on this screen — scan with your phone to view it in your space.";
  panel.appendChild(caption);
  document.getElementById("ar-panel").appendChild(panel);
  if (window.QRCode) {
    QRCode.toCanvas(canvas, window.location.href, { width: 160 }, (error) => {
      if (error) console.error("QR code generation failed:", error);
    });
  }
}

function hideQrFallback() {
  const panel = document.getElementById("qr-fallback");
  if (panel) panel.remove();
}

/* ---------- chat: shared helpers ---------- */

const chatbody = () => document.getElementById("chatbody");

// Marktplatz speaks with a different institutional "hat" depending on what
// it's doing in the story (welcoming people vs. running a vote vs.
// mediating a conflict, etc.) — each role gets its own icon avatar and
// accent color instead of one fixed brand look, so the chat reads as a
// group with multiple functions rather than a single static bot identity.
const ROLE_STYLES = {
  "Host": { icon: "ti-users", color: "#7F77DD" },
  "Voting officer": { icon: "ti-checkbox", color: "#378ADD" },
  "Designer": { icon: "ti-ruler-2", color: "#D85A30" },
  "Mediator": { icon: "ti-scale", color: "#D4537E" },
  "Resource manager": { icon: "ti-coin", color: "#BA7517" },
  "Administrative liaison": { icon: "ti-building-bank", color: "#1D9E75" },
  "Event planner": { icon: "ti-calendar-event", color: "#639922" },
  "Documentation": { icon: "ti-file-text", color: "#888780" },
};

function roleStyle(entry) {
  return (entry.role && ROLE_STYLES[entry.role]) || null;
}

// Bubble background gets a faint wash of the role color (not the full
// saturated swatch — message text needs to stay readable), computed from
// the same color the avatar/name use so they read as one accent.
function bubbleStyleFor(entry) {
  const role = roleStyle(entry);
  return role ? `background: color-mix(in srgb, ${role.color} 14%, #fff);` : "";
}

function nameColorFor(entry) {
  const role = roleStyle(entry);
  return role ? role.color : entry.bg || "#111";
}

function avatarHTML(entry) {
  if (entry.isMe) return "";
  const role = roleStyle(entry);
  if (role) return `<div class="av av-role" style="background:${role.color};"><i class="ti ${role.icon}"></i></div>`;
  if (entry.sender === "Marktplatz") return `<div class="av av-loci"></div>`;
  return `<div class="av" style="background:${entry.bg}; color:${entry.fg};">${entry.initial || ""}</div>`;
}

function displayName(entry) {
  return entry.sender;
}

function updatePhoneClock(entry) {
  if (!entry.time) return;
  const clock = document.getElementById("phoneClock");
  if (clock) clock.textContent = entry.time;
}

let actionToastTimer = null;
function showActionToast() {
  const toast = document.getElementById("actionToast");
  if (!toast) return;
  toast.classList.add("show");
  if (actionToastTimer) clearTimeout(actionToastTimer);
  actionToastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}
window.showActionToast = showActionToast;

/* ---------- chat: polls ---------- */

function isOptionSelected(state, i) {
  return state.multi ? state.userVotes.has(i) : state.userVote === i;
}

function computePollDisplay(pollIdx) {
  const state = POLL_STATE[pollIdx];
  const counts = state.scripted.map((v, i) => v + (isOptionSelected(state, i) ? 1 : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (state.needed) {
    const fillPcts = counts.map((c, i) => Math.min(100, Math.round((c / state.needed[i]) * 100)));
    return { counts, total, pcts: fillPcts };
  }
  const pcts = counts.map((c) => (total > 0 ? Math.round((c / total) * 100) : 0));
  return { counts, total, pcts };
}

function updatePollDisplay(pollIdx, pulse = true) {
  const bubble = document.querySelector(`.poll-bubble[data-poll-idx="${pollIdx}"]`);
  if (!bubble) return;
  const state = POLL_STATE[pollIdx];
  const { total, pcts, counts } = computePollDisplay(pollIdx);
  state.options.forEach((label, i) => {
    const opt = bubble.querySelector(`.poll-opt[data-idx="${i}"]`);
    if (!opt) return;
    opt.querySelector(".poll-fill").style.width = pcts[i] + "%";
    const pctEl = opt.querySelector(".poll-pct");
    pctEl.textContent = state.needed ? `${counts[i]}/${state.needed[i]}` : pcts[i] + "%";
    if (pulse) {
      pctEl.classList.remove("pulse");
      void pctEl.offsetWidth;
      pctEl.classList.add("pulse");
    }
    opt.querySelector(".dot").classList.toggle("selected", isOptionSelected(state, i));
  });
  const totalEl = bubble.querySelector(".poll-total-votes");
  if (totalEl) totalEl.textContent = total + (total === 1 ? " vote" : " votes");
}

function updateScriptedPollVotes(pollIdx, newScripted) {
  if (!POLL_STATE[pollIdx]) return;
  POLL_STATE[pollIdx].scripted = newScripted.slice();
  updatePollDisplay(pollIdx);
}

function castVote(pollIdx, optionIdx) {
  const state = POLL_STATE[pollIdx];
  if (!state || state.closed) return;
  if (state.multi) {
    if (state.userVotes.has(optionIdx)) state.userVotes.delete(optionIdx);
    else state.userVotes.add(optionIdx);
  } else {
    state.userVote = state.userVote === optionIdx ? null : optionIdx;
  }
  updatePollDisplay(pollIdx);
}
window.castVote = castVote;

function closePoll(pollIdx) {
  const state = POLL_STATE[pollIdx];
  if (!state) return;
  state.closed = true;
}

/* ---------- chat: rendering ---------- */

function renderEntry(i, entry) {
  updatePhoneClock(entry);

  if (entry.type === "date" || entry.type === "system" || entry.type === "event") {
    const div = document.createElement("div");
    div.className = entry.type === "event" ? "system event" : "system";
    div.dataset.msgIndex = i;
    div.innerHTML = `<span>${entry.text}</span>`;
    chatbody().insertBefore(div, document.getElementById("reveal-spacer"));
    return;
  }

  if (entry.type === "image") {
    currentStage++;
    applyStage(currentStage);
    const stage = stageAt(currentStage);
    const poster = stage && stage.poster ? stage.poster : "";
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.msgIndex = i;
    row.innerHTML = `
      ${avatarHTML(entry)}
      <div class="img-msg-bubble" style="${bubbleStyleFor(entry)}">
        <div class="name" style="color:${nameColorFor(entry)};">${displayName(entry)}</div>
        <div class="img-wrap">
          <img src="${poster}" alt="${entry.caption || "shared image"}">
          <span class="img-time">${entry.time || ""}</span>
        </div>
      </div>`;
    chatbody().insertBefore(row, document.getElementById("reveal-spacer"));
    return;
  }

  if (entry.type === "file") {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.msgIndex = i;
    row.innerHTML = `
      ${avatarHTML(entry)}
      <div class="file-msg-bubble" style="${bubbleStyleFor(entry)}">
        <div class="name" style="color:${nameColorFor(entry)};">${displayName(entry)}</div>
        <div class="file-card">
          <div class="file-icon"><i class="ti ti-file-type-pdf"></i></div>
          <div class="file-meta">
            <div class="file-name">${entry.fileName || "document.pdf"}</div>
            <div class="file-sub">${entry.fileSub || "PDF document"}</div>
          </div>
        </div>
        <span class="time">${entry.time || ""}</span>
      </div>`;
    chatbody().insertBefore(row, document.getElementById("reveal-spacer"));
    return;
  }

  if (entry.type === "msg") {
    if (entry.pollVotes && activePollIndex !== null) {
      updateScriptedPollVotes(activePollIndex, entry.pollVotes);
      if (entry.pollClose) closePoll(activePollIndex);
    }
    const row = document.createElement("div");
    const reactions =
      entry.reactions && entry.reactions.length
        ? `<div class="msg-reactions">${entry.reactions
            .map((r) => `<span class="reaction-pill">${r.emoji}<span class="reaction-count">${r.count}</span></span>`)
            .join("")}</div>`
        : "";
    const ctaBtn = entry.ctaButton ? `<div><button class="cta-btn" onclick="showActionToast()">${entry.ctaButton}</button></div>` : "";
    row.dataset.msgIndex = i;
    if (entry.isMe) {
      row.className = "row outgoing" + (reactions ? " has-reactions" : "");
      row.innerHTML = `
        <div class="bubble outgoing">
          <div class="text">${entry.text}<span class="time">${entry.time || ""}</span></div>
          ${ctaBtn}
          ${reactions}
        </div>`;
    } else {
      row.className = "row" + (reactions ? " has-reactions" : "");
      row.innerHTML = `
        ${avatarHTML(entry)}
        <div class="bubble" style="${bubbleStyleFor(entry)}">
          <div class="name" style="color:${nameColorFor(entry)};">${displayName(entry)}</div>
          <div class="text">${entry.text}<span class="time">${entry.time || ""}</span></div>
          ${ctaBtn}
          ${reactions}
        </div>`;
    }
    chatbody().insertBefore(row, document.getElementById("reveal-spacer"));
    return;
  }

  if (entry.type === "poll") {
    const pollIdx = i;
    POLL_STATE[pollIdx] = {
      scripted: entry.options.map(() => 0),
      userVote: null,
      userVotes: new Set(),
      multi: !!entry.multi,
      options: entry.options,
      needed: entry.needed || null,
    };
    activePollIndex = pollIdx;
    const optClass = entry.multi ? "poll-opt multi" : "poll-opt";
    const optsHtml = entry.options
      .map(
        (label, i2) => `
      <div class="${optClass}" data-idx="${i2}" onclick="castVote(${pollIdx},${i2})">
        <div class="poll-fill" style="width:0%"></div>
        <div class="poll-opt-row">
          <span class="dot"></span>
          <span class="poll-label">${label}</span>
          <span class="poll-pct">${entry.needed ? `0/${entry.needed[i2]}` : "0%"}</span>
        </div>
      </div>`
      )
      .join("");
    const qIcon = entry.multi ? "ti-list-check" : "ti-chart-bar";
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.msgIndex = i;
    row.innerHTML = `
      ${avatarHTML(entry)}
      <div class="poll-bubble" data-poll-idx="${pollIdx}" style="${bubbleStyleFor(entry)}">
        <div class="name" style="color:${nameColorFor(entry)};">${displayName(entry)}</div>
        <div class="poll-q"><i class="ti ${qIcon}"></i><span>${entry.question}</span></div>
        ${optsHtml}
        <div class="poll-meta"><span class="poll-total-votes">0 votes</span><span class="poll-time">${entry.time || ""}</span></div>
      </div>`;
    chatbody().insertBefore(row, document.getElementById("reveal-spacer"));
    return;
  }
}

function showTyping(entry, duration) {
  const row = document.createElement("div");
  row.className = "typing-row" + (entry.isMe ? " outgoing" : "");
  row.innerHTML = `
    ${avatarHTML(entry)}
    <div class="typing-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  chatbody().insertBefore(row, document.getElementById("reveal-spacer"));
  return waitOrSkip(duration).then(() => row.remove());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Like sleep(), but scrolling while it's pending ends it immediately
// instead of making the visitor sit through a delay they've already
// signaled (by scrolling) that they want to skip past — used for the
// typing-bubble beat and the short date/system pause, both of which happen
// while the visitor might already be scrolling toward the next thing.
let skipCurrentWait = null;
function waitOrSkip(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      if (skipCurrentWait === finish) skipCurrentWait = null;
      resolve();
    };
    const timeoutId = setTimeout(finish, ms);
    skipCurrentWait = finish;
  });
}

// Typing-bubble timing. Duration scales with how much text is actually in
// the entry (roughly a relaxed reading speed) instead of one flat delay for
// every bubble, so a one-word reply flashes by and a long one lingers.
// "intro" values apply only up to the first IMAGE entry (pure chatter, no
// model to see yet) so a visitor isn't stuck through a minute of slow
// typing bubbles before the AR panel ever changes; "normal" applies from
// the first image onward, once the design story is underway. There's no
// separate post-render "reading pause" — the story only actually advances
// again once the visitor scrolls for it (see fillViewport below).
const PACE = {
  intro: { typingBase: 550, perWord: 95 },
  normal: { typingBase: 1050, perWord: 140 },
  shortPause: 1700, // pause after date/system/event bubbles
  introShortPause: 550,
  loopEndPause: 5200, // pause before fading out once the last entry is revealed
  fadeOut: 500,
};

function wordCount(entry) {
  const text = entry.text || entry.caption || entry.question || "";
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function typingDuration(entry, inIntro) {
  const p = inIntro ? PACE.intro : PACE.normal;
  return p.typingBase + wordCount(entry) * p.perWord;
}

/* ---------- in-story reply prompt ----------
   Pauses playback, nudges the visitor via a caption bubble over the AR
   panel (styled like a narrative caption, not a chat bubble — it's "the
   square itself" asking). Tapping it slides up either a compact keyboard or
   a set of tap options inside the phone screen, depending on entry.mode:
     - "text" (default): free typing, becomes the visitor's own outgoing msg.
     - "choice": tap-to-pick options (entry.options), each posts its own
       wording as the visitor and — unless the option has none — a
       follow-up reply from Marktplatz.
     - "keywords": free typing like "text", but the typed reply is also
       scanned against entry.buckets to pick which Marktplatz follow-up
       fits best (entry.fallbackReply if nothing matches).
   Skip, an 8s timeout, or sending/tapping a reply all resolve the same way
   so playback always continues. */
const REPLY_TIMEOUT_MS = 8000;
const MAX_REPLY_LEN = 80;

// Finds the first bucket whose keywords appear in the typed text
// (case-insensitive substring match); falls back to entry.fallbackReply
// (or null) if nothing matches, so a "keywords" prompt without a matching
// bucket still resolves — just without a follow-up reply.
function matchBucketReply(entry, text) {
  const lower = text.toLowerCase();
  const bucket = (entry.buckets || []).find((b) => b.match.some((kw) => lower.includes(kw)));
  return (bucket && bucket.reply) || entry.fallbackReply || null;
}

function handleUserPrompt(entry) {
  return new Promise((resolve) => {
    const caption = document.getElementById("arCaption");
    const captionText = document.getElementById("arCaptionText");
    const captionSkip = document.getElementById("arCaptionSkip");
    const replyKeyboard = document.getElementById("replyKeyboard");
    const replyDisplay = document.getElementById("replyDisplay");
    const replySendBtn = document.getElementById("replySendBtn");
    const replyChoices = document.getElementById("replyChoices");
    const isChoice = entry.mode === "choice";

    updatePhoneClock(entry);
    caption.classList.remove("level-mode");
    captionText.textContent = entry.promptText || "Want to say something to the group?";
    replyDisplay.textContent = "";
    replyDisplay.setAttribute("data-placeholder", entry.placeholder || "Type a reply…");
    replyKeyboard.classList.toggle("choice-mode", isChoice);
    positionArCaption();
    caption.classList.add("show");

    let replyText = "";
    let settled = false;
    let built = false;
    const timeoutId = setTimeout(() => finish(""), REPLY_TIMEOUT_MS);

    // Renders Marktplatz's follow-up (if any) after a typing beat, then
    // resolves — shared by both the choice and keyword-bucket paths so the
    // reply always appears as part of the same interaction, not gated
    // behind a further scroll.
    async function settleWithReply(reply) {
      if (reply) {
        const replyEntry = {
          type: "msg",
          sender: "Marktplatz",
          role: reply.role,
          text: reply.text,
          time: reply.time || entry.time,
          bg: "#BF5468",
          fg: "#fbe7ea",
          initial: "L",
        };
        await showTyping(replyEntry, pacedDuration(typingDuration(replyEntry, false)));
        renderEntry(revealIdx, replyEntry);
      }
      resolve();
    }

    function finish(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      caption.classList.remove("show");
      replyKeyboard.classList.remove("show");
      caption.onclick = null;
      captionSkip.onclick = null;
      replySendBtn.onclick = null;
      if (text && text.trim()) {
        renderEntry(revealIdx, { type: "msg", isMe: true, text: capitalize(text.trim()), time: entry.time });
        if (entry.mode === "keywords") {
          settleWithReply(matchBucketReply(entry, text));
          return;
        }
      }
      resolve();
    }

    function finishChoice(option) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      caption.classList.remove("show");
      replyKeyboard.classList.remove("show");
      caption.onclick = null;
      captionSkip.onclick = null;
      renderEntry(revealIdx, { type: "msg", isMe: true, text: option.text, time: entry.time });
      settleWithReply(option.reply);
    }

    // Skip sits inside the caption box, so stop its click from also
    // bubbling up to the box's own "open the reply keyboard" handler below.
    captionSkip.onclick = (event) => {
      event.stopPropagation();
      finish("");
    };

    // The whole box is tappable, not just the text — a visitor's tap could
    // land anywhere on the caption bubble, not precisely on the sentence.
    caption.onclick = () => {
      clearTimeout(timeoutId);
      caption.classList.remove("show");
      if (!built) {
        if (isChoice) {
          replyChoices.innerHTML = "";
          (entry.options || []).forEach((option) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "choice-btn";
            btn.textContent = option.label;
            btn.addEventListener("click", () => finishChoice(option));
            replyChoices.appendChild(btn);
          });
        } else {
          buildKeyboard(document.getElementById("replyKeyboardKeys"), {
            onChar: (ch) => {
              if (replyText.length >= MAX_REPLY_LEN) return;
              replyText += ch;
              replyDisplay.textContent = replyText;
            },
            onBackspace: () => {
              replyText = replyText.slice(0, -1);
              replyDisplay.textContent = replyText;
            },
          });
        }
        built = true;
      }
      replyKeyboard.classList.add("show");
      // The keyboard slides up over the same corner the scroll hint sits
      // in, otherwise overlapping it.
      updateScrollHint();
    };

    replySendBtn.onclick = () => finish(replyText);
  });
}

/* ---------- in-story level pop-up ----------
   Reuses the exact same caption bubble as the reply prompt above (styled
   like a narrative caption "over the AR panel", not a chat bubble) rather
   than a separate in-chat element — .level-mode on #arCaption swaps in the
   level number/title and hides the tap-to-reply/skip row, since a level
   card is purely informational. Dismissed the same way the reply prompt's
   own caption is opened: a tap anywhere on the card. entry.anchorIndex, if
   set, pins the card's height to that already-revealed message's row
   instead of the default fixed spot (see positionLevelCaption). */
function handleLevelPopup(entry) {
  return new Promise((resolve) => {
    const caption = document.getElementById("arCaption");
    const captionText = document.getElementById("arCaptionText");
    const captionLevelNum = document.getElementById("arCaptionLevelNum");
    const captionLevelTitle = document.getElementById("arCaptionLevelTitle");

    updatePhoneClock(entry);
    caption.classList.add("level-mode");
    captionLevelNum.textContent = `Level ${entry.level}`;
    captionLevelTitle.textContent = entry.title;
    captionText.textContent = entry.text;
    positionLevelCaption(entry.anchorIndex != null ? findRowByIndex(entry.anchorIndex) : null);
    caption.classList.add("show");

    caption.onclick = () => {
      caption.onclick = null;
      caption.classList.remove("show", "level-mode");
      resolve();
    };
  });
}

/* ---------- playback: scroll-revealed story ----------
   Not an autoplay timer: the story only advances as the visitor scrolls
   .chatbody toward its current bottom — like scrolling down a real chat
   thread to see what's new, at their own pace. Every message-shaped entry
   (msg/poll/image/file — sender or visitor alike, not just incoming) still
   plays the typing-dots beat first, then swaps it for the real bubble, so
   the pacing feels consistent regardless of who's "typing". */

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
}

// .chatbody needs *some* extra scrollable room whenever story content
// remains, or once revealed content happens to fit (or fall short of) the
// container there's no scrollbar at all and the scroll listener that
// reveals more can never fire. A fixed height is enough — the phone panel
// itself has a capped height (#chat-panel.phone-wrap in styles.css), so
// this doesn't need to be measured/recalculated per viewport.
function ensureScrollable() {
  const el = chatbody();
  let spacer = document.getElementById("reveal-spacer");
  if (revealIdx >= MESSAGES.length) {
    if (spacer) spacer.remove();
    return;
  }
  if (!spacer) {
    spacer = document.createElement("div");
    spacer.id = "reveal-spacer";
    el.appendChild(spacer);
  }
}

// Tracks how fast the visitor is *currently* scrolling (px/ms), so a quick
// flick through the chat doesn't force the same wait as reading slowly.
// Speed decays to 0 once scrolling has actually stopped (SCROLL_IDLE_MS) —
// otherwise the last flick's speed would linger and keep speeding up the
// automatic viewport-filling that follows, even once the visitor is just
// reading again.
let lastScrollTop = 0;
let lastScrollAt = 0;
let scrollSpeedPxPerMs = 0;
const SCROLL_IDLE_MS = 250;
const SCROLL_FAST_PX_MS = 1.5; // roughly a vigorous flick; speeds at/above this get the fastest pacing
const SKIP_MIN_PX_MS = 0.45; // below this, a scroll in progress lets the current bubble/pause play out untouched
const MIN_PACED_MS = 90; // still a visible flash of the bubble, never an instant swap

function currentScrollSpeed() {
  if (performance.now() - lastScrollAt > SCROLL_IDLE_MS) return 0;
  return scrollSpeedPxPerMs;
}

// Linearly interpolates a full typing/pause duration down toward
// MIN_PACED_MS based on current scroll speed — not scrolling (or scrolling
// slowly) keeps the full duration, flicking fast collapses it.
function pacedDuration(fullMs) {
  const t = Math.min(currentScrollSpeed(), SCROLL_FAST_PX_MS) / SCROLL_FAST_PX_MS;
  return Math.round(fullMs - t * (fullMs - MIN_PACED_MS));
}

function updateScrollHint() {
  const hint = document.getElementById("scrollHint");
  if (!hint) return;
  const el = chatbody();
  const replyKeyboardOpen = document.getElementById("replyKeyboard").classList.contains("show");
  const waiting =
    !storyFinished &&
    !revealing &&
    !arPaused &&
    !replyKeyboardOpen &&
    revealIdx < MESSAGES.length &&
    el.scrollHeight > el.clientHeight + 4 &&
    !isNearBottom(el);
  hint.classList.toggle("show", waiting);
}

// Plays the typing beat (or the short date/system/event pause) and renders
// one entry — the "plain", non-blocking reveal step shared by the normal
// sequential loop below and the level auto-reveal batch, which needs the
// exact same per-entry treatment while it runs ahead of the scroll gate.
async function revealPlainEntry(idx, entry, inIntro) {
  if (entry.type === "date" || entry.type === "system" || entry.type === "event") {
    renderEntry(idx, entry);
    await waitOrSkip(pacedDuration(inIntro ? PACE.introShortPause : PACE.shortPause));
  } else {
    await showTyping(entry, pacedDuration(typingDuration(entry, inIntro)));
    renderEntry(idx, entry);
  }
}

async function revealNext() {
  if (revealing || arPaused || storyFinished) return;

  if (revealIdx >= MESSAGES.length) {
    storyFinished = true;
    updateScrollHint();
    await sleep(PACE.loopEndPause);
    chatbody().classList.add("fade-out");
    await sleep(PACE.fadeOut);
    chatbody().classList.remove("fade-out");
    chatbody().innerHTML = "";
    // Each playthrough is one visitor's session — loop back to the intro
    // instead of silently restarting, so the next person isn't handed the
    // previous visitor's name.
    resetToIntro();
    return;
  }

  revealing = true;
  const entry = MESSAGES[revealIdx];
  const inIntro = firstImageIdx === -1 || revealIdx < firstImageIdx;

  if (entry.type === "userPrompt") {
    await handleUserPrompt(entry);
  } else if (entry.type === "level") {
    // entry.autoReveal lets a handful of entries play out first (typing
    // beats and all, normal chat — no popup visible yet), so the level
    // card only pops up once its anchor message has actually appeared,
    // already sitting right next to it — not before, and not needing a
    // reposition partway through once the anchor shows up.
    let idx = revealIdx;
    const autoCount = entry.autoReveal || 0;
    for (let n = 0; n < autoCount && idx + 1 < MESSAGES.length; n++) {
      idx++;
      await revealPlainEntry(idx, MESSAGES[idx], firstImageIdx === -1 || idx < firstImageIdx);
      ensureScrollable();
    }
    revealIdx = idx;
    if (entry.anchorIndex != null) {
      const anchorRow = findRowByIndex(entry.anchorIndex);
      if (anchorRow) anchorRow.scrollIntoView({ block: "center" });
    }
    await handleLevelPopup(entry);
  } else {
    await revealPlainEntry(revealIdx, entry, inIntro);
  }

  revealIdx++;
  revealing = false;
  ensureScrollable();
  updateScrollHint();
  requestAnimationFrame(fillViewport);
}

// Called on scroll, on resize, and right after every reveal — keeps filling
// for as long as the visible area isn't full yet (initial load, or a run of
// short entries), then stops and waits for the visitor's own next scroll.
function fillViewport() {
  // resize fires on window/viewport changes that can happen while the
  // visitor is still on the name-entry screen (mobile browsers commonly
  // fire one early, as the address bar UI settles right after load) — if
  // that reached revealNext() before startExperience() has run, it would
  // silently reveal the level-1 auto-reveal batch into the still-hidden
  // #chatbody using the *unpersonalized* MESSAGES (still === RAW_MESSAGES
  // at that point), which then sat there as stale, un-{{name}}-replaced
  // DOM nodes ahead of the real (correctly personalized) reveal that
  // startExperience() kicks off once the visitor actually starts.
  if (!introOverlay.classList.contains("hidden")) return;
  if (revealing || arPaused || storyFinished) return;
  // Once the last entry has been revealed, let this call through to
  // revealNext() unconditionally — that's what actually runs the
  // pause/fade/reset-to-intro sequence, and it shouldn't need a further
  // scroll from the visitor to happen.
  if (revealIdx >= MESSAGES.length) {
    revealNext();
    return;
  }
  const el = chatbody();
  if (el.scrollHeight <= el.clientHeight + 4 || isNearBottom(el)) {
    revealNext();
  } else {
    updateScrollHint();
  }
}

let chatScrollScheduled = false;
function onChatScroll() {
  const el = chatbody();
  const now = performance.now();
  const dt = now - lastScrollAt;
  // A dt this large means either the very first scroll event or a real
  // pause beforehand — either way there's no meaningful "speed" to derive
  // from it, so don't let a stale huge gap read as "scrolling slowly".
  if (dt > 0 && dt < SCROLL_IDLE_MS) {
    scrollSpeedPxPerMs = Math.abs(el.scrollTop - lastScrollTop) / dt;
  }
  lastScrollTop = el.scrollTop;
  lastScrollAt = now;

  // Mid-bubble/mid-pause, scrolling *meaningfully fast* fast-forwards the
  // current wait right away. Gated by speed, not just "a scroll happened" —
  // a slow, deliberate scroll fires just as many scroll events as a flick,
  // so without this threshold every bubble would get cut short the instant
  // the visitor so much as nudges the chat, leaving no scroll speed slow
  // enough to actually see one play out.
  if (skipCurrentWait && scrollSpeedPxPerMs >= SKIP_MIN_PX_MS) skipCurrentWait();

  if (chatScrollScheduled) return;
  chatScrollScheduled = true;
  requestAnimationFrame(() => {
    chatScrollScheduled = false;
    fillViewport();
  });
}
chatbody().addEventListener("scroll", onChatScroll);
window.addEventListener("resize", () => fillViewport());

/* ---------- init ---------- */

Promise.all([loadJSON("stages.json"), loadJSON("messages.json")])
  .then(([stages, messages]) => {
    STAGES = stages;
    RAW_MESSAGES = messages;
    MESSAGES = messages;
    firstImageIdx = MESSAGES.findIndex((m) => m.type === "image");
    // Preload the first AR model silently behind the intro overlay so it's
    // ready the instant a visitor finishes onboarding — no fresh download
    // stalling the reveal.
    applyStage(0);
    showIntro();
  })
  .catch((error) => {
    const root = document.getElementById("viewer-root");
    root.innerHTML = `<p id="loading-message">Could not load: ${error.message}</p>`;
  });
