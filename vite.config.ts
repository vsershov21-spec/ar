import { defineConfig } from 'vite';
// модели сжимаются при сборке (meshopt + KTX2), исходники public/models не меняются — scripts/build/model-opt.mjs
import { earlyModelScript, modelOpt } from './scripts/build/vite-model-opt.mjs';
import { ASSETS } from './src/config';
import { variantGlb } from './src/character/modelVariant';
import { existsSync, readdirSync } from 'node:fs';
import { featureIn, parseEdition } from './src/config/edition';
import { quickSplash } from './src/quick/splash';
import { PRIVACY_POLICY_URL, parseConsentMode } from './src/config/consent';

/**
 * Быстрый вход (feature 'intro.quick', src/quick/splash.ts): заставка — прямо в index.html редакции (lab, pilot; dev = lab),
 * до бандла. Стили приложения переезжают в <body> ПОСЛЕ заставки: в <head> они блокировали бы её первый кадр
 * (а in-body stylesheet блокирует только то, что ниже). MVP-корень — без изменений. Режим согласия — config/consent.ts
 * (или VITE_CONSENT_MODE на сборке).
 */
function quickSplashPlugin() {
  return {
    name: 'ar-quick-splash',
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string, ctx: { bundle?: Record<string, { fileName: string }> }) {
        if (!featureIn(parseEdition(process.env.VITE_EDITION), 'intro.quick')) return html;
        if (!html.includes('<div id="app"></div>')) return html;
        // опыт ?early=1: модель кота, стартовые движения и транскодер текстур — качать с первого байта страницы
        // (scripts/build/vite-model-opt.mjs earlyModelScript; по умолчанию выключен — замеры в docs/qa/ui/quick/SPEED.md)
        const base = process.env.SUB_BASE ?? process.env.LAB_BASE ?? '/';
        const transcoder = Object.values(ctx?.bundle ?? {}).map((f) => f.fileName).filter((f) => /basis_transcoder[^/]*\.(wasm|js)$/.test(f)).map((f) => base + f);
        const early = earlyModelScript({
          assetBase: process.env.VITE_ASSET_BASE || base, storagePrefix: process.env.VITE_STORAGE_PREFIX ?? '',
          glbByPersona: ASSETS.glbByPersona, v2: (p: string) => variantGlb(p, 'v2', featureIn(parseEdition(process.env.VITE_EDITION), 'face.morph') ? 'morph' : 'shader'), anims: ASSETS.glbAnims, transcoder,
        });
        // сразу за <meta charset> (кодировка — в первых 1024 байтах), до стилей и бандла
        if (early) html = /<meta charset[^>]*>/i.test(html) ? html.replace(/(<meta charset[^>]*>)/i, `$1\n    ${early}`) : html.replace('<head>', `<head>\n    ${early}`);
        const css: string[] = [];
        const head = html.replace(/\s*<link rel="stylesheet"[^>]*>/g, (m) => (css.push(m.trim()), ''));
        const splash = quickSplash({ consent: parseConsentMode(process.env.VITE_CONSENT_MODE), policyUrl: PRIVACY_POLICY_URL });
        return head.replace('<div id="app"></div>', `${splash}\n    ${css.join('\n    ')}\n    <div id="app"></div>`);
      },
    },
  };
}

// страницы сборки: index.html + все test/**/index.html (/test, /test/admin — сброс прогресса, server/progress)
function pages(dir = 'test', out: Record<string, string> = { main: 'index.html' }) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = `${dir}/${e.name}`;
    if (e.isDirectory()) pages(f, out);
    else if (e.name === 'index.html') out[dir.replace(/\//g, '_')] = f;
  }
  return out;
}

// Редакции (docs/EDITIONS.md): npm run build → scripts/build/editions.mjs собирает обе подряд:
//   mvp — dist/      (base BASE_PATH ?? './', public/ копируется, сжатые модели кладутся в dist/models/opt);
//   lab — dist/lab/  (AR_BUILD_LAB=1: base '/lab/', только index.html, public/ НЕ копируется и модели не кладутся —
//                     ассеты из корня: VITE_ASSET_BASE='/', src/core/util.ts asset()).
//   pilot — dist/mvp/ (AR_SUB_DIR=mvp: base '/mvp/', как lab — только index.html, ассеты из корня).
// Просто `vite build` (CI, QA-стенд) — одна сборка в dist/, редакция — VITE_EDITION (без неё lab), как раньше.
// Подпапка редакции: AR_SUB_DIR=lab|mvp (AR_BUILD_LAB=1 — старое имя для lab), её base — SUB_BASE (LAB_BASE).
const SUB = process.env.AR_SUB_DIR || (process.env.AR_BUILD_LAB === '1' ? 'lab' : '');
const LAB_DIR = !!SUB;

// BASE_PATH задаёт подпуть для GitHub Pages: BASE_PATH=/ar-proto/ npm run build
// По умолчанию './' — относительные пути, работает и в корне домена, и в подпапке.
export default defineConfig({
  base: LAB_DIR ? (process.env.SUB_BASE ?? process.env.LAB_BASE ?? `/${SUB}/`) : (process.env.BASE_PATH ?? './'),
  publicDir: LAB_DIR ? false : 'public',
  plugins: [modelOpt({ emit: !LAB_DIR }), quickSplashPlugin()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 6000,
    outDir: LAB_DIR ? `dist/${SUB}` : 'dist',
    emptyOutDir: !LAB_DIR,
    rollupOptions: { input: LAB_DIR ? { main: 'index.html' } : pages() },
  },
  // dev: сервис прогресса локально — node server/progress/server.mjs (PROGRESS_DATA=/tmp/p PROGRESS_ORIGINS=http://localhost:5173)
  server: { host: true, proxy: { '/api/progress': 'http://127.0.0.1:8787' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
