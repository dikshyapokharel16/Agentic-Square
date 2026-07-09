import { NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression, EXTTextureWebP } from "@gltf-transform/extensions";
import { getBounds, draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import fs from "fs";

// Sniffs the Draco encoder method (0=sequential, 1=edgebreaker) already
// baked into a .glb's first compressed primitive, straight from the Draco
// bitstream header (this isn't recorded anywhere in the glTF JSON itself —
// gltf-transform's own read/write round-trip doesn't preserve method choice,
// it silently defaults to edgebreaker on write, which would have undone
// stage-01's deliberate sequential-encoding fix for the Android tiny-scale
// bug if this script didn't explicitly re-apply whatever method was already
// there).
function sniffDracoMethod(path) {
  const buf = fs.readFileSync(path);
  let offset = 12, jsonChunk, binChunk;
  while (offset < buf.length) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + chunkLen);
    if (chunkType === "JSON") jsonChunk = data;
    if (chunkType === "BIN\0") binChunk = data;
    offset += 8 + chunkLen;
  }
  if (!jsonChunk) return null;
  const json = JSON.parse(jsonChunk.toString("utf8"));
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives) {
      const ext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
      if (ext) {
        const view = json.bufferViews[ext.bufferView];
        const start = view.byteOffset || 0;
        const methodByte = binChunk[start + 8];
        return methodByte === 0 ? "sequential" : "edgebreaker";
      }
    }
  }
  return null;
}

// Recenters a .glb's footprint (X/Z) on the local origin and, optionally,
// applies an additional uniform rescale on top of whatever scale the file
// already has — without touching mesh/texture data, since both are pure
// transform edits, safe to do even on an already Draco-compressed file.
//
// Why recenter at all: <model-viewer> only auto-centers the model in its
// own inline turntable camera (a JS/three.js framing trick). Native AR
// (Scene Viewer, Quick Look) and even model-viewer's own WebXR AR rotate
// the placed model around the file's raw local origin (confirmed in
// ARRenderer.ts's scenePivot handling) — so if a SketchUp/Blender export's
// origin sits away from the model's visual center, AR rotation gestures
// orbit around that far-off point instead of the model itself. Y (vertical)
// is deliberately left untouched — these exports already sit on the ground
// plane at Y=0, recentering vertically too would lift the model off the
// AR floor.
//
// Implementation note: rather than hand-walk the node hierarchy (existing
// AR exports nest meshes several levels under the top-level "root" node,
// each with their own local transforms), this wraps the whole scene in a
// single new parent node carrying the recenter+rescale transform — glTF
// consumers always correctly compose parent/child transforms, so this is
// correct regardless of how deep the source hierarchy is. getBounds() from
// @gltf-transform/functions is used to read the true composed world bounds
// (a hand-rolled version of this previously ignored ancestor transforms
// below the top level and silently computed wrong numbers).
//
// Usage: node recenter-glb.mjs <in.glb> <out.glb> [--target-longest-side=1.8]
// --target-longest-side rescales (uniformly, on top of whatever scale the
// file already has) so the longest bounding-box side matches the given
// value in meters, computed from the file's own current bounds — use this
// instead of a manual multiplier to avoid factor-precision mistakes. Omit
// it to recenter only, with no rescale.

const [, , inPath, outPath, ...rest] = process.argv;
const targetArg = rest.find((a) => a.startsWith("--target-longest-side="));
const targetLongestSide = targetArg ? parseFloat(targetArg.split("=")[1]) : null;

if (!inPath || !outPath) {
  console.error("Usage: node recenter-glb.mjs <in.glb> <out.glb> [--target-longest-side=1.8]");
  process.exit(1);
}

const originalDracoMethod = sniffDracoMethod(inPath);

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP])
  .registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });

const document = await io.read(inPath);
const root = document.getRoot();
const scene = root.listScenes()[0];

const before = getBounds(scene);
const centerX = (before.min[0] + before.max[0]) / 2;
const centerZ = (before.min[2] + before.max[2]) / 2;
const longestSideBefore = Math.max(
  before.max[0] - before.min[0],
  before.max[1] - before.min[1],
  before.max[2] - before.min[2]
);

const extraScale = targetLongestSide ? targetLongestSide / longestSideBefore : 1;

// Wrap every existing top-level child under one new node carrying the
// recenter+rescale transform, so parent/child composition (done correctly
// by any real glTF consumer) applies it to the whole hierarchy regardless
// of nesting depth.
// T*R*S composition: a child's world position is T + S*(child's own world
// position expressed in the wrapper's local space, i.e. pre-existing world
// coords since the wrapper starts at identity). So the translation here
// must also carry the extraScale factor to land the recentered result at
// the origin — T + S*center == 0  =>  T == -S*center.
const wrapper = document.createNode("recenter-rescale")
  .setScale([extraScale, extraScale, extraScale])
  .setTranslation([-centerX * extraScale, 0, -centerZ * extraScale]);
for (const child of [...scene.listChildren()]) {
  wrapper.addChild(child);
}
scene.addChild(wrapper);

// io.write() would otherwise silently re-Draco-compress with its own
// default (edgebreaker) regardless of what the source file used — re-apply
// whatever method the input actually had so this script never changes
// compression as a side effect of a pure transform edit.
if (originalDracoMethod) {
  await document.transform(draco({ method: originalDracoMethod }));
}

await io.write(outPath, document);

const after = getBounds(scene);
const afterCenter = [
  (after.min[0] + after.max[0]) / 2,
  (after.min[1] + after.max[1]) / 2,
  (after.min[2] + after.max[2]) / 2,
];
const longestSideAfter = Math.max(
  after.max[0] - after.min[0],
  after.max[1] - after.min[1],
  after.max[2] - after.min[2]
);

console.log(`${inPath} -> ${outPath}`);
console.log(`  longest side: ${longestSideBefore.toFixed(3)}m -> ${longestSideAfter.toFixed(3)}m`);
console.log(`  center (XZ) was ${centerX.toFixed(3)}, ${centerZ.toFixed(3)} -> now ${afterCenter[0].toFixed(4)}, ${afterCenter[2].toFixed(4)}`);
console.log(`  draco method preserved: ${originalDracoMethod || "(none — file wasn't Draco-compressed)"}`);
