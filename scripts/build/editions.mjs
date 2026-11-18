#!/usr/bin/env node
// `npm run build` (между pull-server-voice и attach-extra): две редакции из одного дерева, docs/EDITIONS.md.
//   1) mvp → dist/      — VITE_EDITION=mvp, base как раньше (BASE_PATH ?? './'), public/ и сжатые модели — в dist/;
//   2) lab → dist/lab/  — VITE_EDITION=lab, base '/lab/', только index.html; public/ не копируется, модели не кладутся:
//      ассеты (models, voice, vosk, sounds, video, targets, stickers) — общие из корня (VITE_ASSET_BASE='/');
//      ключи localStorage и cookie id устройства — с префиксом 'lab:' (src/config/edition.ts);
//   3) pilot → dist/mvp/ — VITE_EDITION=pilot, base '/mvp/', как lab: только код, ассеты из корня, префикс 'pilot:'
//      (cookie pilot_ar_device), прогресс с edition:'pilot' (адрес https://ar.vershov.com/mvp, docs/EDITIONS.md «Пилот»).
// Обе сборки — в одном процессе: model-opt берёт сжатые модели из памяти/кэша, вторая сборка — секунды.
// AR_EDITIONS=mvp|lab|pilot|mvp,pilot… (по умолчанию все три) — собрать только часть.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const want = (process.env.AR_EDITIONS ?? 'mvp,lab,pilot').split(',').map((s) => s.trim());
// корень сайта для lab: BASE_PATH=/sub/ → lab в /sub/lab/, ассеты из /sub/
const siteRoot = /^\//.test(process.env.BASE_PATH ?? '') ? process.env.BASE_PATH.replace(/\/?$/, '/') : '/';

const KEYS = ['VITE_EDITION', 'AR_BUILD_LAB', 'AR_SUB_DIR', 'SUB_BASE', 'LAB_BASE', 'VITE_ASSET_BASE', 'VITE_STORAGE_PREFIX'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const setEnv = (env) => {
  for (const k of KEYS) {
    if (env[k] !== undefined) process.env[k] = env[k];
    else if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
};

const EDITIONS = {
  mvp: { VITE_EDITION: 'mvp', AR_BUILD_LAB: undefined, VITE_ASSET_BASE: undefined, VITE_STORAGE_PREFIX: undefined },
  lab: { VITE_EDITION: 'lab', AR_SUB_DIR: 'lab', SUB_BASE: siteRoot + 'lab/', VITE_ASSET_BASE: siteRoot, VITE_STORAGE_PREFIX: 'lab:' },
  pilot: { VITE_EDITION: 'pilot', AR_SUB_DIR: 'mvp', SUB_BASE: siteRoot + 'mvp/', VITE_ASSET_BASE: siteRoot, VITE_STORAGE_PREFIX: 'pilot:' },
};
const OUT = { mvp: 'dist/', lab: 'dist/lab/', pilot: 'dist/mvp/' };

const t0 = Date.now();
const times = [];
for (const ed of ['mvp', 'lab', 'pilot']) {
  if (!want.includes(ed)) continue;
  if (ed !== 'mvp' && !want.includes('mvp') && !fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.warn(`editions: ${ed} без mvp — в dist/ нет общих ассетов (models, voice…), ${ed} будет без них`);
  }
  const t = Date.now();
  setEnv(EDITIONS[ed]);
  console.log(`\neditions: сборка ${ed} → ${OUT[ed]}`);
  await build({ root, configFile: path.join(root, 'vite.config.ts'), mode: 'production' });
  times.push(`${ed} ${((Date.now() - t) / 1000).toFixed(1)} с`);
}
setEnv({});
console.log(`editions: готово за ${((Date.now() - t0) / 1000).toFixed(1)} с (${times.join(', ')})`);
