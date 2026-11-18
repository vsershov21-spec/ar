#!/usr/bin/env node
// После `vite build`: докладывает в dist/ тяжёлые ассеты, которых нет в репозитории
// (озвучка Piper — voice/, офлайн-модель распознавания — models/vosk-*/). Источник — папка на сервере
// сборки, структура повторяет public/. Первая существующая и читаемая из: $AR_EXTRA_PUBLIC, /srv/ar-extra,
// /var/lib/vershov-commander/ar/public-extra. Нет ни одной (CI, ноутбук) — ничего не делает. Сборку не роняет.
// На swe сборку запускает systemd-сервис ar-update: домашняя папка пользователя ему не видна
// (/var/lib/private закрыт), поэтому рабочее место — /srv/ar-extra (создаёт root один раз, см. docs/DEPLOY.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readable = (d) => {
  try {
    fs.accessSync(d, fs.constants.R_OK | fs.constants.X_OK);
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};
const candidates = [process.env.AR_EXTRA_PUBLIC, '/srv/ar-extra', '/var/lib/vershov-commander/ar/public-extra'].filter(Boolean);
const src = candidates.find(readable) ?? '';
const dist = path.join(root, 'dist');
try {
  if (!src || !fs.existsSync(dist)) {
    if (process.env.CI !== 'true') console.log(`attach-extra: нет папки с озвучкой/моделью (${candidates.join(', ')}) — сборка без них`);
    process.exit(0);
  }
  let files = 0, bytes = 0;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.endsWith('.mp3.json')) continue; // .mp3.json — кэш сборки озвучки
      if (!rel && e.name === 'voice-el') continue; // сырьё ElevenLabs: в сайт его кладёт pull-server-voice (voice/el/)
      if (!rel && e.name === 'progress') continue; // данные сервиса прогресса (server/progress) — НЕ публиковать
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
