/**
 * GLTFLoader с декодерами сжатых моделей: EXT_meshopt_compression (MeshoptDecoder) и KHR_texture_basisu
 * (KTX2Loader: транскодер Basis в воркере, файлы транскодера — ассеты vite с хэшем, кэшируются навсегда).
 * Один KTX2Loader на всё приложение: его воркеры и транскодер переиспользуются при смене характера.
 */
import { glRenderer } from '../core/glRenderer';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

let ktx2: KTX2Loader | null = null;

export function makeGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const renderer = glRenderer();
  // KTX2 выбирает формат сжатия видеокарты (ASTC/ETC2/BC/PVRTC) — нужен рендерер (App регистрирует его сразу)
  if (renderer) {
    if (!ktx2) {
      ktx2 = new KTX2Loader().setWorkerLimit(2);
      ktx2.detectSupport(renderer);
    }
    loader.setKTX2Loader(ktx2);
  }
  return loader;
}
