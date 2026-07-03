import { NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const [, , inPath] = process.argv;

if (!inPath) {
  console.error("Usage: node inspect-glb.mjs <model.glb>");
  process.exit(1);
}

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });

const document = await io.read(inPath);
const root = document.getRoot();

console.log(inPath);
for (const material of root.listMaterials()) {
  console.log(`- material "${material.getName() || "(unnamed)"}"`);
  console.log(`    baseColorFactor: ${material.getBaseColorFactor()}`);
  console.log(`    metallicFactor: ${material.getMetallicFactor()}`);
  console.log(`    roughnessFactor: ${material.getRoughnessFactor()}`);
  console.log(`    baseColorTexture: ${!!material.getBaseColorTexture()}`);
  console.log(`    occlusionTexture: ${!!material.getOcclusionTexture()}`);
  console.log(`    metallicRoughnessTexture: ${!!material.getMetallicRoughnessTexture()}`);
}
