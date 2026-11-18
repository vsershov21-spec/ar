#!/usr/bin/env node
// Размыть номер карты на записи: `npm run card:blur -- вход.mp4 [выход.mp4] [--preview] [--strict]`
// (нижние 60 % найденной карты в каждом кадре; логика — tests/card/eval/blur.ts, зона — src/tracker/card/blurNumbers.ts).
// Сырые записи (с номером) в git и на сервер не кладём — docs/qa/CARD_MATRIX.md.
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vite = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
let code = 1;
try {
  const { main } = await vite.ssrLoadModule('/tests/card/eval/blur.ts');
  code = await main(process.argv.slice(2));
} catch (e) {
  console.error(e);
} finally {
  await vite.close();
}
process.exit(code);
