#!/usr/bin/env node
// Оценка трекера карты по записям: `npm run card:eval -- <папка|видео…> [--synth] [--baseline F] …`
// Логика — tests/card/eval/*.ts (TypeScript грузит Vite, как в приложении); флаги — tests/card/eval/cli.ts.
// Записи в репозиторий не кладём (номера карт!): по умолчанию /srv/ar-extra/card-rec, см. docs/qa/CARD_MATRIX.md.
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vite = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
let code = 1;
try {
  const { main } = await vite.ssrLoadModule('/tests/card/eval/cli.ts');
  code = await main(process.argv.slice(2));
} catch (e) {
  console.error(e);
} finally {
  await vite.close();
}
process.exit(code);
