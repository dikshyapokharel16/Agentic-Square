// Post-process an already-scaled stage .glb down to something iOS Safari can
// actually hold on the GPU. fix-glb-scale.mjs's simplify pass (ratio 0.5,
// error 0.001) never really bit on the SketchUp exports: the error budget is
// so strict meshoptimizer bails almost immediately, and SketchUp geometry
// arrives unwelded (every face owns its own vertices), which blocks collapse
// across seams entirely — stages 01-03 came out of that pipeline still at
// ~1.5M vertices and 4,600-7,800 primitives (= draw calls). That's the root
// cause of the iOS black-texture failures: each 2048px texture is ~21MB
// decompressed on the GPU, and 7-9 of those plus ~50MB of vertex buffers
// blows iPad Safari's WebGL memory budget, which fails per-texture and
// silently renders those surfaces black. (Diagnosed 2026-07-10; stage-00 at
// 25k verts was the only stage surviving the Quick Look round trip.)
//
// This script re-opens a processed .glb (scale/recenter already applied — it
// does NOT touch scale) and runs the heavier cleanup:
//
//   dedup    — collapse byte-identical accessors/textures/materials
//   palette  — fold flat-color materials into one shared palette texture so
//              join() can merge across them (alphaMode differences keep the
//              translucent glass material separate, so it won't get merged
//              into opaque geometry)
//   flatten + join — collapse the thousands of per-object primitives into a
//              handful of per-material draws
//   weld     — merge duplicate vertices so simplify can work across seams
//   simplify — meshoptimizer, with a *realistic* error budget (see flags)
//   prune    — drop whatever the above orphaned
//   textureCompress — cap textures at 1024px (still sharp for a model that
//              fills half a kiosk screen; 1024px is ~5MB GPU vs 2048's ~21MB)
//   draco    — recompress geometry on the way out
//
// Usage:
//   node optimize-glb.mjs <in.glb> <out.glb> [--ratio=0.1] [--error=0.01] [--max-texture=1024]
//
// Verify with inspect-glb.mjs / a local serve afterwards — the target profile
// is stage-00's (~25k verts, ~470 prims), the one stage that has held up on
// real iOS hardware.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  palette,
  flatten,
  join,
  weld,
  simplify,
  prune,
  textureCompress,
  draco,
} from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";
import { MeshoptSimplifier } from "meshoptimizer";
import { statSync } from "fs";

const args = process.argv.slice(2);
const paths = args.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? parseFloat(hit.split("=")[1]) : fallback;
};

const [inPath, outPath] = paths;
if (!inPath || !outPath) {
  console.error("Usage: node optimize-glb.mjs <in.glb> <out.glb> [--ratio=0.1] [--error=0.01] [--max-texture=1024]");
  process.exit(1);
}
const ratio = flag("ratio", 0.1);
const error = flag("error", 0.01);
const maxTexture = flag("max-texture", 1024);

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });

function stats(document) {
  const root = document.getRoot();
  let verts = 0;
  let prims = 0;
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) {
      prims++;
      const pos = prim.getAttribute("POSITION");
      if (pos) verts += pos.getCount();
    }
  return { verts, prims, textures: root.listTextures().length };
}

const document = await io.read(inPath);
const before = stats(document);

await MeshoptSimplifier.ready;
await document.transform(
  dedup(),
  palette({ min: 2 }),
  flatten(),
  join(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error }),
  prune(),
  textureCompress({ encoder: sharp, resize: [maxTexture, maxTexture], targetFormat: "webp", quality: 82 }),
  draco({ method: "edgebreaker" })
);

await io.write(outPath, document);

const after = stats(document);
const beforeMB = (statSync(inPath).size / 1024 / 1024).toFixed(2);
const afterMB = (statSync(outPath).size / 1024 / 1024).toFixed(2);
console.log(`${inPath} -> ${outPath}  (ratio=${ratio} error=${error} maxTexture=${maxTexture})`);
console.log(`  verts:    ${before.verts.toLocaleString()} -> ${after.verts.toLocaleString()}`);
console.log(`  prims:    ${before.prims.toLocaleString()} -> ${after.prims.toLocaleString()}`);
console.log(`  textures: ${before.textures} -> ${after.textures}`);
console.log(`  file:     ${beforeMB}MB -> ${afterMB}MB`);
