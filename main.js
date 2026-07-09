let STAGES = [];
let FURNITURE = [];
let MESSAGES = [];
let RAW_MESSAGES = []; // unpersonalized script, kept so a fresh visitor can re-personalize from scratch
let visitorName = "";
let viewer = null;
let currentStage = 0;

// Mirrors styles.css's (max-width: 700px) breakpoint that switches the AR
// panel + phone mockup from a full-bleed overlay to a stacked layout — the
// two must stay in sync, since the JS positioning below only holds for one
// layout or the other, not both.
const MOBILE_STACK_QUERY = window.matchMedia("(max-width: 700px)");

let POLL_STATE = {};
let activePollIndex = null;
let revealIdx = 0;
let revealing = false;
let arPaused = false;
let arUsingSimpleModel = false; // true while viewer.src has been swapped to the stage's simpler arGlb for an in-progress AR handoff
let storyFinished = false;
let scrubbing = false; // scrolled away from the live bottom, previewing an earlier stage
let scrubStage = -1; // stage currently previewed while scrubbing, -1 when not scrubbing
let lightboxOpen = false; // an enlarged chat image is showing
let fastForwardNextTyping = false; // consumed once by whichever typing beat comes next — see nextTypingDuration
let firstImageIdx = -1; // computed once MESSAGES loads — see init
let LEVEL_ANCHORS = []; // anchorIndex of each type:"level" entry, in script order — computed once MESSAGES loads, see init

// Tuned by hand in-browser against the website display model (stage.glb).
// The AR-only model (stage.arGlb) is scaled for real-world AR placement
// (~1.8m), a completely different absolute scale than the website model's
// own — so swapping `src` to it for the AR handoff and letting model-viewer
// adjust its camera there, then swapping `src` back without also restoring
// these, leaves the display view stuck with a camera meant for the other
// model's scale (reported as the view going "very zoomed out" after using
// AR and staying that way). Re-applied whenever the website model is
// (re)shown — see showStageInViewer and the ar-status "not-presenting"
// handler below.
const DEFAULT_CAMERA_ORBIT = "38.1deg 64.8deg 115.6m";
const DEFAULT_CAMERA_TARGET = "-12.56m 0.09m -1.3m";

// Custom bounded auto-rotate (see createViewer/stepAutoRotate) — model-viewer's
// own `auto-rotate` doesn't respect min-camera-orbit/max-camera-orbit at all;
// it turned out to just jitter a few degrees back and forth around the start
// angle rather than sweeping cleanly to the limits, so this drives theta
// directly instead. Bounces between AUTOROTATE_MIN/MAX_THETA_DEG, pausing
// whenever a visitor drags and resuming after they let go.
const AUTOROTATE_MIN_THETA_DEG = -16.9;
const AUTOROTATE_MAX_THETA_DEG = 93.1;
const AUTOROTATE_SPEED_DEG_PER_SEC = 6;
const AUTOROTATE_RESUME_DELAY_MS = 3000;
let autoRotateDirection = 1;
let autoRotatePaused = false;
let autoRotateResumeTimer = null;
let autoRotateLastFrameTime = null;
let pendingLevelEntry = null; // a level marker passed through, waiting for its anchor message to reveal

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
const MODEL_VERSION = "20";

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

// Android Chrome only — iOS Safari has never implemented the Vibration API
// (no workaround), so this silently no-ops there rather than erroring.
function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

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
      key.addEventListener("click", () => {
        vibrate(10);
        onChar(ch.toLowerCase());
      });
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
  spaceKey.addEventListener("click", () => {
    vibrate(10);
    onChar(" ");
  });
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

/* ---------- furniture AR gallery ----------
   Shown once the chat story finishes, instead of resetting straight back to
   the intro screen — see the finish sequence in revealNext(). */
const furnitureGallery = document.getElementById("furnitureGallery");
const furnitureDoneBtn = document.getElementById("furnitureDoneBtn");
const furnitureArViewers = document.getElementById("furnitureArViewers");
const FURNITURE_IDLE_TIMEOUT_MS = 45000;
let furnitureIdleTimer = null;

// One hidden <model-viewer> per piece, src/ios-src set here (once FURNITURE
// loads) rather than at click time — see the comment on #furnitureArViewers
// in index.html for why that avoids a same-tap race that needed two taps.
function buildFurnitureArViewers() {
  furnitureArViewers.innerHTML = "";
  FURNITURE.forEach((item) => {
    const el = document.createElement("model-viewer");
    el.className = "furniture-ar-viewer";
    el.setAttribute("ar", "");
    el.setAttribute("ar-modes", "webxr scene-viewer quick-look");
    if (item.arGlb) el.setAttribute("src", withVersion(item.arGlb));
    if (item.arUsdz) el.setAttribute("ios-src", withVersion(item.arUsdz));
    // Assigning anything to the ar-button slot replaces model-viewer's own
    // default fallback AR button entirely (standard <slot> semantics), so
    // it's never created at all — more robust than trying to hide it with
    // CSS after the fact, which risked interfering with how Safari
    // recognizes a real AR Quick Look trigger on iOS (see the
    // .furniture-ar-viewer comment in styles.css for what that broke).
    // This is inert filler content, not a real button — these viewers are
    // only ever triggered via .activateAR() from JS (activateFurnitureAR).
    const arButtonSlot = document.createElement("span");
    arButtonSlot.slot = "ar-button";
    el.appendChild(arButtonSlot);
    furnitureArViewers.appendChild(el);
  });
}

/* ---------- intro: parallax background ----------
   Mouse for desktop/browser preview; finger position for touchscreens (drag
   across the intro, image shifts opposite the mouse case). If neither ever
   fires, the image just stays centered, no error states, nothing else
   gated on this working. */
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

function handleTouch(event) {
  const touch = event.touches[0];
  if (!touch) return;
  setParallax((touch.clientX / window.innerWidth) * 2 - 1, (touch.clientY / window.innerHeight) * 2 - 1);
}

window.addEventListener("touchstart", handleTouch, { passive: true });
window.addEventListener("touchmove", handleTouch, { passive: true });

/* ---------- intro: story sequence ----------
   Auto-advancing narrative beats in a single reusable speech-bubble panel
   (.story-bubble, same visual recipe as .ar-caption / Speech bubble.png).
   Tapping the bubble skips the current wait immediately instead of making
   an impatient visitor sit through the full hold. */
const STORY_BEATS = [
  "You are one of 9,200 residents living in Westhagen.",
  "Walking through the square, you noticed something new: a cluster of wooden pallets that wasn't there before.",
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
  scrubbing = false;
  scrubStage = -1;
  lightboxOpen = false;
  pendingLevelEntry = null;
  resetLevelPin();
  // Defensive: normally already empty (the end-of-story reset clears it),
  // but guarantees a clean slate regardless of how chatbody got into
  // whatever state it was in before this particular start.
  chatbody().innerHTML = "";
  ensureScrollable();
  document.getElementById("storyProgress").classList.add("show");
  updateStoryProgress();
  fillViewport();
}

function resetToIntro() {
  revealIdx = 0;
  storyFinished = false;
  scrubbing = false;
  scrubStage = -1;
  lightboxOpen = false;
  pendingLevelEntry = null;
  resetLevelPin();
  POLL_STATE = {};
  activePollIndex = null;
  currentStage = 0;
  document.getElementById("storyProgress").classList.remove("show");
  updateStoryProgress();
  showIntro();
}

// The matching hidden viewer (see buildFurnitureArViewers) already has its
// src/ios-src set from page load, not from this click — so this only ever
// calls activateAR(), never touches attributes here. Setting src/ios-src
// and calling activateAR() in the same tap used to need a second tap
// before it would actually launch anything (model-viewer's internal
// AR-readiness state hadn't caught up to the same-tick attribute change).
function activateFurnitureAR(idx) {
  const el = furnitureArViewers.children[idx];
  if (el) el.activateAR();
}

// Restarts the "nobody's touched this screen in a while" timer — called on
// every tap inside the gallery (button or otherwise) so an actively browsing
// visitor is never cut off mid-decision, only one who's walked away.
function resetFurnitureIdleTimer() {
  clearTimeout(furnitureIdleTimer);
  furnitureIdleTimer = setTimeout(hideFurnitureGallery, FURNITURE_IDLE_TIMEOUT_MS);
}

function showFurnitureGallery() {
  furnitureGallery.classList.add("active");
  resetFurnitureIdleTimer();
}

// Reached either by the visitor tapping Done or by the idle timeout above —
// both lead to the same place, a clean intro screen for the next visitor.
function hideFurnitureGallery() {
  clearTimeout(furnitureIdleTimer);
  // The standalone furniture-only site (?furniture=1, its default landing
  // route) has no chat/kiosk "start" to return to - resetToIntro() would
  // reveal the full kiosk intro screen instead, background image (view.png)
  // and all, completely out of place here. Reload for a clean slate.
  if (new URLSearchParams(window.location.search).get("furniture") === "1") {
    window.location.reload();
    return;
  }
  furnitureGallery.classList.remove("active");
  resetToIntro();
}

furnitureDoneBtn.addEventListener("click", hideFurnitureGallery);
furnitureGallery.addEventListener("pointerdown", resetFurnitureIdleTimer);
document.querySelectorAll(".furniture-ar-btn").forEach((btn) => {
  btn.addEventListener("click", () => activateFurnitureAR(Number(btn.dataset.idx)));
});

/* ---------- AR panel ---------- */

function createViewer(stage) {
  const root = document.getElementById("viewer-root");
  root.innerHTML = "";

  viewer = document.createElement("model-viewer");
  viewer.setAttribute("src", withVersion(stage.glb));
  if (stage.arUsdz) viewer.setAttribute("ios-src", withVersion(stage.arUsdz));
  if (stage.poster) viewer.setAttribute("poster", withVersion(stage.poster));
  viewer.setAttribute("alt", `${stage.name || "3D model"} — preview`);
  viewer.setAttribute("ar", "");
  viewer.setAttribute("ar-modes", "webxr scene-viewer quick-look");
  viewer.setAttribute("ar-scale", "fixed");
  viewer.setAttribute("ar-placement", "floor");
  viewer.setAttribute("camera-controls", "");
  // Fixed angle (not "auto"), tuned by hand in-browser against stage-00 and
  // reused for every stage — all 4 stage models share nearly identical
  // bounding-box dimensions (same physical square, different design), so one
  // fixed orbit reads consistently across stage swaps instead of each model
  // picking its own "auto" angle/distance.
  viewer.setAttribute("camera-orbit", DEFAULT_CAMERA_ORBIT);
  // Panned by hand in-browser to this point rather than leaving it at the
  // model's own bounding-box center (model-viewer's default) — same
  // shared-across-all-4-stages reasoning as the fixed camera-orbit above.
  viewer.setAttribute("camera-target", DEFAULT_CAMERA_TARGET);
  // Narrower than model-viewer's 30deg default — flattens perspective
  // distortion for a cleaner architectural look.
  viewer.setAttribute("field-of-view", "20deg");
  // Without this, model-viewer silently enforces its own much-larger
  // "auto" minimum distance (a safety margin against clipping into the
  // model) whenever the narrow field-of-view above is combined with this
  // camera-target — any zoom-in tighter than ~123m was getting clamped
  // back out to that, no matter what radius was requested here or via
  // pinch/scroll. This explicitly opens that floor back up. Theta is also
  // constrained here (see max-camera-orbit below) — together these box in
  // how far a visitor can spin/zoom away from the tuned default view.
  viewer.setAttribute("min-camera-orbit", "-16.9deg auto 5m");
  // phi capped at 90deg (eye-level horizon) so visitors can't drag the
  // orbit down past horizontal and end up looking up at the model's
  // underside; model-viewer's own default phi range otherwise allows
  // swinging almost all the way underneath. Theta capped ±55deg either
  // side of the default 38.1deg (i.e. -16.9deg to 93.1deg, 110deg total,
  // paired with min-camera-orbit above) so the model can't be spun all
  // the way around. Radius capped at 1.2x the default 115.6m distance so
  // pinch/scroll zoom-out can't go further than that.
  viewer.setAttribute("max-camera-orbit", "93.1deg 90deg 138.7m");
  viewer.setAttribute("shadow-intensity", "1");
  viewer.setAttribute("shadow-softness", "0.75");
  viewer.setAttribute("loading", "eager");

  // Pause the story while the user is actually in AR, so it doesn't keep
  // revealing without them — resume exactly where it left off once they exit.
  viewer.addEventListener("ar-status", (event) => {
    if (event.detail.status === "session-started") {
      arPaused = true;
      updateScrollHint();
    } else if (event.detail.status === "not-presenting" || event.detail.status === "failed") {
      // "failed" (camera permission denied, tracking failure, Scene Viewer
      // intent failing to launch, etc.) is a dead end, not a transition
      // through "not-presenting" — model-viewer doesn't guarantee a
      // follow-up "not-presenting" event after it. Without handling it here
      // too, a failed AR launch left `src` permanently stuck on the
      // lightweight arGlb (set by the AR button handler below) instead of
      // reverting to the full-detail website model, since the swap-back
      // below never ran.
      //
      // Scene Viewer (Android) and in-page WebXR both launch AR using
      // whatever `src` is currently set — there's no separate Android-only
      // AR attribute in model-viewer, unlike ios-src for Quick Look. So the
      // AR button handler below temporarily points `src` at the stage's
      // simpler arGlb before activating AR; swap it back now that AR is done
      // so the inline view goes back to showing the full-detail model.
      if (arUsingSimpleModel) {
        viewer.src = withVersion(stageAt(currentStage).glb);
        arUsingSimpleModel = false;
        // The AR model's real-world (~1.8m) scale is wildly different from
        // the website model's own — re-apply the tuned camera explicitly
        // rather than leaving whatever model-viewer settled on while the
        // AR model was briefly loaded (see DEFAULT_CAMERA_ORBIT above).
        viewer.cameraOrbit = DEFAULT_CAMERA_ORBIT;
        viewer.cameraTarget = DEFAULT_CAMERA_TARGET;
      }
      if (arPaused) {
        arPaused = false;
        fillViewport();
      }
    }
  });

  // Pause the bounded auto-rotate (below) for a few seconds after the
  // visitor drags the model themselves, same "give it a rest, then resume"
  // feel as model-viewer's own auto-rotate-delay.
  viewer.addEventListener("camera-change", (event) => {
    if (event.detail.source !== "user-interaction") return;
    autoRotatePaused = true;
    clearTimeout(autoRotateResumeTimer);
    autoRotateResumeTimer = setTimeout(() => {
      autoRotatePaused = false;
      autoRotateLastFrameTime = null;
    }, AUTOROTATE_RESUME_DELAY_MS);
  });

  // TEMPORARY: disabled while re-finding the camera-target/angle by hand —
  // this loop was fighting live drag input, making rotation feel broken.
  // Re-enable once the new target/angle is settled.
  // requestAnimationFrame(stepAutoRotate);

  // Replace model-viewer's built-in AR button (an icon-only graphic that can
  // render as a blank/black shape if its internal asset fails to load) with
  // our own clearly-labeled button. Deliberately NOT using slot="ar-button" —
  // that slot auto-wires a click straight to activateAR(), which would launch
  // Scene Viewer/WebXR with whatever `src` the inline view currently has
  // (the full-detail model). Instead this button points `src` at the stage's
  // simpler arGlb first (if provided) so Android/WebXR AR shows the simple
  // model instead of the one on screen. Quick Look on iOS is unaffected
  // either way since it reads ios-src directly, never `src`. Positioning is
  // unaffected by leaving the named slot — `.ar-button`'s own
  // `position: absolute` (styles.css) already does the placement, not the slot.
  const arButton = document.createElement("button");
  arButton.className = "ar-button";
  arButton.textContent = "View in Your Space";
  arButton.addEventListener("click", () => {
    const stageNow = stageAt(currentStage);
    if (stageNow.arGlb) {
      arUsingSimpleModel = true;
      viewer.src = withVersion(stageNow.arGlb);
    }
    // activateAR() is called immediately rather than waiting for the arGlb
    // swap above to finish loading — Quick Look (iOS) never reads `src` at
    // all, and Scene Viewer (Android) only needs it as a URL string handed
    // to a separate native app that downloads the file itself, so neither
    // needs it pre-loaded into this page's own scene first. Waiting on a
    // "load" event here used to add a multi-second delay before AR could
    // even open, worst of all on iOS where the wait bought nothing.
    viewer.activateAR();
  });
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

// Drives the bounded auto-rotate described above createViewer — reads the
// viewer's current orbit, nudges theta by elapsed time, bounces the
// direction at either limit, and writes it back. Runs continuously (one
// requestAnimationFrame loop started once in createViewer); arPaused/
// autoRotatePaused just make each tick a no-op rather than the loop
// stopping and needing to be restarted.
function stepAutoRotate(now) {
  requestAnimationFrame(stepAutoRotate);
  if (!viewer || arPaused || autoRotatePaused) {
    autoRotateLastFrameTime = null;
    return;
  }
  if (autoRotateLastFrameTime == null) {
    autoRotateLastFrameTime = now;
    return;
  }
  const dt = (now - autoRotateLastFrameTime) / 1000;
  autoRotateLastFrameTime = now;

  const orbit = viewer.getCameraOrbit();
  let thetaDeg = (orbit.theta * 180) / Math.PI + autoRotateDirection * AUTOROTATE_SPEED_DEG_PER_SEC * dt;
  if (thetaDeg >= AUTOROTATE_MAX_THETA_DEG) {
    thetaDeg = AUTOROTATE_MAX_THETA_DEG;
    autoRotateDirection = -1;
  } else if (thetaDeg <= AUTOROTATE_MIN_THETA_DEG) {
    thetaDeg = AUTOROTATE_MIN_THETA_DEG;
    autoRotateDirection = 1;
  }
  const phiDeg = (orbit.phi * 180) / Math.PI;
  viewer.cameraOrbit = `${thetaDeg}deg ${phiDeg}deg ${orbit.radius}m`;
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

// Warm the cache for the *current* stage's AR files too, so tapping
// "View AR" doesn't stall on a cold fetch before AR can launch. Both
// formats, not just arGlb — iOS Quick Look reads arUsdz directly (never
// arGlb/`src`, see the AR button handler in createViewer), so without this
// a visitor's first AR tap on iOS still hit a cold multi-MB fetch despite
// the arGlb-only preload here doing nothing for that platform at all.
const preloadedArStages = new Set();
function preloadArGlb(i) {
  const stage = stageAt(i);
  if (!stage || preloadedArStages.has(i)) return;
  preloadedArStages.add(i);
  if (stage.arGlb) fetch(withVersion(stage.arGlb)).catch(() => {});
  if (stage.arUsdz) fetch(withVersion(stage.arUsdz)).catch(() => {});
}

function applyStage(i) {
  currentStage = Math.max(0, Math.min(i, STAGES.length - 1));
  showStageInViewer(currentStage);
}

// Updates the 3D viewer/poster to a given stage without touching the live
// progress pointer (currentStage), used both by applyStage for normal
// forward playback and directly by scroll-scrub sync below, which previews
// an already-revealed earlier stage while the visitor scrolls back through
// chat history without derailing where revealing resumes from.
function showStageInViewer(i) {
  const stage = stageAt(i);
  if (!stage) return;

  // Stages without a model yet keep whichever model is already showing —
  // the chat picture (poster) still advances regardless, so playback never
  // looks broken just because a later stage's AR model hasn't been dropped in yet.
  if (!stage.glb) return;

  preloadStage(i + 1);
  preloadArGlb(i);

  if (!viewer) {
    createViewer(stage);
    return;
  }

  viewer.src = withVersion(stage.glb);
  arUsingSimpleModel = false;
  if (stage.arUsdz) viewer.setAttribute("ios-src", withVersion(stage.arUsdz));
  else viewer.removeAttribute("ios-src");
  if (stage.poster) viewer.setAttribute("poster", withVersion(stage.poster));
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
  // Stacked mobile layout: the phone sits below the AR panel, not over its
  // right edge, so there's no footprint to carve out — undo any padding
  // left over from a wider layout instead of squishing the model for
  // nothing.
  if (MOBILE_STACK_QUERY.matches) {
    root.style.paddingRight = "";
    return;
  }
  const phoneWidth = phone.getBoundingClientRect().width;
  root.style.paddingRight = phoneWidth ? `${phoneWidth + 24}px` : "";
}

window.addEventListener("resize", centerViewerAroundVisibleArea);

// Centered over the AR area's actual visible width — the space left of the
// floating phone panel, not the full split-screen width — same "visible
// area" reasoning as centerViewerAroundVisibleArea above, at 2/3 of it.
function positionStoryProgress() {
  const bar = document.getElementById("storyProgress");
  const phone = document.querySelector(".phone-wrap");
  const panel = document.getElementById("ar-panel");
  if (!bar || !phone || !panel) return;
  // Stacked mobile layout: the phone sits below the AR panel rather than
  // beside it, so its left edge no longer marks the AR area's visible
  // width — using it anyway (as the desktop math below does) shrinks the
  // bar down to whatever sliver of centering margin the phone happens to
  // have, in the top-left corner. Center it across the panel's own width
  // instead, falling back on the CSS default (left: 50%; width: 60%) via
  // the translateX(-50%) that's already on .story-progress.
  if (MOBILE_STACK_QUERY.matches) {
    const panelWidth = panel.getBoundingClientRect().width;
    bar.style.left = `${panelWidth / 2}px`;
    bar.style.width = `${panelWidth * 0.6}px`;
    return;
  }
  const visibleWidth = phone.getBoundingClientRect().left;
  const barWidth = (visibleWidth * 2) / 3;
  bar.style.left = `${visibleWidth / 2}px`;
  bar.style.width = `${barWidth}px`;
}

window.addEventListener("resize", positionStoryProgress);
positionStoryProgress();

// Continuous fill between the 6 level circles. Defaults to revealIdx (how
// far the story has actually progressed), but a scrubbing visitor scrolled
// back through history sees the bar preview that earlier point instead —
// see syncStoryProgressToScrollPosition — the same "preview without
// disturbing where forward revealing resumes from" split already used for
// the 3D model (showStageInViewer vs. applyStage). A level's anchor row
// counts as reached once idx > that level's anchorIndex — see the
// pendingLevelEntry handoff in revealNext, where revealIdx is already
// incremented past the anchor by the time its card is shown.
function updateStoryProgress(idx) {
  const targetIdx = idx != null ? idx : revealIdx;
  const fill = document.getElementById("storyProgressFill");
  const steps = document.querySelectorAll(".story-progress-step");
  if (!fill || !steps.length || !LEVEL_ANCHORS.length) return;

  const segments = LEVEL_ANCHORS.length - 1;
  const lastAnchor = LEVEL_ANCHORS[LEVEL_ANCHORS.length - 1];
  let percent = 0;
  if (targetIdx > lastAnchor) {
    percent = 100;
  } else if (targetIdx > LEVEL_ANCHORS[0]) {
    for (let i = 0; i < segments; i++) {
      const start = LEVEL_ANCHORS[i];
      const end = LEVEL_ANCHORS[i + 1];
      if (targetIdx <= end) {
        percent = ((i + (targetIdx - start) / (end - start)) / segments) * 100;
        break;
      }
    }
  }
  fill.style.width = `${percent}%`;

  steps.forEach((step, i) => {
    const reached = targetIdx > LEVEL_ANCHORS[i];
    const nextReached = LEVEL_ANCHORS[i + 1] != null && targetIdx > LEVEL_ANCHORS[i + 1];
    step.classList.toggle("complete", reached && nextReached);
    step.classList.toggle("current", reached && !nextReached);
  });
}

// Mirrors stageForScrollPosition (same [data-*] + vertical-middle-of-chat
// technique) but for message index rather than stage, so the progress bar
// can preview whichever chapter a scrubbing visitor has scrolled back to.
function messageIndexForScrollPosition(el) {
  const markers = el.querySelectorAll("[data-msg-index]");
  const referenceY = el.getBoundingClientRect().top + el.clientHeight / 2;
  let target = 0;
  for (const marker of markers) {
    if (marker.getBoundingClientRect().top <= referenceY) {
      target = Number(marker.dataset.msgIndex);
    } else {
      break;
    }
  }
  return target;
}

// The nudge caption should read as bridging the AR scene and the phone —
// its right edge tucked under the phone's left edge — rather than sitting
// in a fixed screen corner unrelated to where the floating phone actually
// is. Positioned from JS (like centerViewerAroundVisibleArea above) since
// the phone's on-screen position depends on viewport size and isn't a
// fixed CSS offset.
function positionArCaption() {
  const caption = document.getElementById("arCaption");
  const phone = document.querySelector(".phone-wrap");
  const panel = document.getElementById("ar-panel");
  if (!caption || !phone || !panel) return;
  // Stacked mobile layout: the phone sits below the AR panel instead of
  // floating over its right edge, so there's no shared edge left to "tuck"
  // the caption under — the window-relative math below assumes the AR
  // panel spans the full viewport, which is only true for the overlay
  // layout. Just center the caption near the panel's own bottom instead.
  if (MOBILE_STACK_QUERY.matches) {
    const panelRect = panel.getBoundingClientRect();
    caption.style.left = "auto";
    caption.style.right = `${Math.max(8, (panelRect.width - caption.offsetWidth) / 2)}px`;
    caption.style.top = "auto";
    caption.style.bottom = "16px";
    return;
  }
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

// Each level pop-up gets its own cloned card (see handleLevelPopup) instead
// of one reused element — { el, anchorRow, reposition } per card still
// tracked, in the order they appeared, so a resize repositions all of them
// (not just the newest) and resetLevelPin can tear all of them down.
let activeLevelCards = [];

window.addEventListener("resize", () => {
  positionArCaption();
  activeLevelCards.forEach(({ el, anchorRow }) => positionLevelCaption(el, anchorRow));
  updateLevelCardVisibility();
});
positionArCaption();

// Removes every still-tracked level card and its scroll listener — called
// at the start of a fresh visitor's session so a previous visitor's pinned
// cards don't carry over (see startExperience/resetToIntro). Cards are
// still fully torn down here (unlike updateLevelCardVisibility's mid-session
// show/hide toggling) since a new session has nothing to scroll back to.
function resetLevelPin() {
  activeLevelCards.forEach(({ el, anchorRow, reposition }) => {
    if (anchorRow) chatbody().removeEventListener("scroll", reposition);
    el.remove();
  });
  activeLevelCards = [];
}

// The fixed floor a pinned level card's top can never rise above — see
// positionLevelCaption. Pulled out so updateLevelCardVisibility can check
// the same value without recomputing its own (possibly-drifted) copy.
function levelPinFloorTop() {
  const headerRect = document.querySelector(".waheader")?.getBoundingClientRect();
  return Math.max(16, (headerRect ? headerRect.bottom : 0) + 16);
}

// Once a *later* level's card has scrolled up far enough to visually
// overlap whichever earlier card is already sitting at (or near) the
// pinned floor, that earlier card is hidden (not removed: scrolling back
// up moves the later card back down and off it again, which brings the
// earlier one right back, same as the visitor would expect flipping back
// through physical chapter markers). Re-evaluated from scratch on every
// scroll/resize, so it naturally runs in reverse too — nothing here assumes
// forward-only progress. Checks actual bounding-rect overlap rather than
// each card's top exactly equalling the floor value — two independently
// computed getBoundingClientRect() calls can differ by a hair even when
// both are visually pinned at the same spot, which made an exact-equality
// check flicker on real (not synthetic, single-jump) scroll input instead
// of cleanly replacing. Keeps only the most recently created card among any
// group currently overlapping visible; every other one just gets its own
// "show" toggled instead of being torn down.

// A card whose own bottom edge has reached the visible *chat area*'s bottom
// edge (the phone's own screen, not the whole page — the phone floats in
// the middle of a much taller viewport, so comparing against window height
// would essentially never trigger) hides right there, rather than sliding
// any further down and off — positionLevelCaption's now-top-only clamp
// would otherwise let it follow its row all the way down past the visible
// area with nothing stopping it, clipping out through the bottom edge
// instead of disappearing cleanly at it.
function isCardPastChatBottom(card) {
  const cardRect = card.el.getBoundingClientRect();
  const chatRect = chatbody().getBoundingClientRect();
  return cardRect.bottom >= chatRect.bottom;
}

function updateLevelCardVisibility() {
  const overlaps = (a, b) => a.top < b.bottom && a.bottom > b.top;
  activeLevelCards.forEach((card, i) => {
    const rect = card.el.getBoundingClientRect();
    const coveredByLater = activeLevelCards
      .slice(i + 1)
      .some((later) => overlaps(rect, later.el.getBoundingClientRect()));
    const pastBottom = isCardPastChatBottom(card);
    card.el.classList.toggle("show", !coveredByLater && !pastBottom);
  });
}

// Every rendered chat row is tagged with its MESSAGES array index (see
// renderEntry) so a level pop-up can be pinned to a specific already-
// revealed message instead of always sitting at a fixed spot.
function findRowByIndex(idx) {
  return chatbody().querySelector(`[data-msg-index="${idx}"]`);
}

// Same horizontal tuck as positionArCaption, but the vertical offset
// tracks a specific chat row's on-screen height instead of always sitting
// near the phone's bottom edge — used by level pop-ups that declare an
// entry.anchorIndex. Falls back to a fixed spot below the header if the
// anchor row isn't found (e.g. anchorIndex omitted, or not yet rendered).
// Pulled in further than positionArCaption's own tuck: at that anchor
// height a full 36px reaches past the chat's left padding and into the
// avatar column, covering it. A card can land at any row (not just a
// fixed bottom spot), so it needs the extra clearance every time.
function positionLevelCaption(caption, anchorRow) {
  const phone = document.querySelector(".phone-wrap");
  const panel = document.getElementById("ar-panel");
  if (!caption || !phone || !panel) return;
  // Same reasoning as positionArCaption's mobile branch: a specific chat
  // row's on-screen height, and the phone's left edge, are only meaningful
  // to position against when the caption and the chat share the same
  // visual space (the overlay layout) — in the stacked layout they're in
  // separate boxes. Park every card at the same fixed spot near the
  // panel's own bottom instead; updateLevelCardVisibility's overlap check
  // already collapses multiple simultaneously-active cards down to just
  // the most recent one, so sharing one spot here doesn't lose anything on
  // a phone screen that can only show one at a time anyway.
  if (MOBILE_STACK_QUERY.matches) {
    const panelRect = panel.getBoundingClientRect();
    caption.style.left = "auto";
    caption.style.right = `${Math.max(8, (panelRect.width - caption.offsetWidth) / 2)}px`;
    caption.style.top = "auto";
    caption.style.bottom = "16px";
    return;
  }
  const phoneRect = phone.getBoundingClientRect();
  const overlap = 15; // px — clear of the avatar column (positionArCaption uses 36)
  caption.style.left = "auto";
  caption.style.right = `${Math.max(8, window.innerWidth - phoneRect.left - overlap)}px`;

  // A pinned card can end up riding all the way to this floor once its
  // anchor row scrolls far enough out of view — keep that floor below the
  // phone's own green WhatsApp-style header bar rather than the plain 16px
  // viewport-top margin used elsewhere, so a long-pinned card never rises
  // past/behind it (this is also what lets a later level's card visually
  // scroll up and cover an earlier, still-pinned one at that same floor —
  // see updateLevelCardVisibility, which hides the covered one accordingly).
  const minTop = levelPinFloorTop();

  // No anchorIndex (rare — entry.anchorIndex omitted): sit near the top
  // rather than reusing positionArCaption's spot, which belongs solely to
  // the separate reply-prompt element (#arCaption).
  if (!anchorRow) {
    caption.style.bottom = "auto";
    caption.style.top = `${minTop}px`;
    return;
  }

  const rowRect = anchorRow.getBoundingClientRect();
  const centerY = rowRect.top + rowRect.height / 2;
  const captionHeight = caption.offsetHeight;
  // Only clamped at the top (the pinned floor) — deliberately *not* also
  // clamped at the bottom. A bottom clamp would hold the card stuck at the
  // screen's bottom edge once its anchor row scrolls back down out of view
  // while scrolling back through history, instead of letting it disappear
  // there (see updateLevelCardVisibility's off-screen check) the same way
  // it wasn't shown yet before the visitor had scrolled forward that far.
  const top = Math.max(minTop, centerY - captionHeight / 2);
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
  if (entry.sender === "Marktplatz" && entry.role) return `Marktplatz (${entry.role.toLowerCase()})`;
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
    const poster = stage && stage.poster ? withVersion(stage.poster) : "";
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.msgIndex = i;
    // Marks where this stage begins in the chat log, so scroll-scrub sync
    // (below) can tell which stage a given scroll position corresponds to.
    row.dataset.stageMarker = currentStage;
    row.innerHTML = `
      ${avatarHTML(entry)}
      <div class="img-msg-bubble" style="${bubbleStyleFor(entry)}">
        <div class="name" style="color:${nameColorFor(entry)};">${displayName(entry)}</div>
        <div class="img-wrap">
          <img src="${poster}" alt="${entry.caption || "shared image"}">
          <span class="img-time">${entry.time || ""}</span>
        </div>
      </div>`;
    row.querySelector(".img-wrap img").addEventListener("click", () => openImageLightbox(poster));
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
        <div class="file-card${entry.previewImage ? " has-preview" : ""}">
          <div class="file-icon"><i class="ti ti-file-type-pdf"></i></div>
          <div class="file-meta">
            <div class="file-name">${entry.fileName || "document.pdf"}</div>
            <div class="file-sub">${entry.fileSub || "PDF document"}</div>
          </div>
        </div>
        <span class="time">${entry.time || ""}</span>
      </div>`;
    // Same tap-to-enlarge lightbox as shared chat images, keyed off an
    // optional preview image instead of the PDF itself — visitors can't
    // open a real PDF on the kiosk, but a rendered preview gives them
    // something to actually look at.
    if (entry.previewImage) {
      row.querySelector(".file-card").addEventListener("click", () => openImageLightbox(entry.previewImage));
    }
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

// Consumed once by whichever typing beat comes next — set whenever a
// userPrompt resolves (see handleUserPrompt's finish/finishChoice),
// regardless of path (Skip, a choice with no reply defined, a keyword
// fallback, etc.), so the transition back into the story never sits
// through a long word-count-scaled pause right after a visitor's own
// interaction — right there, it reads as the app stalling rather than
// pacing, even though the exact same duration is unremarkable mid-story.
function nextTypingDuration(entry, inIntro) {
  const full = pacedDuration(typingDuration(entry, inIntro));
  if (fastForwardNextTyping) {
    fastForwardNextTyping = false;
    return Math.min(full, 900);
  }
  return full;
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
   The prompt stays open indefinitely — nothing times it out on its own.
   Only an explicit tap on Skip, or sending/tapping a reply, resolves it. */
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

    // Renders Marktplatz's follow-up (if any) after a typing beat, then
    // resolves — shared by both the choice and keyword-bucket paths so the
    // reply always appears as part of the same interaction, not gated
    // behind a further scroll. Duration goes through nextTypingDuration, so
    // it's fast-forwarded whenever finish/finishChoice just set that flag —
    // which is every resolution path, not just Skip (see their own comments).
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
        await showTyping(replyEntry, nextTypingDuration(replyEntry, false));
        renderEntry(revealIdx, replyEntry);
      }
      resolve();
    }

    function finish(text) {
      if (settled) return;
      settled = true;
      // A visitor who just resolved a prompt (Skip, a plain typed reply, a
      // keyword match/fallback) has signaled they're done with it — whatever
      // typing beat comes next (this reply, or otherwise the next entry in
      // the script once revealNext continues) shouldn't sit through the
      // full word-count-scaled pause used mid-story, or it reads as the app
      // stalling right when the visitor is waiting for a response.
      fastForwardNextTyping = true;
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
      } else if (entry.skipReply) {
        // Skip (no text at all) still gets a Marktplatz follow-up if the
        // entry defines one — distinct from fallbackReply, which only fires
        // once the visitor has actually typed something that matched no bucket.
        settleWithReply(entry.skipReply);
        return;
      }
      resolve();
    }

    function finishChoice(option) {
      if (settled) return;
      settled = true;
      // See the matching comment in finish() — applies just the same to a
      // tapped choice, reply or not (e.g. an option with no reply defined).
      fastForwardNextTyping = true;
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
   EXPERIMENTAL (2026-07-10, per Mareike's Betreuer, not yet decided on):
   each level gets its own cloned card (from #levelPinTemplate, same
   .ar-caption/.level-mode visuals as #arCaption below), purely passive —
   no tap interaction, doesn't pause the story (revealNext just fires this
   and keeps going). It appears in sync with its anchor row and stays
   pinned in place as the chat keeps scrolling, while a *later* level's card
   is a separate instance tracking its own (lower, not-yet-scrolled-past)
   anchor row. Both stay visible until further scrolling carries the newer
   one up far enough to reach the shared pinned-floor position (see
   positionLevelCaption) and visually cover the older one — at that point
   updateLevelCardVisibility hides the now-covered card, and un-hides it
   again if the visitor scrolls back down past that point, so scrolling
   back through the story shows the level cards in reverse too, not just
   forward. entry.anchorIndex, if set, pins the card's height to that
   already-revealed message's row instead of the default fixed spot. */
function handleLevelPopup(entry) {
  const template = document.getElementById("levelPinTemplate");
  const caption = template.content.firstElementChild.cloneNode(true);
  document.getElementById("ar-panel").appendChild(caption);
  const captionText = caption.querySelector(".level-pin-text");
  const captionLevelNum = caption.querySelector(".level-pin-num");
  const captionLevelTitle = caption.querySelector(".level-pin-title");

  const anchorRow = entry.anchorIndex != null ? findRowByIndex(entry.anchorIndex) : null;

  updatePhoneClock(entry);
  captionLevelNum.textContent = `Level ${entry.level}`;
  captionLevelTitle.textContent = entry.title;
  captionText.textContent = entry.text;
  positionLevelCaption(caption, anchorRow);
  caption.classList.add("show");
  vibrate(40);
  // Jump the progress bar to this chapter the moment the card appears —
  // revealIdx is already past this level's anchorIndex by now (incremented
  // in revealNext just before this runs), so the default (no-arg) call
  // already reflects it.
  updateStoryProgress();

  // The visitor keeps scrolling the chat underneath the card as it's
  // pinned (forward or back) — keep it level with its anchor row as that
  // happens, instead of leaving it stranded at the height the row happened
  // to be at when the card first appeared.
  let repositionQueued = false;
  const reposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      positionLevelCaption(caption, anchorRow);
      updateLevelCardVisibility();
    });
  };
  if (anchorRow) chatbody().addEventListener("scroll", reposition, { passive: true });
  activeLevelCards.push({ el: caption, anchorRow, reposition });
  updateLevelCardVisibility();
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

// A visitor who has just read the latest message and stopped scrolling
// naturally lands within a few dozen px of the true bottom — well short of
// the invisible #reveal-spacer's full 220px — so isNearBottom's tight 64px
// threshold sat right on the edge of that resting point (measured as low as
// 65px in practice) and could tip either way depending on message length,
// making the scroll-scrub listener below flag a visitor as "scrubbing away
// from live" and pause further reveals even though they hadn't scrolled
// backward at all. This threshold is deliberately much more generous, purely
// to tell "actually scrolled back into history" apart from "just caught up".
function isFarFromLive(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight > 200;
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
    !scrubbing &&
    !lightboxOpen &&
    !replyKeyboardOpen &&
    revealIdx < MESSAGES.length &&
    el.scrollHeight > el.clientHeight + 4 &&
    !isNearBottom(el);
  hint.classList.toggle("show", waiting);
}

// Plays the typing beat (or the short date/system/event pause) and renders
// one entry — the single per-entry reveal step used by the normal
// sequential loop below.
async function revealPlainEntry(idx, entry, inIntro) {
  if (entry.type === "date" || entry.type === "system" || entry.type === "event") {
    renderEntry(idx, entry);
    await waitOrSkip(pacedDuration(inIntro ? PACE.introShortPause : PACE.shortPause));
  } else {
    await showTyping(entry, nextTypingDuration(entry, inIntro));
    renderEntry(idx, entry);
  }
}

async function revealNext() {
  if (revealing || arPaused || storyFinished || scrubbing || lightboxOpen) return;

  if (revealIdx >= MESSAGES.length) {
    storyFinished = true;
    updateScrollHint();
    await sleep(PACE.loopEndPause);
    chatbody().classList.add("fade-out");
    await sleep(PACE.fadeOut);
    chatbody().classList.remove("fade-out");
    chatbody().innerHTML = "";
    // Level cards track anchor rows that just got wiped out above — without
    // this, a still-pinned card (e.g. the last level reached) keeps its
    // scroll/resize listeners live against a now-detached row for as long as
    // the furniture gallery is up (up to FURNITURE_IDLE_TIMEOUT_MS), and any
    // reposition in the meantime computes a bogus position from that
    // detached row's now-zeroed bounding rect — visible as the card jumping
    // to some other spot before the next visitor's session even starts.
    resetLevelPin();
    // Each playthrough is one visitor's session, so this doesn't silently
    // loop back to the intro and hand the next person the previous
    // visitor's name — instead it shows the furniture AR gallery first;
    // that screen itself calls resetToIntro() once the visitor taps Done
    // or walks away (see showFurnitureGallery/hideFurnitureGallery above).
    showFurnitureGallery();
    return;
  }

  revealing = true;
  const entry = MESSAGES[revealIdx];

  // Level markers carry no visible row of their own, so passing over one
  // costs the visitor no extra scroll — remember it and keep going
  // immediately. Its card only shows once its anchorIndex is actually
  // reached below, through the exact same one-at-a-time, scroll-gated
  // flow as everything else, so it never jumps several messages ahead of
  // where the visitor has actually scrolled to, and needs no re-centering
  // scroll of its own — the anchor row is already on-screen right where it
  // just rendered.
  if (entry.type === "level") {
    pendingLevelEntry = entry;
    revealIdx++;
    revealing = false;
    ensureScrollable();
    updateScrollHint();
    updateStoryProgress();
    requestAnimationFrame(fillViewport);
    return;
  }

  const inIntro = firstImageIdx === -1 || revealIdx < firstImageIdx;

  if (entry.type === "userPrompt") {
    await handleUserPrompt(entry);
  } else {
    await revealPlainEntry(revealIdx, entry, inIntro);
  }

  const revealedIdx = revealIdx;
  revealIdx++;

  if (pendingLevelEntry && pendingLevelEntry.anchorIndex === revealedIdx) {
    const levelEntry = pendingLevelEntry;
    pendingLevelEntry = null;
    handleLevelPopup(levelEntry); // no longer pauses the story — see its own comment
  }

  revealing = false;
  ensureScrollable();
  updateScrollHint();
  updateStoryProgress();
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
  if (revealing || arPaused || storyFinished || scrubbing || lightboxOpen) return;
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

/* ---------- chat: scroll-scrub sync ----------
   The reveal system above only ever moves forward (revealIdx never
   decreases), so scrolling back up through already-revealed history just
   lets a visitor re-read it, nothing re-syncs the 3D model to match. This
   listener adds that: scrolling away from the live bottom edge pauses
   revealing (scrubbing joins arPaused/storyFinished in the guards above)
   and syncs the viewer to whichever stage's image message is currently in
   view, using each stage-transition row's data-stage-marker (set in
   renderEntry). Scrolling back to the bottom snaps the viewer back to the
   true live stage and lets fillViewport resume normal revealing. */
let scrollSyncQueued = false;

// Of all stage markers scrolled to/past the vertical middle of the chat
// panel, the last one (highest stage) is the "current" stage for that
// scroll position, markers are in ascending DOM/stage order, so the loop
// can stop at the first marker that hasn't been reached yet.
function stageForScrollPosition(el) {
  const markers = el.querySelectorAll("[data-stage-marker]");
  const referenceY = el.getBoundingClientRect().top + el.clientHeight / 2;
  let target = 0;
  for (const marker of markers) {
    if (marker.getBoundingClientRect().top <= referenceY) {
      target = Number(marker.dataset.stageMarker);
    } else {
      break;
    }
  }
  return target;
}

function syncStageToScrollPosition() {
  const target = stageForScrollPosition(chatbody());
  if (target !== scrubStage) {
    scrubStage = target;
    showStageInViewer(target);
  }
  updateStoryProgress(messageIndexForScrollPosition(chatbody()));
}

chatbody().addEventListener(
  "scroll",
  () => {
    const el = chatbody();
    if (!isFarFromLive(el)) {
      if (scrubbing) {
        scrubbing = false;
        scrubStage = -1;
        showStageInViewer(currentStage); // snap back to the live stage
        updateScrollHint();
        updateStoryProgress(); // snap the progress bar back too, live revealIdx
        fillViewport();
      }
      return;
    }

    if (!scrubbing) {
      scrubbing = true;
      updateScrollHint();
    }

    if (scrollSyncQueued) return;
    scrollSyncQueued = true;
    requestAnimationFrame(() => {
      scrollSyncQueued = false;
      syncStageToScrollPosition();
    });
  },
  { passive: true }
);

/* ---------- chat: tap-to-enlarge shared images ----------
   Opens inside the phone screen (the lightbox is a child of .screen, which
   clips overflow) rather than covering the whole page. Pauses revealing the
   same way AR/scroll-scrub do, so new messages don't appear underneath
   while a visitor is looking at the photo. Pinch (two touches) or a
   double-tap/double-click zooms further into the enlarged image itself;
   dragging while zoomed in pans around it. */
const imageLightbox = document.getElementById("imageLightbox");
const imageLightboxImg = document.getElementById("imageLightboxImg");

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_DOUBLE_TAP = 2.5;
const zoomState = { scale: 1, x: 0, y: 0 };

function applyZoomTransform() {
  imageLightboxImg.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
}

function resetZoom() {
  zoomState.scale = 1;
  zoomState.x = 0;
  zoomState.y = 0;
  applyZoomTransform();
}

function openImageLightbox(src) {
  imageLightboxImg.src = src;
  resetZoom();
  imageLightbox.classList.remove("hidden");
  requestAnimationFrame(() => imageLightbox.classList.add("show"));
  lightboxOpen = true;
  updateScrollHint();
}

function closeImageLightbox() {
  if (!lightboxOpen) return;
  imageLightbox.classList.remove("show");
  lightboxOpen = false;
  setTimeout(() => imageLightbox.classList.add("hidden"), 200);
  updateScrollHint();
  fillViewport();
}

imageLightbox.addEventListener("click", (event) => {
  if (event.target === imageLightbox || event.target.id === "imageLightboxClose") closeImageLightbox();
});

// Tracks active pointers by id so pinch works from two simultaneous
// touches, Pointer Events fire per finger, not as a single gesture.
const activeLightboxPointers = new Map();
let pinchStartDist = 0;
let pinchStartScale = 1;
let panStart = null;
let lastTapAt = 0;

function lightboxPointerDistance() {
  const pts = [...activeLightboxPointers.values()];
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

imageLightboxImg.addEventListener("pointerdown", (event) => {
  imageLightboxImg.setPointerCapture(event.pointerId);
  activeLightboxPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (activeLightboxPointers.size === 2) {
    pinchStartDist = lightboxPointerDistance();
    pinchStartScale = zoomState.scale;
    panStart = null;
    return;
  }

  const now = Date.now();
  if (now - lastTapAt < 300) {
    lastTapAt = 0;
    const rect = imageLightboxImg.getBoundingClientRect();
    const tapX = event.clientX - rect.left - rect.width / 2;
    const tapY = event.clientY - rect.top - rect.height / 2;
    if (zoomState.scale > 1) {
      resetZoom();
    } else {
      zoomState.scale = ZOOM_DOUBLE_TAP;
      zoomState.x = -tapX * (ZOOM_DOUBLE_TAP - 1);
      zoomState.y = -tapY * (ZOOM_DOUBLE_TAP - 1);
      applyZoomTransform();
    }
  } else {
    lastTapAt = now;
    if (zoomState.scale > 1) {
      panStart = { x: event.clientX, y: event.clientY, originX: zoomState.x, originY: zoomState.y };
    }
  }
});

imageLightboxImg.addEventListener("pointermove", (event) => {
  if (!activeLightboxPointers.has(event.pointerId)) return;
  activeLightboxPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (activeLightboxPointers.size === 2) {
    const dist = lightboxPointerDistance();
    zoomState.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchStartScale * (dist / pinchStartDist)));
    applyZoomTransform();
  } else if (panStart) {
    zoomState.x = panStart.originX + (event.clientX - panStart.x);
    zoomState.y = panStart.originY + (event.clientY - panStart.y);
    applyZoomTransform();
  }
});

function endLightboxPointer(event) {
  activeLightboxPointers.delete(event.pointerId);
  if (activeLightboxPointers.size < 2) pinchStartDist = 0;
  if (activeLightboxPointers.size === 0) panStart = null;
  if (zoomState.scale <= 1.02) resetZoom();
}
imageLightboxImg.addEventListener("pointerup", endLightboxPointer);
imageLightboxImg.addEventListener("pointercancel", endLightboxPointer);

/* ---------- init ---------- */

Promise.all([loadJSON("stages.json"), loadJSON("messages.json"), loadJSON("furniture.json")])
  .then(([stages, messages, furniture]) => {
    STAGES = stages;
    RAW_MESSAGES = messages;
    MESSAGES = messages;
    FURNITURE = furniture;
    buildFurnitureArViewers();
    firstImageIdx = MESSAGES.findIndex((m) => m.type === "image");
    LEVEL_ANCHORS = MESSAGES.filter((m) => m.type === "level").map((m) => m.anchorIndex);
    // A separate QR code (e.g. a standalone sign near the furniture, not
    // part of the kiosk's own chat flow) can link straight to ?furniture=1
    // to land directly on the AR gallery, skipping the name-entry/chat
    // story entirely — no separate site needed for that, just this param.
    // Deliberately skips the applyStage(0) preload below in that case: it
    // downloads the (unrelated, heavier) square-model file for nothing if
    // a visitor's only reason for being here is browsing furniture; it
    // still initializes lazily via showStageInViewer's own `if (!viewer)`
    // guard the first time they actually tap Start for the real chat.
    if (new URLSearchParams(window.location.search).get("furniture") === "1") {
      introOverlay.classList.add("hidden");
      showFurnitureGallery();
      return;
    }
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
