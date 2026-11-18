import { defineConfig } from 'vite';
// модели сжимаются при сборке (meshopt + KTX2), исходники public/models не меняются — scripts/build/model-opt.mjs
import { modelOpt } from './scripts/build/vite-model-opt.mjs';
import { existsSync, readdirSync } from 'node:fs';

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

// BASE_PATH задаёт подпуть для GitHub Pages: BASE_PATH=/ar-proto/ npm run build
// По умолчанию './' — относительные пути, работает и в корне домена, и в подпапке.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [modelOpt()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 6000,
    rollupOptions: { input: pages() },
  },
  // dev: сервис прогресса локально — node server/progress/server.mjs (PROGRESS_DATA=/tmp/p PROGRESS_ORIGINS=http://localhost:5173)
  server: { host: true, proxy: { '/api/progress': 'http://127.0.0.1:8787' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
