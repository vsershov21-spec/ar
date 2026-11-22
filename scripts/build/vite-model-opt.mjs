// Плагин vite (только сборка): сжимает GLB из public/models (model-opt.mjs), кладёт их в dist/models/opt/<имя>.<хэш>.glb
// и передаёт рантайму карту «исходный путь → сжатый» через define __MODEL_OPT__ (src/core/modelUrl.ts).
// Ошибка сжатия не роняет сборку: модель остаётся исходной. AR_MODEL_OPT=0 — выключить.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { optimizeModels, modelCacheDir } from './model-opt.mjs';
import { ANIM_PIPELINE, packAnims } from './anim-pack.mjs';
import { startClipNames } from '../../src/character/animPacks';

/** какие модели сжимаем: персонажи и реквизит (библиотека движений — отдельно, пакетами: ANIM_LIBS) */
const PICK = (rel) => /^models\/(props\/|v2\/)?[\w.-]+\.glb$/.test(rel) && !/^models\/(anims_|character\.glb)/.test(rel);

/** библиотеки движений → стартовый пакет + «остальное» (scripts/build/anim-pack.mjs, src/character/animPacks.ts) */
const ANIM_LIBS = ['models/anims_v1.glb'];
const ANIM_MEMO = (globalThis.__arAnimPackMemo ??= new Map());

/** пакеты одной библиотеки (кэш по содержимому, стартовому списку и версии алгоритма) */
async function animPacks(rel, abs, root) {
  const buf = fs.readFileSync(abs);
  const len = buf.readUInt32LE(12);
  const names = JSON.parse(buf.subarray(20, 20 + len).toString('utf8')).animations.map((a) => a.name);
  const defs = JSON.parse(fs.readFileSync(path.join(root, 'content/animations.json'), 'utf8')).clips;
  const start = startClipNames(names, defs);
  const key = crypto.createHash('sha1').update(ANIM_PIPELINE).update(buf).update(start.join('\n')).digest('hex');
  const name = path.basename(rel, '.glb');
  // имена файлов кэша = хэш в имени файла сайта (стенды scripts/qa отдают models/opt/* прямо из кэша по хэшу)
  const sub = (k) => crypto.createHash('sha1').update(key + k).digest('hex');
  const ks = sub('start'), kr = sub('rest');
  const dir = modelCacheDir();
  const hit = ANIM_MEMO.get(key) ?? (dir && fs.existsSync(path.join(dir, ks + '.glb')) && fs.existsSync(path.join(dir, kr + '.glb'))
    ? { start: fs.readFileSync(path.join(dir, ks + '.glb')), rest: fs.readFileSync(path.join(dir, kr + '.glb')), cached: true }
    : null);
  const r = hit ?? (await packAnims(buf, { start }));
  ANIM_MEMO.set(key, r);
  if (dir && !hit) {
    try {
      for (const [k, b] of [[ks, r.start], [kr, r.rest]]) if (b) fs.writeFileSync(path.join(dir, k + '.glb'), b);
    } catch {
      /* кэш не обязателен */
    }
  }
  const dirRel = path.posix.dirname(rel);
  return {
    rel,
    bytes: buf.length,
    start: { rel: path.posix.join(dirRel, 'opt', `${name}.start.${ks.slice(0, 10)}.glb`), data: r.start },
    rest: r.rest ? { rel: path.posix.join(dirRel, 'opt', `${name}.rest.${kr.slice(0, 10)}.glb`), data: r.rest } : null,
    clips: start.length,
    all: names.length,
    cached: !!hit,
  };
}

/** последняя карта путей (сборка этой редакции) — для раннего скрипта заставки */
let lastMap = {};

/**
 * Быстрый вход (src/quick/splash.ts), ОПЫТ — включается ?early=1: модель кота и стартовые движения начинают качаться
 * прямо из index.html, с первого байта страницы, ещё до бандла (заставка кота не показывает). Тот же выбор кота, что
 * App.prefetchCat (?cat / ?char, память характера, по умолчанию Хулиган; модели v2), те же адреса (карта сжатых
 * моделей); промисы байтов — window.__arEarly[адрес], их забирает src/core/modelUrl.ts. Транскодер текстур (KTX2) —
 * <link rel=preload as=fetch> (его fetch делает KTX2Loader). ?glb, ?models, ?modelopt=0 — ничего не качаем.
 * По умолчанию выключено: на Slow 4G (стенд scripts/qa/quick-speed.mjs, docs/qa/ui/quick/SPEED.md) кот ускорялся на
 * 0,7 с, а видео камеры — позже на 2,8 с (модель делит полосу с кодом трекера). Решать по данным HTTP/2 на проде.
 */
export function earlyModelScript({ assetBase = '/', storagePrefix = '', glbByPersona, v2, anims, transcoder = [] }) {
  const M = {};
  for (const [id, p] of Object.entries(glbByPersona)) {
    const v = v2(p);
    if (lastMap[v]) M[id] = lastMap[v];
  }
  const A = lastMap[anims];
  if (!Object.keys(M).length || !A) return '';
  const cfg = JSON.stringify({ M, A, B: assetBase, K: storagePrefix + 'sber-ar-cat:v1', T: transcoder });
  return `<script>(function(){try{var c=${cfg},q=new URLSearchParams(location.search);if(q.get('early')!=='1'||q.has('glb')||q.has('models')||q.get('modelopt')==='0')return;var ch=q.get('char'),id=q.get('cat')||ch;if(ch&&!c.M[ch]&&ch!=='glb')return;if(!c.M[id]){id=null;try{id=(JSON.parse(localStorage.getItem(c.K)||'null')||{}).persona}catch(e){}}if(!c.M[id])id='hooligan';var E=window.__arEarly={};[c.M[id],c.A].forEach(function(u){var h=new URL(c.B+u,location.href).href;E[h]=fetch(h,{priority:'high'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.arrayBuffer()});E[h].catch(function(){});});c.T.forEach(function(u){var l=document.createElement('link');l.rel='preload';l.as='fetch';l.crossOrigin='anonymous';l.href=u;document.head.appendChild(l)})}catch(e){}})()</script>`;
}

/** emit: false — только карта путей (сборка lab, docs/EDITIONS.md: сжатые модели уже лежат в dist/models/opt от mvp) */
export function modelOpt({ emit = true } = {}) {
  let results = [];
  let packs = [];
  let enabled = process.env.AR_MODEL_OPT !== '0';
  return {
    name: 'ar-model-opt',
    apply: 'build',
    async config(cfg) {
      const map = {};
      const rest = {};
      if (enabled) {
        const pub = path.resolve(cfg.root ?? process.cwd(), typeof cfg.publicDir === 'string' ? cfg.publicDir : 'public');
        const files = [];
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (e.name !== 'opt' && !e.name.startsWith('vosk')) walk(abs);
            } else {
              const rel = path.relative(pub, abs).split(path.sep).join('/');
              if (PICK(rel)) files.push({ rel, abs });
            }
          }
        };
        if (fs.existsSync(path.join(pub, 'models'))) walk(path.join(pub, 'models'));
        const t0 = Date.now();
        try {
          results = await optimizeModels(files);
        } catch (e) {
          console.warn(`model-opt: пропущено (${e?.message ?? e})`);
          results = [];
        }
        for (const r of results) if (r.data && r.optBytes < r.bytes * 1.15) map[r.rel] = r.optRel;
        // движения: стартовый пакет — вместо библиотеки (тот же путь в config.ts), «остальное» — своей картой
        packs = [];
        for (const rel of ANIM_LIBS) {
          const abs = path.join(pub, rel);
          if (!fs.existsSync(abs)) continue;
          try {
            const pk = await animPacks(rel, abs, cfg.root ?? process.cwd());
            packs.push(pk);
            map[rel] = pk.start.rel;
            if (pk.rest) rest[rel] = pk.rest.rel;
            console.log(`anim-pack: ${rel} ${(pk.bytes / 1048576).toFixed(2)} МБ → старт ${(pk.start.data.length / 1048576).toFixed(2)} МБ (${pk.clips} из ${pk.all} клипов)${pk.rest ? ` + остальное ${(pk.rest.data.length / 1048576).toFixed(2)} МБ` : ''}${pk.cached ? ' (кэш)' : ''}`);
          } catch (e) {
            console.warn(`anim-pack: ${rel} — без пакетов (${e?.message ?? e}), библиотека целиком`);
          }
        }
        const before = results.reduce((a, r) => a + r.bytes, 0), after = results.reduce((a, r) => a + (map[r.rel] ? r.optBytes : r.bytes), 0);
        if (results.length) console.log(`model-opt${emit ? '' : ' (без файлов: только карта)'}: ${results.length} моделей, ${(before / 1048576).toFixed(1)} → ${(after / 1048576).toFixed(1)} МБ за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      }
      lastMap = map;
      return { define: { __MODEL_OPT__: JSON.stringify(map), __ANIM_REST__: JSON.stringify(rest) } };
    },
    generateBundle() {
      if (!emit) return;
      for (const r of results) if (r.data && r.optBytes < r.bytes * 1.15) this.emitFile({ type: 'asset', fileName: r.optRel, source: r.data });
      for (const pk of packs) for (const f of [pk.start, pk.rest]) if (f) this.emitFile({ type: 'asset', fileName: f.rel, source: f.data });
    },
  };
}
