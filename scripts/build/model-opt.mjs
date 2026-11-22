// Сжатие 3D-моделей при сборке (исходники public/models/*.glb не трогаем — их правят python-стадии scripts/models).
//
// Что делает с каждой моделью:
//  - геометрия — EXT_meshopt_compression (без квантования: позиции/нормали/_FURLEN остаются float, поэтому шейдеры
//    меха и складок, коллайдер тела и всё, что читает вершины, видят те же числа);
//  - текстуры от 1024 px — KTX2/Basis ETC1S (цвет — sRGB, нормали — режим normal map, roughness/metal — линейно):
//    на телефоне они остаются сжатыми и в видеопамяти (ETC2/ASTC/PVRTC вместо RGBA: ~2,7 МБ вместо 22 МБ на 2048²),
//    без декодирования JPEG на главном потоке. Мелкие текстуры не трогаем.
// Результат — models/opt/<имя>.<хэш>.glb (хэш в имени: /models/ кэшируется у телефонов навсегда) + карта путей,
// которую плагин vite кладёт в бандл (__MODEL_OPT__). Кэш по содержимому: .cache/model-opt (или $AR_MODEL_CACHE).
//
// Запуск вручную: node scripts/build/model-opt.mjs public/models/kind_v1.glb [--out x.glb]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

/**
 * Текстуры больше MAX_TEX px — уменьшаются до него перед KTX2 (2048² → 1024²: на экране телефона кот 300–600 px,
 * атлас всего тела 1024² — тот же вид, сверка docs/qa/ui/quick/SPEED.md; −1,3 МБ на кота). AR_TEX_MAX=2048 — как было.
 */
const MAX_TEX = Number(process.env.AR_TEX_MAX) || 1024;
/** меняется при любой правке алгоритма — сбрасывает кэш */
export const PIPELINE = `v1-etc1s-q255-min1024-meshopt-filter${MAX_TEX !== 2048 ? `-max${MAX_TEX}` : ''}`;
/** меньше 1024 px KTX2 выходит тяжелее JPEG, а памяти такие текстуры почти не занимают — оставляем как есть */
const MIN_KTX = 1024;

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '../..');

async function optimizeBuffer(input) {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  const sharp = (await import('sharp')).default;
  const { encodeToKTX2 } = await import('ktx2-encoder');
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.readBinary(new Uint8Array(input));
  const docRoot = doc.getRoot();
  const log = [];
  const decode = async (buf) => {
    const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  };
  let ktx = 0;
  for (const tex of docRoot.listTextures()) {
    const img = tex.getImage();
    const mime = tex.getMimeType();
    if (!img || !/image\/(jpeg|png)/.test(mime)) continue;
    const size = tex.getSize();
    if (!size || Math.max(size[0], size[1]) < MIN_KTX || size[0] % 4 || size[1] % 4) continue;
    const mats = docRoot.listMaterials();
    const isNormal = mats.some((m) => m.getNormalTexture() === tex);
    const isColor = mats.some((m) => m.getBaseColorTexture() === tex || m.getEmissiveTexture() === tex) ||
      mats.some((m) => m.listExtensions().some((e) => typeof e.getSheenColorTexture === 'function' && e.getSheenColorTexture() === tex));
    if (isNormal && isColor) continue; // одна картинка в двух ролях — не угадываем
    const opts = isNormal
      ? { isNormalMap: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false }
      : isColor
        ? { isPerceptual: true, isSetKTX2SRGBTransferFunc: true }
        : { isPerceptual: false, isSetKTX2SRGBTransferFunc: false };
    // больше MAX_TEX — уменьшить (Lanczos, без потерь при перекодировании: PNG); нормали после усреднения — как есть
    // (Basis в режиме normal map их нормирует)
    let src = img, w = size[0], h = size[1];
    if (Math.max(w, h) > MAX_TEX) {
      const k = MAX_TEX / Math.max(w, h);
      [w, h] = [Math.round(w * k), Math.round(h * k)];
      src = new Uint8Array(await sharp(Buffer.from(img)).resize(w, h, { kernel: 'lanczos3' }).png({ compressionLevel: 1 }).toBuffer());
    }
    const out = await encodeToKTX2(src, { isUASTC: false, qualityLevel: 255, compressionLevel: 2, generateMipmap: true, enableDebug: false, imageDecoder: decode, ...opts });
    log.push(`${tex.getName() || 'tex'} ${size[0]}²${w !== size[0] ? `→${w}²` : ''} ${isNormal ? 'normal' : isColor ? 'color' : 'linear'} ${(img.byteLength / 1024) | 0}K→${(out.byteLength / 1024) | 0}K`);
    tex.setImage(out).setMimeType('image/ktx2');
    ktx++;
  }
  if (ktx) doc.createExtension(KHRTextureBasisu).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const out = await io.writeBinary(doc);
  return { out: Buffer.from(out.buffer, out.byteOffset, out.byteLength), log };
}

/** папка кэша сборки (или null — кэша нет); её же берут пакеты движений (vite-model-opt.mjs) */
export function modelCacheDir() {
  return cacheDir();
}

function cacheDir() {
  const cands = [process.env.AR_MODEL_CACHE, path.join(root, '.cache/model-opt'), path.join(os.tmpdir(), 'ar-model-opt')].filter(Boolean);
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch {
      /* следующая */
    }
  }
  return null;
}

/**
 * Сжать список файлов параллельно (worker_threads; кодер Basis — однопоточный wasm).
 * files: [{ rel: 'models/kind_v1.glb', abs }] → [{ rel, optRel, bytes, optBytes, cached, log, error? }]
 */
// память процесса: две сборки подряд (mvp + lab, scripts/build/editions.mjs) не сжимают модель дважды, даже если
// дискового кэша нет. На globalThis — vite заново загружает конфиг (и этот модуль) на каждую сборку.
const MEMO = (globalThis.__arModelOptMemo ??= new Map());

export async function optimizeModels(files, { log = console.log } = {}) {
  const dir = cacheDir();
  const results = [];
  const todo = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    const key = crypto.createHash('sha1').update(PIPELINE).update(buf).digest('hex');
    const name = path.basename(f.rel, '.glb');
    const r = { rel: f.rel, optRel: path.posix.join(path.posix.dirname(f.rel), 'opt', `${name}.${key.slice(0, 10)}.glb`), bytes: buf.length, key, cached: false, log: [] };
    results.push(r);
    const cached = dir && path.join(dir, key + '.glb');
    if (MEMO.has(key)) {
      r.data = MEMO.get(key);
      r.cached = true;
    } else if (cached && fs.existsSync(cached)) {
      r.data = fs.readFileSync(cached);
      r.cached = true;
    } else todo.push({ r, buf, cached });
  }
  const limit = Math.max(1, Math.min(todo.length, os.availableParallelism?.() ?? os.cpus().length, 4));
  let next = 0;
  const runOne = (job) =>
    new Promise((resolve) => {
      // stdout воркера глушим: кодер Basis (wasm) печатает отладку даже с enableDebug: false
      const w = new Worker(here, { workerData: { buf: job.buf }, stdout: true });
      w.stdout.resume();
      w.once('message', (m) => {
        if (m.error) job.r.error = m.error;
        else {
          job.r.data = Buffer.from(m.out);
          job.r.log = m.log;
          if (job.cached) {
            try {
              fs.writeFileSync(job.cached + '.tmp', job.r.data);
              fs.renameSync(job.cached + '.tmp', job.cached);
            } catch {
              /* кэш не обязателен */
            }
          }
        }
        resolve();
      });
      w.once('error', (e) => {
        job.r.error = String(e?.message ?? e);
        resolve();
      });
    });
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < todo.length) await runOne(todo[next++]);
    }),
  );
  for (const r of results) {
    if (r.data) MEMO.set(r.key, r.data);
    if (r.error) log(`model-opt: ${r.rel} — не сжата (${r.error}), остаётся исходная`);
    else {
      r.optBytes = r.data.length;
      log(`model-opt: ${r.rel} ${(r.bytes / 1048576).toFixed(2)} → ${(r.optBytes / 1048576).toFixed(2)} МБ${r.cached ? ' (кэш)' : ''}${r.log.length ? ' · ' + r.log.join(', ') : ''}`);
    }
  }
  return results;
}

if (!isMainThread && workerData?.buf) {
  optimizeBuffer(workerData.buf).then(
    ({ out, log }) => parentPort.postMessage({ out, log }),
    (e) => parentPort.postMessage({ error: String(e?.stack ?? e) }),
  );
} else if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === here) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const outPath = oi >= 0 ? args.splice(oi, 2)[1] : null;
  const files = args.map((a) => ({ rel: path.relative(path.join(root, 'public'), path.resolve(a)).split(path.sep).join('/'), abs: path.resolve(a) }));
  const res = await optimizeModels(files);
  if (outPath && res[0]?.data) fs.writeFileSync(outPath, res[0].data);
}
