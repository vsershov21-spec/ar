// GLB с EXT_meshopt_compression / quantization → обычный GLB (для python-скриптов: penetration.py читает anims_v1)
// node scripts/models/decompress_glb.mjs in.glb out.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
const [src, dst] = process.argv.slice(2);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(src);
for (const e of doc.getRoot().listExtensionsUsed()) if (/meshopt|quantiz/i.test(e.extensionName)) e.dispose();
await io.write(dst, doc);
