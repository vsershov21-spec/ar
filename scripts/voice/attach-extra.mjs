#!/usr/bin/env node
// После `vite build`: докладывает в dist/ тяжёлые ассеты, которых нет в репозитории
// (озвучка Piper — voice/, офлайн-модель распознавания — models/vosk-*/). Источник — папка на сервере
// сборки: $AR_EXTRA_PUBLIC (по умолчанию /var/lib/vershov-commander/ar/public-extra), её структура
// повторяет public/. Если папки нет (CI, ноутбук разработчика) — ничего не делает. Сборку никогда не роняет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = process.env.AR_EXTRA_PUBLIC || '/var/lib/vershov-commander/ar/public-extra';
const dist = path.join(root, 'dist');
try {
  if (!fs.existsSync(src) || !fs.existsSync(dist)) process.exit(0);
  let files = 0, bytes = 0;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.endsWith('.mp3.json')) continue; // .mp3.json — кэш сборки озвучки
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(path.join(dist, r), { recursive: true });
        walk(r);
      } else if (e.isFile()) {
        fs.copyFileSync(path.join(src, r), path.join(dist, r));
        files++;
        bytes += fs.statSync(path.join(src, r)).size;
      }
    }
  };
  walk('');
  console.log(`attach-extra: ${files} файлов, ${(bytes / 1048576).toFixed(1)} МБ из ${src}`);
} catch (e) {
  console.warn(`attach-extra: пропущено (${e.message})`);
}
