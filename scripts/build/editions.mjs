#!/usr/bin/env node
// `npm run build` (между pull-server-voice и attach-extra): две редакции из одного дерева, docs/EDITIONS.md.
//   1) mvp → dist/      — VITE_EDITION=mvp, base как раньше (BASE_PATH ?? './'), public/ и сжатые модели — в dist/;
//   2) lab → dist/lab/  — VITE_EDITION=lab, base '/lab/', только index.html; public/ не копируется, модели не кладутся:
//      ассеты (models, voice, vosk, sounds, video, targets, stickers) — общие из корня (VITE_ASSET_BASE='/');
//      ключи localStorage и cookie id устройства — с префиксом 'lab:' (src/config/edition.ts).
// Обе сборки — в одном процессе: model-opt берёт сжатые модели из памяти/кэша, вторая сборка — секунды.
// AR_EDITIONS=mvp|lab|mvp,lab (по умолчанию обе) — собрать только одну.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const want = (process.env.AR_EDITIONS ?? 'mvp,lab').split(',').map((s) => s.trim());
// корень сайта для lab: BASE_PATH=/sub/ → lab в /sub/lab/, ассеты из /sub/
const siteRoot = /^\//.test(process.env.BASE_PATH ?? '') ? process.env.BASE_PATH.replace(/\/?$/, '/') : '/';

const KEYS = ['VITE_EDITION', 'AR_BUILD_LAB', 'LAB_BASE', 'VITE_ASSET_BASE', 'VITE_STORAGE_PREFIX'];
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
  lab: { VITE_EDITION: 'lab', AR_BUILD_LAB: '1', LAB_BASE: siteRoot + 'lab/', VITE_ASSET_BASE: siteRoot, VITE_STORAGE_PREFIX: 'lab:' },
};

const t0 = Date.now();
const times = [];
for (const ed of ['mvp', 'lab']) {
  if (!want.includes(ed)) continue;
  if (ed === 'lab' && !want.includes('mvp') && !fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.warn('editions: lab без mvp — в dist/ нет общих ассетов (models, voice…), lab будет без них');
  }
  const t = Date.now();
  setEnv(EDITIONS[ed]);
  console.log(`\neditions: сборка ${ed} → ${ed === 'lab' ? 'dist/lab/' : 'dist/'}`);
  await build({ root, configFile: path.join(root, 'vite.config.ts'), mode: 'production' });
  times.push(`${ed} ${((Date.now() - t) / 1000).toFixed(1)} с`);
}
setEnv({});
console.log(`editions: готово за ${((Date.now() - t0) / 1000).toFixed(1)} с (${times.join(', ')})`);
