#!/usr/bin/env node
// После сборки (npm run build, последний шаг): окно совместимости хэшированных ассетов (PERF-02, аудит пилота 24.11).
//
// Страница, открытая до релиза (вкладка Safari в фоне, bfcache, старый HTML в кэше), догружает ленивые чанки и модели
// по СВОИМ хэшам: /mvp/assets/<чанк>-<старый хэш>.js, /models/opt/<модель>.<старый хэш>.glb. ar-update выкладывает
// каждый релиз в новую папку — старых имён там нет, и Caddy отвечал HTML корня (теперь — 404). Поэтому:
//   · общий пул POOL (/srv/ar/asset-pool на сервере сборки) хранит по одному экземпляру каждого хэшированного файла
//     из KEEP_DIRS и время, когда он последний раз был «своим» в релизе (.index.json);
//   · в dist/ для файлов пула, которых в новой сборке нет и которым меньше WINDOW_MS, кладутся симлинки на пул
//     (ar-update копирует dist/ через `cp -a` — симлинки остаются симлинками, место не удваивается;
//     Caddy file_server идёт по симлинку);
//   · старше окна — из пула удаляются; пул больше CAP_BYTES — удаляются самые старые.
//   · Первый запуск (пула ещё нет) — забирает ассеты текущего релиза (/srv/ar/current), чтобы окно работало сразу.
// Нет пула и текущего релиза (CI, ноутбук, e2e) — ничего не делает. Сборку не роняет.
//   AR_ASSET_POOL=<папка> — свой пул; AR_PREV_RELEASE=<папка> — прошлый релиз; AR_ASSET_WINDOW_H — окно, часов.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** папки с хэшированными именами (vite: <имя>-<хэш>.<ext>; модели: <имя>.<хэш>.glb) */
export const KEEP_DIRS = ['assets', 'mvp/assets', 'lab/assets', 'test/assets', 'models/opt'];
export const WINDOW_MS = 48 * 3600_000;
export const CAP_BYTES = 1024 ** 3;
const INDEX = '.index.json';

const isDir = (d) => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};
/** обычные файлы (не симлинки) папок KEEP_DIRS → относительные пути */
function ownFiles(root) {
  const out = [];
  for (const d of KEEP_DIRS) {
    const abs = path.join(root, d);
    if (!isDir(abs)) continue;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (e.isFile() && !e.name.startsWith('.')) out.push(path.posix.join(d, e.name));
  }
  return out;
}
/** link — жёсткая ссылка (файлы прошлого релиза не меняются); из dist/ — копия (следующая сборка пишет в dist/) */
function place(src, dst, link = false) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (link) {
    try {
      fs.linkSync(src, dst);
      return;
    } catch {
      /* другая ФС */
    }
  }
  fs.copyFileSync(src, dst);
}

/**
 * dist — новая сборка; pool — общий пул; prev — прошлый релиз (только для первого заполнения пула).
 * → { kept, added, dropped, bytes }
 */
export function keepAssets({ dist, pool, prev = null, now = Date.now(), windowMs = WINDOW_MS, capBytes = CAP_BYTES, log = () => {} }) {
  fs.mkdirSync(pool, { recursive: true });
  const idxFile = path.join(pool, INDEX);
  let idx = {};
  try {
    idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  } catch {
    idx = {};
  }
  const own = new Set(ownFiles(dist));
  let added = 0;
  // первое заполнение: ассеты прошлого релиза (его «свои» файлы, без симлинков) — вытеснены сейчас
  if (prev && isDir(prev) && path.resolve(prev) !== path.resolve(dist)) {
    for (const rel of ownFiles(prev)) {
      if (own.has(rel) || idx[rel]) continue;
      place(path.join(prev, rel), path.join(pool, rel), true);
      idx[rel] = now;
      added++;
    }
  }
  // свои файлы новой сборки — в пул (имя с хэшем = содержимое, повтор не копируем), отметка «свой сейчас»
  for (const rel of own) {
    const p = path.join(pool, rel);
    if (!fs.existsSync(p)) {
      place(path.join(dist, rel), p);
      added++;
    }
    idx[rel] = now;
  }
  // вне окна или файла в пуле уже нет — прочь
  let dropped = 0;
  for (const rel of Object.keys(idx)) {
    const p = path.join(pool, rel);
    if (now - idx[rel] > windowMs || !fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      delete idx[rel];
      dropped++;
    }
  }
  // предел размера: самые давние из чужих
  const size = (rel) => {
    try {
      return fs.statSync(path.join(pool, rel)).size;
    } catch {
      return 0;
    }
  };
  let bytes = Object.keys(idx).reduce((s, r) => s + size(r), 0);
  for (const rel of Object.keys(idx).filter((r) => !own.has(r)).sort((a, b) => idx[a] - idx[b])) {
    if (bytes <= capBytes) break;
    bytes -= size(rel);
    fs.rmSync(path.join(pool, rel), { force: true });
    delete idx[rel];
    dropped++;
  }
  // чужие файлы окна — симлинками в новую сборку
  let kept = 0;
  for (const rel of Object.keys(idx)) {
    if (own.has(rel)) continue;
    const dst = path.join(dist, rel);
    if (!isDir(path.dirname(dst))) fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.rmSync(dst, { force: true });
      fs.symlinkSync(path.resolve(pool, rel), dst);
      kept++;
    } catch (e) {
      log(`keep-assets: ${rel}: ${e.message}`);
    }
  }
  fs.writeFileSync(idxFile, JSON.stringify(idx));
  return { kept, added, dropped, bytes };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dist = path.join(root, 'dist');
  const writable = (d) => {
    try {
      fs.accessSync(d, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  // пул — только на сервере сборки (рядом с релизами) или явно
  const pool = process.env.AR_ASSET_POOL || (isDir('/srv/ar/releases') && writable('/srv/ar') ? '/srv/ar/asset-pool' : '');
  const prev = process.env.AR_PREV_RELEASE || (isDir('/srv/ar/current') ? '/srv/ar/current' : null);
  try {
    if (!pool || !isDir(dist)) {
      if (process.env.CI !== 'true') console.log('keep-assets: нет пула ассетов (/srv/ar/asset-pool, AR_ASSET_POOL) — окно совместимости не нужно');
      process.exit(0);
    }
    const windowMs = Number(process.env.AR_ASSET_WINDOW_H) > 0 ? Number(process.env.AR_ASSET_WINDOW_H) * 3600_000 : WINDOW_MS;
    const r = keepAssets({ dist, pool, prev, windowMs, log: console.warn });
    console.log(`keep-assets: прошлых ассетов в релизе ${r.kept} (окно ${windowMs / 3600_000} ч), в пул +${r.added}, удалено ${r.dropped}, пул ${(r.bytes / 1048576).toFixed(1)} МБ (${pool})`);
  } catch (e) {
    console.warn(`keep-assets: пропущено (${e.message})`);
  }
}
