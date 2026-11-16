#!/usr/bin/env node
// Манифест видео-клипов с альфой для спрайт-режима: public/video/<persona>/<clip>.{mov,webm} → public/video/manifest.json
// .mov — HEVC с альфой (Safari/iOS), .webm — VP9 с альфой (Chrome/Android). <clip> — id из content/animations.json.
// Запуск: npm run video-manifest
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public/video');
const clips = new Set(JSON.parse(fs.readFileSync(path.join(root, 'content/animations.json'), 'utf8')).clips.map((c) => c.id));
const out = { _comment: 'Генерируется scripts/video-manifest.mjs. Видео-клип есть — играет он, иначе PNG-позы (video/sprites), иначе риг.', personas: {} };
let n = 0;
for (const persona of fs.readdirSync(dir)) {
  const pd = path.join(dir, persona);
  if (persona === 'sprites' || !fs.statSync(pd).isDirectory()) continue;
  for (const f of fs.readdirSync(pd)) {
    const m = f.match(/^(.+)\.(mov|webm)$/);
    if (!m) continue;
    if (!clips.has(m[1])) console.warn(`⚠ ${persona}/${f}: нет клипа «${m[1]}» в content/animations.json`);
    const e = ((out.personas[persona] ??= {})[m[1]] ??= {});
    e[m[2] === 'mov' ? 'hevc' : 'webm'] = `video/${persona}/${f}`;
    n++;
  }
}
for (const [p, cs] of Object.entries(out.personas))
  for (const [c, e] of Object.entries(cs)) if (!e.hevc || !e.webm) console.warn(`⚠ ${p}/${c}: только ${e.hevc ? '.mov' : '.webm'} — ${e.hevc ? 'Chrome' : 'Safari'} покажет позы`);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`public/video/manifest.json: ${n} файлов`);
