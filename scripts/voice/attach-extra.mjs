#!/usr/bin/env node
// После `vite build`: докладывает в dist/ тяжёлые ассеты, которых нет в репозитории
// (озвучка Piper — voice/, офлайн-модель распознавания — models/vosk-*/). Источник — папка на сервере
// сборки, структура повторяет public/. Первая существующая и читаемая из: $AR_EXTRA_PUBLIC, /srv/ar-extra,
// /var/lib/vershov-commander/ar/public-extra. Нет ни одной (CI, ноутбук) — ничего не делает. Сборку не роняет.
// На swe сборку запускает systemd-сервис ar-update: домашняя папка пользователя ему не видна
// (/var/lib/private закрыт), поэтому рабочее место — /srv/ar-extra (создаёт root один раз, см. docs/DEPLOY.md).
// Нечитаемый файл или папка (например, root:root 600 после генерации под umask 077) — пропуск с предупреждением,
// остальное копируется: из-за одного файла релиз не должен терять Vosk и озвучку.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** служебные файлы генераций (Meshy image-to-3D и т.п.): в релиз не идут */
export const SERVICE_FILE_RE = [/_task\.json$/, /_img\d+\.png$/, /_thumb_[^/]*\.png$/, /_geo\.glb$/];

/** true — запись не копировать в dist. rel — путь родительской папки относительно источника ('' — корень) */
export function skipEntry(rel, name, isDir = false) {
  if (name.startsWith('.')) return true;
  if (!rel && (name === 'voice-el' || name === 'progress')) return true; // сырьё ElevenLabs (его кладёт pull-server-voice) и данные сервиса прогресса
  if (isDir) return false;
  if (name.endsWith('.mp3.json')) return true; // кэш сборки озвучки
  return SERVICE_FILE_RE.some((re) => re.test(name));
}

const readableDir = (d) => {
  try {
    fs.accessSync(d, fs.constants.R_OK | fs.constants.X_OK);
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};

/** копирование src → dist; { files, bytes, skipped: [{ path, reason }] } */
export function attachExtra(src, dist, warn = (m) => console.warn(m)) {
  let files = 0, bytes = 0;
  const skipped = [];
  const skip = (r, e) => {
    skipped.push({ path: r, reason: e.code || e.message });
    warn(`attach-extra: пропуск ${r} (${e.code || e.message})`);
  };
  const walk = (rel) => {
    let list;
    try {
      list = fs.readdirSync(path.join(src, rel), { withFileTypes: true });
    } catch (e) {
      return skip(rel || '.', e);
    }
    for (const e of list) {
      const r = path.join(rel, e.name);
      if (skipEntry(rel, e.name, e.isDirectory())) continue;
      if (e.isDirectory()) {
        if (!readableDir(path.join(src, r))) {
          skip(r, { code: 'EACCES' });
          continue;
        }
        fs.mkdirSync(path.join(dist, r), { recursive: true });
        walk(r);
      } else if (e.isFile()) {
        try {
          fs.copyFileSync(path.join(src, r), path.join(dist, r));
          files++;
          bytes += fs.statSync(path.join(src, r)).size;
        } catch (err) {
          skip(r, err);
        }
      }
    }
  };
  walk('');
  return { files, bytes, skipped };
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const candidates = [process.env.AR_EXTRA_PUBLIC, '/srv/ar-extra', '/var/lib/vershov-commander/ar/public-extra'].filter(Boolean);
  const src = candidates.find(readableDir) ?? '';
  const dist = path.join(root, 'dist');
  try {
    if (!src || !fs.existsSync(dist)) {
      if (process.env.CI !== 'true') console.log(`attach-extra: нет папки с озвучкой/моделью (${candidates.join(', ')}) — сборка без них`);
    } else {
      const r = attachExtra(src, dist);
      console.log(`attach-extra: ${r.files} файлов, ${(r.bytes / 1048576).toFixed(1)} МБ из ${src}` + (r.skipped.length ? `; пропущено нечитаемых: ${r.skipped.length}` : ''));
    }
  } catch (e) {
    console.warn(`attach-extra: пропущено (${e.message})`);
  }
}
