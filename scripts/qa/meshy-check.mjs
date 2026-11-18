#!/usr/bin/env node
// Проверка клипов Meshy локально, до выкладки (docs/animations/MESHY.md §8): папка со скачанными <id>.glb
// (и manifest.json с сервера, если есть) → стенд реакций пилота (scripts/qa/reactions.mjs) с этими клипами.
//
//   node scripts/qa/meshy-check.mjs ~/meshy                       — все коты, все сценарии, тег meshy, сравнение с before
//   node scripts/qa/meshy-check.mjs ~/meshy --vs now --cats kind --only act_treat,act_hug
//   node scripts/qa/meshy-check.mjs ~/meshy --dry                 — только проверить папку и манифест
//
// Нет manifest.json — собирается из имён файлов (id = имя без .glb; петля — meshy.loop из content/animations.json).
// Файлы не копируются: стенд отдаёт /models/anims/meshy/* прямо из папки (reactions.mjs --meshy). Итог — docs/qa/REACTIONS.md
// (раздел «Проникновение», заглушки, щелчки) + состояния клипов в логе: загружен / нет / отвергнут (причина).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const dirArg = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.match(/^--(vs|cats|only|tag|params|port)$/));
if (!dirArg) {
  console.error('нужна папка с клипами: node scripts/qa/meshy-check.mjs <папка> [--vs before] [--cats …] [--only …] [--dry]');
  process.exit(2);
}
const dir = path.resolve(dirArg.replace(/^~(?=\/|$)/, os.homedir()));
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`нет папки ${dir}`);
  process.exit(2);
}

const anim = JSON.parse(fs.readFileSync(path.join(root, 'content/animations.json'), 'utf8'));
const rules = new Map(anim.clips.filter((c) => c.meshy).map((c) => [c.id, c.meshy]));
const glbs = fs.readdirSync(dir).filter((f) => /^[\w.-]+\.glb$/.test(f));
let manifest = null;
const mf = path.join(dir, 'manifest.json');
if (fs.existsSync(mf)) {
  manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const have = new Set(glbs);
  const lost = (manifest.clips ?? []).filter((c) => !have.has(c.file ?? `${c.id}.glb`));
  if (lost.length) console.warn(`в манифесте, но нет файла: ${lost.map((c) => c.id).join(', ')}`);
} else {
  manifest = { generated: 'meshy-check', clips: glbs.map((f) => ({ id: f.replace(/\.glb$/, ''), file: f, loop: rules.get(f.replace(/\.glb$/, ''))?.loop ?? false })) };
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
  console.log(`manifest.json собран из ${glbs.length} файлов → ${mf}`);
}
const ids = new Set((manifest.clips ?? []).map((c) => c.id));
const missing = [...rules.keys()].filter((id) => !ids.has(id));
const extra = [...ids].filter((id) => !rules.has(id));
console.log(`клипов: ${ids.size} из ${rules.size} ожидаемых; нет: ${missing.length ? missing.join(', ') : '—'}${extra.length ? `; лишние (не в каталоге): ${extra.join(', ')}` : ''}`);
if (argv.includes('--dry')) process.exit(0);

// стенд реакций с этими клипами: свой тег, сравнение с прошлым прогоном (по умолчанию before)
const pass = [];
const take = (n, d) => {
  const i = argv.indexOf(n);
  if (i >= 0) pass.push(n, argv[i + 1]);
  else if (d !== undefined) pass.push(n, d);
};
take('--tag', 'meshy');
take('--vs', 'before');
take('--cats');
take('--only');
take('--params');
take('--port');
for (const f of ['--no-build', '--no-sheets']) if (argv.includes(f)) pass.push(f);
const r = spawnSync(process.execPath, [path.join(root, 'scripts/qa/reactions.mjs'), '--meshy', dir, ...pass], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
