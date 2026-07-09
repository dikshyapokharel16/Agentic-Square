// Bumped whenever an ARmodels/furniture/*/model.{glb,usdz} file is
// regenerated, so devices that already cached the old file under its
// unchanged URL (see vercel.json's max-age=3600) don't keep serving it.
const MODEL_VERSION = "1";

function withVersion(url) {
  return url ? `${url}?v=${MODEL_VERSION}` : url;
}

const furnitureArViewers = document.getElementById("furnitureArViewers");

// One hidden <model-viewer> per piece, src/ios-src set here (once
// furniture.json loads) rather than at click time - setting them in the
// same tap as calling activateAR() needs two taps, since model-viewer's
// internal AR-readiness state hasn't caught up to a same-tick attribute
// change yet.
fetch("furniture.json")
  .then((res) => res.json())
  .then((furniture) => {
    furniture.forEach((item) => {
      const el = document.createElement("model-viewer");
      el.className = "furniture-ar-viewer";
      el.setAttribute("ar", "");
      el.setAttribute("ar-modes", "webxr scene-viewer quick-look");
      if (item.arGlb) el.setAttribute("src", withVersion(item.arGlb));
      if (item.arUsdz) el.setAttribute("ios-src", withVersion(item.arUsdz));
      furnitureArViewers.appendChild(el);
    });
  })
  .catch((error) => {
    console.error("Could not load furniture.json:", error);
  });

document.querySelectorAll(".furniture-ar-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const el = furnitureArViewers.children[Number(btn.dataset.idx)];
    if (el) el.activateAR();
  });
});
