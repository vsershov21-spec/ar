#!/usr/bin/env node
// Озвучка ElevenLabs для самых частых реплик (~50 на характер); остальное остаётся на Piper.
//
//   node scripts/voice/eleven.mjs --plan            — только отбор: список id и сумма символов (без сети)
//   ELEVEN_KEY_FILE=… VOICE_EL_OUT=… node scripts/voice/eleven.mjs --run [--max-chars 15000]
//
// Запуск с сети — только на swe (из контейнера API закрыт). Ключ читается из файла внутри процесса и никуда
// не выводится. Голос/модель — content/src/<id>.meta.json → voice.elevenVoiceId / elevenModel.
// Интонация — английские пометки в квадратных скобках по emotion ([excited], [softly] …): eleven_v4 их играет,
// русские пометки читались бы вслух.
// Обработка: mp3_44100_128 → декодирование (mpg123-decoder, wasm) → −16 LUFS, пик −1.5 dBFS → MP3 64k моно 44.1 кГц
// (wasm-media-encoders) → русские cues (espeak-ng + выравнивание, как у Piper) → <out>/<persona>/<lineId>.mp3 + manifest.json.
// Возобновляемо: уже озвученные (тот же текст/голос/пометка) пропускаются. Один дубль на реплику, запросы по одному,
// пауза 300 мс, при 429/5xx — ожидание и повтор.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PER_PERSONA = Number(opt('--per', 50));
const MAX_CHARS = Number(opt('--max-chars', 15000));
const OUT = path.resolve(process.env.VOICE_EL_OUT || '/var/lib/vershov-commander/ar/voice-el');

// события по частоте показа (порядок = приоритет)
export const EL_EVENTS = ['intro', 'point_camera', 'ask_name', 'nice_name', 'no_name', 'choose', 'invite', 'tap_screen', 'tap_cat',
  'tap_cat_head', 'tap_cat_belly', 'tap_cat_paw', 'tap_cat_tail', 'tap_cat_cheek', 'stroke', 'stroke_long', 'swipe', 'longpress',
  'double_tap', 'gum', 'shake', 'spam', 'card_lost', 'card_found', 'hello', 'bye', 'yes', 'no', 'unknown', 'silence', 'filler',
  'money', 'sberkids', 'sad', 'scared', 'echo_start', 'echo_done', 'echo_stop', 'loud', 'switch_start', 'shake_prompt', 'hello_new',
  'outro', 'welcome_back'];

const TAGS = {
  happy: '[cheerfully]', excited: '[excited]', cheeky: '[mischievously]', caring: '[softly]', sad: '[sadly]', surprised: '[surprised]',
  shy: '[shyly]', proud: '[proudly]', annoyed: '[annoyed]', playful: '[playfully]', whisper: '[whispers]', sleepy: '[sleepily]',
  offended: '[sulking]', worried: '[worried]', curious: '[curious]', tender: '[softly]', bored: '[bored]', confused: '[confused]',
};

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

/** отбор: по событиям в порядке приоритета, круг за кругом по одному варианту, пока не наберём PER_PERSONA */
export function selectLines(lines, per = PER_PERSONA, maxChars = MAX_CHARS) {
  const byP = new Map();
  for (const l of lines) {
    if (l.text.includes('{')) continue;
    const ev = EL_EVENTS.indexOf(l.event);
    if (ev < 0) continue;
    if (!byP.has(l.persona)) byP.set(l.persona, new Map());
    const m = byP.get(l.persona);
    if (!m.has(ev)) m.set(ev, []);
    m.get(ev).push(l);
  }
  const out = [];
  for (const m of byP.values()) {
    const evs = [...m.keys()].sort((a, b) => a - b);
    const picked = [];
    for (let round = 0; picked.length < per; round++) {
      let any = false;
      for (const e of evs) {
        const v = m.get(e)[round];
        if (v && picked.length < per) picked.push(v), (any = true);
      }
      if (!any) break;
    }
    out.push(...picked);
  }
  // общий лимит символов: срезаем с конца приоритета, поровну по характерам
  const cost = (l) => elText(l).length;
  let total = out.reduce((a, l) => a + cost(l), 0);
  const prio = (l) => EL_EVENTS.indexOf(l.event);
  while (total > maxChars && out.length) {
    out.sort((a, b) => prio(a) - prio(b));
    const x = out.pop();
    total -= cost(x);
  }
  return out;
}
export const elText = (l) => (TAGS[l.emotion] ? `${TAGS[l.emotion]} ${l.text}` : l.text);

const meta = {};
for (const f of fs.readdirSync(path.join(root, 'content/src')).filter((f) => f.endsWith('.meta.json'))) {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'content/src', f), 'utf8'));
  meta[m.id] = m.voice;
}
const lines = parseCsv(fs.readFileSync(path.join(root, 'gen/voice_lines.csv'), 'utf8'));
const sel = selectLines(lines);
const chars = sel.reduce((a, l) => a + elText(l).length, 0);
const byPersona = sel.reduce((a, l) => ((a[l.persona] = (a[l.persona] ?? 0) + 1), a), {});

if (flag('--plan') || !flag('--run')) {
  console.log(`Отобрано ${sel.length} реплик (${Object.entries(byPersona).map(([p, n]) => `${p} ${n}`).join(', ')}), символов с пометками: ${chars} (лимит ${MAX_CHARS})`);
  if (flag('--list')) for (const l of sel) console.log(`${l.id}\t${elText(l)}`);
  process.exit(0);
}

// ───────────── синтез (только на swe) ─────────────
async function importTs(rel) {
  const file = path.join(root, rel);
  try {
    return await import(file);
  } catch (e) {
    if (!/ERR_UNKNOWN_FILE_EXTENSION|ERR_NO_TYPESCRIPT/.test(e.code ?? '')) throw e;
    const amaro = (await import('amaro')).default;
    const out = path.join(os.tmpdir(), `el-${path.basename(rel, '.ts')}-${process.pid}.mjs`);
    fs.writeFileSync(out, amaro.transformSync(fs.readFileSync(file, 'utf8'), { mode: 'strip-only' }).code);
    try {
      return await import(out);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }
}
const dsp = await importTs('src/audio/dsp.ts');
const ru = await importTs('src/lipsync/ru.ts');
const { createMp3Encoder } = await import('wasm-media-encoders');
const { MPEGDecoder } = await import('mpg123-decoder');

const keyFile = process.env.ELEVEN_KEY_FILE || '/var/lib/vershov-commander/.elevenlabs_key';
const KEY = fs.readFileSync(keyFile, 'utf8').trim(); // не выводить
const PIPER_DIR = process.env.PIPER_DIR || '/tmp/piper';
const espeak = fs.existsSync(path.join(PIPER_DIR, 'espeak-ng'))
  ? { bin: path.join(PIPER_DIR, 'espeak-ng'), args: ['--path', PIPER_DIR], env: { LD_LIBRARY_PATH: PIPER_DIR } }
  : spawnSync('espeak-ng', ['--version']).status === 0 ? { bin: 'espeak-ng', args: [], env: {} } : null;
const ipa = (t) => {
  if (!espeak) return null;
  const r = spawnSync(espeak.bin, [...espeak.args, '-v', 'ru', '-q', '--ipa'], { input: t.replace(/[«»"]/g, ''), encoding: 'utf8', env: { ...process.env, ...espeak.env } });
  return r.status === 0 ? r.stdout : null;
};

const manPath = path.join(OUT, 'manifest.json');
const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : { version: 1, source: 'elevenlabs', lines: {} };
const dec = new MPEGDecoder();
await dec.ready;
const enc = await createMp3Encoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let used = 0, done = 0, skipped = 0, failed = 0, bytes = 0;
console.log(`ElevenLabs: ${sel.length} реплик, ${chars} символов. Вывод: ${OUT}`);
for (const l of sel) {
  const v = meta[l.persona];
  if (!v?.elevenVoiceId) {
    failed++;
    continue;
  }
  const text = elText(l);
  const h = crypto.createHash('sha1').update([text, v.elevenVoiceId, v.elevenModel ?? 'eleven_v4', 'el1'].join('\u0001')).digest('hex').slice(0, 8);
  const rel = `${l.persona}/${l.id}.mp3`;
  if (man.lines[l.id]?.h === h && fs.existsSync(path.join(OUT, rel))) {
    skipped++;
    continue;
  }
  let audio = null;
  for (let attempt = 0; attempt < 5 && !audio; attempt++) {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.elevenVoiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: v.elevenModel ?? 'eleven_v4' }),
    }).catch(() => null);
    if (r?.ok) audio = new Uint8Array(await r.arrayBuffer());
    else {
      const st = r?.status ?? 0;
      console.log(`  ${l.id}: HTTP ${st}${st === 429 || st >= 500 || !st ? ', жду' : ''}`);
      if (st && st !== 429 && st < 500) break;
      await sleep(2000 * (attempt + 1) ** 2);
    }
  }
  if (!audio) {
    failed++;
    continue;
  }
  used += text.length;
  const d = dec.decode(audio);
  dec.reset();
  const sr = d.sampleRate;
  let y = dsp.trimSilence(d.channelData[0], sr, -45, 0.05);
  y = dsp.normalizeLoudness(y, sr, -16, -1.5);
  y = dsp.fadeEdges(y, sr, 6);
  enc.configure({ sampleRate: sr, channels: 1, bitrate: 64 });
  const mp3 = Buffer.concat([Buffer.from(enc.encode([y])), Buffer.from(enc.finalize())]);
  const dur = y.length / sr;
  const f = dsp.frames(y, sr);
  const ip = ipa(l.text);
  const phones = ip ? ru.phonesFromIpa(ip) : ru.phonesFromText(l.text);
  const cues = ru.cuesFromAlignment(phones, ru.alignPhones(phones, f), dur);
  let mx = 0;
  for (const r of f.rms) mx = Math.max(mx, r);
  const onset = Math.max(0, f.rms.findIndex((r) => r > mx * 0.1)) * f.step;
  fs.mkdirSync(path.join(OUT, l.persona), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), mp3);
  bytes += mp3.length;
  man.lines[l.id] = { f: rel, d: +dur.toFixed(3), o: +onset.toFixed(3), c: cues.map((c) => `${c.value}${Math.round(c.start * 1000)}`).join(' '), t: l.text, h, persona: l.persona };
  fs.writeFileSync(manPath, JSON.stringify(man));
  done++;
  if (done % 10 === 0) console.log(`  ${done} готово, символов ${used}`);
  await sleep(300);
}
man.generated = new Date().toISOString();
man.lipsync = espeak ? 'ru-espeak-align' : 'ru-letters-align';
fs.writeFileSync(manPath, JSON.stringify(man));
const total = Object.values(man.lines).length;
let size = 0;
for (const e of Object.values(man.lines)) size += fs.existsSync(path.join(OUT, e.f)) ? fs.statSync(path.join(OUT, e.f)).size : 0;
console.log(`Готово: новых ${done}, пропущено ${skipped}, ошибок ${failed}; символов в этом прогоне ${used}; всего в манифесте ${total}, ${(size / 1048576).toFixed(2)} МБ`);
