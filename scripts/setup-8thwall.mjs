#!/usr/bin/env node
// Опционально: подключить 8th Wall Distributed Engine Binary (SLAM + Image Targets).
// Лицензия проприетарная (Niantic Spatial XR Engine License Agreement) — ставим только осознанно:
//   npm i --no-save @8thwall/engine-binary && npm run setup-8thwall
// Копирует dist/ движка в public/external/xr/ (папка в .gitignore — в репозиторий не попадает).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules/@8thwall/engine-binary/dist');
if (!fs.existsSync(src)) {
  console.error('Нет node_modules/@8thwall/engine-binary. Сначала: npm i --no-save @8thwall/engine-binary (прочитайте лицензию!)');
  process.exit(1);
}
const dst = path.join(root, 'public/external/xr');
fs.mkdirSync(dst, { recursive: true });
fs.cpSync(src, dst, { recursive: true });
console.log('Скопировано в', path.relative(root, dst), '— откройте ?tracker=8thwall (нужны targets/8thwall/card.json, см. docs/TRACKER_8THWALL.md)');
