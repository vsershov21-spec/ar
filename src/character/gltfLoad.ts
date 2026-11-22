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

let meshoptWorkers = false;

export function makeGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  // распаковка meshopt (модели и библиотека движений) — в двух воркерах: главный поток не замирает на онбординге
  if (!meshoptWorkers && typeof Worker !== 'undefined') {
    meshoptWorkers = true;
    try {
      MeshoptDecoder.useWorkers(2);
    } catch {
      /* без воркеров — как раньше, на главном потоке */
    }
  }
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

/**
 * Транскодер Basis (js + wasm, ~0,25 МБ) — качать сразу, вместе с моделью кота, а не после неё: иначе он встаёт в
 * очередь только когда модель уже скачана и начался разбор текстур (лишние 0,2–1,4 с до кота на 4G).
 */
export function warmTranscoder() {
  makeGltfLoader(); // создаёт общий KTX2Loader (нужен рендерер — App регистрирует его в конструкторе)
  void ktx2?.init().catch(() => undefined);
}
