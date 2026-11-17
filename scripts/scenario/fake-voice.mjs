#!/usr/bin/env node
// Стенд аудита сценария: «как на сайте» без настоящих mp3. Кладёт в dist/voice/el/ манифест озвучки ElevenLabs,
// в котором есть ровно то, что озвучено на сервере (voice-src/el_batch_all.jsonl), а вместо mp3 — тишина
// длительностью как у живой речи (≈ 0,45 с + 1 с на 14 символов). Так в headless работает строгий режим
// «только озвученные реплики», и видно, сколько звучит каждая реплика.
//
//   node scripts/scenario/fake-voice.mjs [dist] [K] [batch]   — K: во сколько раз ускорено время на стенде (длины делятся на K);
//   batch — какой набор считать озвученным (по умолчанию voice-src/el_batch_all.jsonl; для «до озвучки дельты» — прошлая версия)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
const K = Number(process.argv[3] ?? 1) || 1;
const out = path.join(dist, 'voice/el');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'fake'), { recursive: true });

const wav = (sec) => {
  const sr = 8000, n = Math.max(80, Math.round(sec * sr));
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
};
const files = new Map();
const fileFor = (d) => {
  const ms = Math.round((d / K) * 10) * 100; // корзины по 100 мс реального времени
  if (!files.has(ms)) {
    const f = `el/fake/s${ms}.wav`;
    fs.writeFileSync(path.join(dist, 'voice', f), wav(ms / 1000));
    files.set(ms, f);
  }
  return files.get(ms);
};
const man = { version: 2, source: 'elevenlabs', fake: true, lines: {}, templates: {} };
const jobs = fs.readFileSync(path.resolve(root, process.argv[4] ?? 'voice-src/el_batch_all.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
for (const j of jobs) {
  const txt = j.t ?? j.v ?? '';
  const d = +(0.45 + txt.length / 14).toFixed(2);
  const e = { f: fileFor(d), d, o: 0, c: 'X0', t: j.t };
  if (j.kind && j.kind !== 'line') e.kind = j.kind;
  if (j.kind === 'part') Object.assign(e, { line: j.line, part: j.part, slot: j.slot, ...(j.lead ? { lead: j.lead } : {}) });
  if (j.kind === 'slot') Object.assign(e, { slot: j.slot, v: j.v });
  man.lines[j.id] = e;
  if (j.kind === 'part') man.templates[j.line] = { t: j.tpl, slot: j.slot, parts: j.parts, persona: j.persona };
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(man));
console.log(`fake-voice: ${Object.keys(man.lines).length} записей, ${files.size} файлов тишины, K=${K} → ${out}`);
