#!/usr/bin/env node
// Озвучка всех реплик Piper → готовые к вебу файлы + русский липсинк + манифест.
//
//   gen/voice_lines.csv (собирается `python3 content/build.py`)
//     → Piper (C++-релиз, батчем через --json-input), голос/темп из пресета характера
//     → обрезка тишины → сдвиг тона (src/audio/dsp.ts, фазовый вокодер) → −16 LUFS, пик −1.5 dBFS
//     → MP3 32 кбит/с моно 22.05 кГц (wasm-media-encoders: работает без ffmpeg)
//     → фонемы espeak-ng (ru) + выравнивание по сигналу → mouth cues A–H, X (src/lipsync/ru.ts)
//     → <out>/<persona>/<id>.<hash>.mp3 + <out>/<persona>.<hash>.json + <out>/manifest.json
//
// Реплики с {name}: текст режется на «префикс» и «суффикс», каждый озвучивается отдельно,
// плюс каждое имя из content/names.ru.txt — отдельным файлом. В рантайме склеиваются без пауз.
//
// Кэш: имя файла = id + хэш (текст, голос, тон, темп, версия обработки). Уже готовые файлы не пересобираются.
//
// Запуск (на машине, где есть Piper; ffmpeg не нужен):
//   PIPER_DIR=/tmp/piper PIPER_VOICES=/path/to/voices VOICE_OUT=/path/to/out/voice npm run voice:piper
//   флаги: --limit N (первые N реплик), --only <подстрока id>, --no-names, --compare N (сравнить липсинк), --force
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMp3Encoder } from 'wasm-media-encoders';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Импорт .ts из src/: Node 22.18+ снимает типы сам; иначе (сборка Node без TypeScript) — через oxc из vite */
async function importTs(rel) {
  const file = path.join(root, rel);
  try {
    return await import(file);
  } catch (e) {
    if (!/ERR_UNKNOWN_FILE_EXTENSION|ERR_NO_TYPESCRIPT/.test(e.code ?? '')) throw e;
    const { transformWithOxc } = await import('vite');
    const r = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' });
    const out = path.join(os.tmpdir(), `voice-${path.basename(rel, '.ts')}-${process.pid}.mjs`);
    fs.writeFileSync(out, r.code);
    try {
      return await import(out);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }
}
const dsp = await importTs('src/audio/dsp.ts');
const ru = await importTs('src/lipsync/ru.ts');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PIPELINE = 'v1'; // поменять, если меняется обработка — пересоберёт всё
const PIPER_DIR = process.env.PIPER_DIR || '/tmp/piper';
const VOICES = process.env.PIPER_VOICES || path.join(PIPER_DIR, '..', 'voices');
const OUT = path.resolve(process.env.VOICE_OUT || path.join(root, 'public/voice'));
const SR = 22050;
const BITRATE = Number(process.env.VOICE_KBPS || 32);
const limit = Number(opt('--limit', 0));
const only = opt('--only', '');
const compareN = Number(opt('--compare', 0));
const force = flag('--force');

// ───────────── входные данные ─────────────
function parseCsv(s) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(cur), (cur = '');
    else if (c === '\n') row.push(cur), rows.push(row), (row = []), (cur = '');
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  const [h, ...rest] = rows;
  return rest.filter((r) => r.length === h.length).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
let lines = parseCsv(fs.readFileSync(path.join(root, 'gen/voice_lines.csv'), 'utf8'));
if (only) lines = lines.filter((l) => l.id.includes(only));
if (limit) lines = lines.slice(0, limit);
const names = flag('--no-names')
  ? []
  : fs.readFileSync(path.join(root, 'content/names.ru.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

const presets = {};
for (const l of lines) presets[l.persona] ??= { voice: l.piper_voice, pitch: Number(l.pitch_semitones), rate: Number(l.rate) };

// ───────────── задания ─────────────
const hash = (...a) => crypto.createHash('sha1').update(a.join('\u0001')).digest('hex').slice(0, 8);
const jobs = []; // { persona, key, kind: line|part|name, text }
for (const l of lines) {
  if (l.has_name === '1' || l.text.includes('{name}')) {
    const [a, b] = l.text.split('{name}');
    if (a.trim()) jobs.push({ persona: l.persona, key: `${l.id}~a`, kind: 'part', line: l.id, slot: 'a', text: a.trim() });
    if (b.replace(/^[\s,.!?]+$/, '').trim()) jobs.push({ persona: l.persona, key: `${l.id}~b`, kind: 'part', line: l.id, slot: 'b', text: b.trim(), lead: b.match(/^[,.!?…]*/)[0] });
    jobs.push({ persona: l.persona, key: l.id, kind: 'template', text: l.text });
  } else jobs.push({ persona: l.persona, key: l.id, kind: 'line', text: l.text, event: l.event, emotion: l.emotion });
}
if (names.length) for (const p of Object.keys(presets)) for (const n of names) jobs.push({ persona: p, key: `name:${n}`, kind: 'name', text: n });
const fname = (j) => j.key.replace(/^name:/, 'name_').replace(/[^a-zA-Zа-яА-ЯёЁ0-9._~-]/g, '_').replace(/~/g, '__');
for (const j of jobs) {
  if (j.kind === 'template') continue;
  const pr = presets[j.persona];
  j.hash = hash(PIPELINE, j.text, pr.voice, pr.pitch, pr.rate, BITRATE);
  j.rel = `${j.persona}/${fname(j)}.${j.hash}.mp3`;
  j.file = path.join(OUT, j.rel);
}

// ───────────── Piper ─────────────
function piperBatch(voice, rate, items, tmp) {
  if (!items.length) return;
  const model = path.join(VOICES, `${voice}.onnx`);
  if (!fs.existsSync(model)) throw new Error(`нет модели ${model} (PIPER_VOICES)`);
  const input = items.map((j) => JSON.stringify({ text: synthText(j), output_file: path.join(tmp, `${j.hash}.wav`) })).join('\n') + '\n';
  const r = spawnSync(path.join(PIPER_DIR, 'piper'), ['-q', '-m', model, '--espeak_data', path.join(PIPER_DIR, 'espeak-ng-data'), '--json-input',
    '--length_scale', String(+(1 / rate).toFixed(3)), '--noise_scale', '0.6', '--noise_w', '0.75', '--sentence_silence', '0.15'],
  { input, cwd: PIPER_DIR, env: { ...process.env, LD_LIBRARY_PATH: PIPER_DIR }, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`piper: ${r.stderr}`);
}
/** текст для синтеза: имя — с восклицанием, так оно звучит как обращение */
const synthText = (j) => (j.kind === 'name' ? `${j.text}!` : j.text);

function espeakBin() {
  const local = path.join(PIPER_DIR, 'espeak-ng');
  if (fs.existsSync(local)) return { bin: local, args: ['--path', PIPER_DIR], env: { LD_LIBRARY_PATH: PIPER_DIR } };
  const r = spawnSync('espeak-ng', ['--version']);
  return r.status === 0 ? { bin: 'espeak-ng', args: [], env: {} } : null;
}
const ESPEAK = espeakBin();
function ipa(text) {
  if (!ESPEAK) return null;
  const r = spawnSync(ESPEAK.bin, [...ESPEAK.args, '-v', 'ru', '-q', '--ipa'], { input: text.replace(/[«»"]/g, ''), encoding: 'utf8', env: { ...process.env, ...ESPEAK.env } });
  return r.status === 0 ? r.stdout : null;
}

function readWav(file) {
  const b = fs.readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12, sr = 0, ch = 1, data = null;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4), sz = dv.getUint32(o + 4, true);
    if (id === 'fmt ') (ch = dv.getUint16(o + 10, true)), (sr = dv.getUint32(o + 12, true));
    if (id === 'data') data = { off: o + 8, len: Math.min(sz, b.length - o - 8) };
    o += 8 + sz + (sz & 1);
  }
  if (!data) throw new Error(`битый wav ${file}`);
  const n = Math.floor(data.len / 2 / ch);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = dv.getInt16(data.off + i * 2 * ch, true) / 32768;
  return { sr, x };
}

const packCues = (cues) => cues.map((c) => `${c.value}${Math.round(c.start * 1000)}`).join(' ');
const onset = (f) => {
  let mx = 0;
  for (const r of f.rms) mx = Math.max(mx, r);
  for (let i = 0; i < f.rms.length; i++) if (f.rms[i] > mx * 0.1) return +(i * f.step).toFixed(3);
  return 0;
};

// ───────────── основной цикл ─────────────
const enc = await createMp3Encoder();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
const todo = jobs.filter((j) => j.file && (force || !fs.existsSync(j.file) || !fs.existsSync(j.file + '.json')));
console.log(`Реплик: ${lines.length}, заданий: ${jobs.filter((j) => j.file).length}, к синтезу: ${todo.length}. Вывод: ${OUT}`);
console.log(`Фонемы: ${ESPEAK ? ESPEAK.bin : 'буквенные правила (espeak-ng не найден)'}`);
const t0 = Date.now();
const groups = new Map();
for (const j of todo) {
  const pr = presets[j.persona];
  const k = `${pr.voice}|${pr.rate}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(j);
}
const compare = [];
for (const [k, items] of groups) {
  const [voice, rate] = k.split('|');
  for (let i = 0; i < items.length; i += 60) {
    const chunk = items.slice(i, i + 60);
    piperBatch(voice, Number(rate), chunk, tmp);
    for (const j of chunk) {
      const wav = path.join(tmp, `${j.hash}.wav`);
      const { sr, x } = readWav(wav);
      if (sr !== SR) throw new Error(`ожидалась частота ${SR}, у ${wav} ${sr}`);
      let y = dsp.trimSilence(x, sr, -45, 0.05);
      y = dsp.pitchShift(y, sr, presets[j.persona].pitch, 1);
      y = dsp.normalizeLoudness(y, sr, -16, -1.5);
      y = dsp.fadeEdges(y, sr, 6);
      enc.configure({ sampleRate: sr, channels: 1, bitrate: BITRATE });
      const mp3 = Buffer.concat([Buffer.from(enc.encode([y])), Buffer.from(enc.finalize())]);
      const dur = y.length / sr;
      const f = dsp.frames(y, sr);
      const ipaText = ipa(j.text);
      const phones = ipaText ? ru.phonesFromIpa(ipaText) : ru.phonesFromText(j.text);
      const cues = ru.cuesFromAlignment(phones, ru.alignPhones(phones, f), dur);
      fs.mkdirSync(path.dirname(j.file), { recursive: true });
      fs.writeFileSync(j.file, mp3);
      const meta = { d: +dur.toFixed(3), o: onset(f), c: packCues(cues), lips: ipaText ? 'ru-espeak-align' : 'ru-letters-align', bytes: mp3.length };
      fs.writeFileSync(j.file + '.json', JSON.stringify(meta));
      if (compare.length < compareN && j.kind === 'line') compare.push({ j, f, dur, phones, cues });
      fs.rmSync(wav);
    }
    process.stdout.write(`  ${voice}: ${Math.min(i + 60, items.length)}/${items.length}\r`);
  }
  process.stdout.write('\n');
}
fs.rmSync(tmp, { recursive: true, force: true });

// ───────────── манифест ─────────────
const byPersona = {};
let totalBytes = 0, totalDur = 0;
for (const j of jobs) {
  const m = (byPersona[j.persona] ??= { persona: j.persona, format: 'mp3', lines: {}, parts: {}, names: {} });
  if (j.kind === 'template') {
    m.parts[j.key] ??= {};
    m.parts[j.key].t = j.text;
    continue;
  }
  if (!fs.existsSync(j.file + '.json')) continue;
  const meta = JSON.parse(fs.readFileSync(j.file + '.json', 'utf8'));
  totalBytes += meta.bytes;
  totalDur += meta.d;
  const e = { f: j.rel, d: meta.d, o: meta.o, c: meta.c };
  if (j.kind === 'line') m.lines[j.key] = { ...e, t: j.text };
  else if (j.kind === 'name') m.names[j.text] = e;
  else (m.parts[j.line] ??= {})[j.slot] = j.lead ? { ...e, lead: j.lead } : e;
}
const top = { version: 1, generated: new Date().toISOString(), pipeline: PIPELINE, codec: `mp3 ${BITRATE}k mono ${SR}`, lipsync: ESPEAK ? 'ru-espeak-align' : 'ru-letters-align', personas: {} };
for (const [p, m] of Object.entries(byPersona)) {
  const body = JSON.stringify(m);
  const h = hash(body);
  const rel = `${p}.${h}.json`;
  for (const f of fs.readdirSync(OUT).filter((f) => f.startsWith(`${p}.`) && f.endsWith('.json') && f !== rel)) fs.rmSync(path.join(OUT, f));
  fs.writeFileSync(path.join(OUT, rel), body);
  top.personas[p] = { manifest: rel, lines: Object.keys(m.lines).length, names: Object.keys(m.names).length, templates: Object.keys(m.parts).length, voice: presets[p] };
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(top, null, 1));
// удалить устаревшие файлы (текст поменялся → новый хэш)
const live = new Set(jobs.filter((j) => j.file).flatMap((j) => [j.file, j.file + '.json']));
let removed = 0;
if (!only && !limit) {
  for (const p of Object.keys(byPersona)) {
    const d = path.join(OUT, p);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (!live.has(path.join(d, f))) fs.rmSync(path.join(d, f)), removed++;
  }
}
console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(0)} с: ${Object.values(top.personas).map((p) => `${p.lines}`).join('+')} реплик, ` +
  `звук ${(totalDur / 60).toFixed(1)} мин, ${(totalBytes / 1048576).toFixed(2)} МБ, удалено устаревших: ${removed}`);

// ───────────── сравнение стратегий липсинка ─────────────
if (compare.length) {
  console.log('\nСравнение липсинка (корреляция раскрытия рта с огибающей сигнала; смыкания М/Б/П на провалах громкости):');
  console.log('id | фонемы: corr, формы, смыкания | амплитуда: corr, формы');
  let sp = 0, sa = 0;
  for (const c of compare) {
    const n = c.f.rms.length;
    const env = Array.from(c.f.rms, (r) => Math.max(0, 20 * Math.log10(Math.max(r, 1e-5)) + 60));
    const amp = ru.cuesFromAmplitude(c.f, c.dur);
    const cp = ru.correlation(ru.opennessTrack(c.cues, c.f.step, n), env);
    const ca = ru.correlation(ru.opennessTrack(amp, c.f.step, n), env);
    // смыкания: доля cue «A», у которых громкость внутри ниже соседних гласных
    const As = c.cues.filter((q) => q.value === 'A');
    const dip = As.filter((q) => {
      const a = Math.floor(q.start / c.f.step), b = Math.ceil(q.end / c.f.step);
      const inside = Math.min(...env.slice(a, Math.max(a + 1, b)));
      const around = Math.max(...env.slice(Math.max(0, a - 8), a), ...env.slice(b, b + 8), 0);
      return inside < around - 3;
    }).length;
    const shapes = (q) => new Set(q.map((x) => x.value)).size;
    sp += cp;
    sa += ca;
    console.log(`${c.j.key} | ${cp.toFixed(2)}, ${shapes(c.cues)}, ${dip}/${As.length} | ${ca.toFixed(2)}, ${shapes(amp)}`);
  }
  console.log(`среднее corr: фонемы ${(sp / compare.length).toFixed(2)}, амплитуда ${(sa / compare.length).toFixed(2)}`);
}
