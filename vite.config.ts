import { defineConfig } from 'vite';
// модели сжимаются при сборке (meshopt + KTX2), исходники public/models не меняются — scripts/build/model-opt.mjs
import { modelOpt } from './scripts/build/vite-model-opt.mjs';

// BASE_PATH задаёт подпуть для GitHub Pages: BASE_PATH=/ar-proto/ npm run build
// По умолчанию './' — относительные пути, работает и в корне домена, и в подпапке.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [modelOpt()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 6000,
  },
  server: { host: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
