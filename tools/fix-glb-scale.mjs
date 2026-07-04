import { NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression, EXTTextureWebP } from "@gltf-transform/extensions";
import { draco, textureCompress, simplify } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";
import { MeshoptSimplifier } from "meshoptimizer";

const [, , inPath, outPath, factorArg] = process.argv;
const factor = factorArg ? parseFloat(factorArg) : 0.05;

if (!inPath) {
  console.error("Usage: node fix-glb-scale.mjs <input.glb> <output.glb> [factor=0.05]");
  process.exit(1);
}

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP])
  .registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    // Needed to *read* input that's already Draco-compressed (e.g. re-running
    // this script on its own previous output) — the encoder alone only covers
    // writing the compressed output, not decoding compressed input.
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });

const beforeSize = (await import("fs")).statSync(inPath).size;

const document = await io.read(inPath);
const root = document.getRoot();

for (const scene of root.listScenes()) {
  for (const node of scene.listChildren()) {
    const [x, y, z] = node.getScale();
    node.setScale([x * factor, y * factor, z * factor]);
  }
}

// SketchUp/Blender exports have been coming in with absurdly oversized
// textures (11811x11811 seen in practice) that dwarf geometry as the actual
// size cost. Resize to a cap that's still sharp up close on a ~1.8m AR model
// viewed on a phone/tablet screen, and convert to WebP — model-viewer/three.js
// support EXT_texture_webp natively, and it compresses far better than PNG
// for this kind of photographic texture (~90% smaller in practice).
await document.transform(textureCompress({ encoder: sharp, resize: [2048, 2048], targetFormat: "webp", quality: 82 }));

// These SketchUp exports also carry far more polygons than a ~1.8m AR model
// needs (raw stage-01..03 exports ran 85-90MB pre-compression). Simplify
// before Draco — reducing the triangle count first, then compressing
// whatever's left, compounds much better than compression alone.
await MeshoptSimplifier.ready;
await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.001 }));

// Draco-compress the geometry — model-viewer/three.js decode this natively,
// so it's a safe, broadly-compatible way to shrink file size.
await document.transform(draco({ method: "edgebreaker" }));

const out = outPath || inPath;
await io.write(out, document);

const afterSize = (await import("fs")).statSync(out).size;
const pct = (100 * (1 - afterSize / beforeSize)).toFixed(0);
console.log(`Scaled ${inPath} by ${factor} -> ${out}`);
console.log(`Draco-compressed: ${(beforeSize / 1024).toFixed(0)}KB -> ${(afterSize / 1024).toFixed(0)}KB (${pct}% smaller)`);
