// Плагин vite (только сборка): сжимает GLB из public/models (model-opt.mjs), кладёт их в dist/models/opt/<имя>.<хэш>.glb
// и передаёт рантайму карту «исходный путь → сжатый» через define __MODEL_OPT__ (src/core/modelUrl.ts).
// Ошибка сжатия не роняет сборку: модель остаётся исходной. AR_MODEL_OPT=0 — выключить.
import fs from 'node:fs';
import path from 'node:path';
import { optimizeModels } from './model-opt.mjs';

/** какие модели сжимаем: персонажи и реквизит (библиотека движений anims_v1.glb уже meshopt — без изменений) */
const PICK = (rel) => /^models\/(props\/|v2\/)?[\w.-]+\.glb$/.test(rel) && !/^models\/(anims_|character\.glb)/.test(rel);

/** emit: false — только карта путей (сборка lab, docs/EDITIONS.md: сжатые модели уже лежат в dist/models/opt от mvp) */
export function modelOpt({ emit = true } = {}) {
  let results = [];
  let enabled = process.env.AR_MODEL_OPT !== '0';
  return {
    name: 'ar-model-opt',
    apply: 'build',
    async config(cfg) {
      const map = {};
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
        const before = results.reduce((a, r) => a + r.bytes, 0), after = results.reduce((a, r) => a + (map[r.rel] ? r.optBytes : r.bytes), 0);
        if (results.length) console.log(`model-opt${emit ? '' : ' (без файлов: только карта)'}: ${results.length} моделей, ${(before / 1048576).toFixed(1)} → ${(after / 1048576).toFixed(1)} МБ за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      }
      return { define: { __MODEL_OPT__: JSON.stringify(map) } };
    },
    generateBundle() {
      if (!emit) return;
      for (const r of results) if (r.data && r.optBytes < r.bytes * 1.15) this.emitFile({ type: 'asset', fileName: r.optRel, source: r.data });
    },
  };
}
