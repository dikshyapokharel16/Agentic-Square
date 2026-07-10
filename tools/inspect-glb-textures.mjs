// Dump per-texture dimensions, mime type, byte size, and estimated GPU memory
// for every .glb passed on the command line.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });

for (const path of process.argv.slice(2)) {
  const doc = await io.read(path);
  const root = doc.getRoot();
  console.log(`\n=== ${path}`);
  let totalGpu = 0;
  let totalBytes = 0;
  for (const tex of root.listTextures()) {
    const img = tex.getImage();
    const meta = await sharp(Buffer.from(img)).metadata();
    const gpuMB = (meta.width * meta.height * 4 * 1.33) / 1024 / 1024; // RGBA + mipmaps
    totalGpu += gpuMB;
    totalBytes += img.byteLength;
    console.log(
      `  ${String(tex.getName() || tex.getURI() || "(unnamed)").padEnd(28)} ` +
      `${meta.width}x${meta.height} ${tex.getMimeType()} ` +
      `${(img.byteLength / 1024 / 1024).toFixed(2)}MB file, ~${gpuMB.toFixed(0)}MB GPU`
    );
  }
  let verts = 0, prims = 0;
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) {
      prims++;
      const pos = prim.getAttribute("POSITION");
      if (pos) verts += pos.getCount();
    }
  console.log(`  -- textures: ${root.listTextures().length}, est GPU tex mem ~${totalGpu.toFixed(0)}MB, tex bytes ${(totalBytes/1024/1024).toFixed(1)}MB, verts ${verts.toLocaleString()}, prims ${prims}`);
}
