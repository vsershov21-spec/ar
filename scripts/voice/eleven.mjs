#!/usr/bin/env node
// Озвучка ElevenLabs. Основной путь — пакет voice-src/el_batch_all.jsonl (собирает scripts/voice/el-batch.mjs):
// все реплики трёх характеров, куски реплик со слотом ({name}, {answer}), вопросы/подсказки загадок, имена и ответы.
//
//   node scripts/voice/eleven.mjs --batch voice-src/el_batch_all.jsonl --plan     — сумма символов, без сети
//   node scripts/voice/eleven.mjs --batch voice-src/el_batch_all.jsonl --run      — синтез (только на сервере swe)
//       [--only hooligan] [--max-chars 20000] [--budget 3000]   — подмножество / лимит символов / секунд на прогон
//   bash scripts/voice/el-run.sh                                                   — то же в фоне, с логом
//   node scripts/voice/eleven.mjs --plan [--list]   — старый отбор «50 самых частых на характер» (без пакета)
//
// Ключ читается из файла ($ELEVEN_KEY_FILE, по умолчанию /var/lib/vershov-commander/.elevenlabs_key) внутри процесса
// и никуда не выводится. Голос/модель — из пакета (voice_id/model_id ← content/src/<id>.meta.json → voice).
// Обработка: mp3_44100_128 → декодирование (mpg123-decoder, wasm) → −16 LUFS, пик −1.5 dBFS → MP3 64k моно 44.1 кГц
// (wasm-media-encoders) → русские cues (espeak-ng + выравнивание, как у Piper) → <out>/<persona>/<id>.mp3 + manifest.json.
// Папка: $VOICE_EL_OUT → /srv/ar-extra/voice-el (её видит сборка сайта) → /var/lib/vershov-commander/ar/voice-el.
// Если в новой папке манифеста нет, а в старой есть — сначала копируем старую (уже оплаченное не переозвучиваем).
// Возобновляемо: задание с тем же хэшем (текст с пометкой + голос + модель) и существующим файлом пропускается.
// Запросы по одному, пауза 350 мс; 429/5xx/сеть — ожидание и повтор (до 6 раз); 401/402 (ключ, квота) — стоп.
// Манифест пишется после каждого файла (атомарно), так что прерывание ничего не ломает.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { elText, elHash, parseCsv, loadVoices } from './el-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PER_PERSONA = Number(opt('--per', 50));
const BATCH = opt('--batch', '');
const MAX_CHARS = Number(opt('--max-chars', BATCH ? Infinity : 15000));
const BUDGET_S = Number(opt('--budget', 0));
const ONLY = opt('--only', '');

const writable = (d) => {
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const LEGACY_OUT = '/var/lib/vershov-commander/ar/voice-el';
const OUT = path.resolve(process.env.VOICE_EL_OUT || (writable('/srv/ar-extra') ? '/srv/ar-extra/voice-el' : LEGACY_OUT));

// события по частоте показа (порядок = приоритет) — для старого режима без пакета
export const EL_EVENTS = ['intro', 'point_camera', 'ask_name', 'nice_name', 'no_name', 'choose', 'invite', 'tap_screen', 'tap_cat',
  'tap_cat_head', 'tap_cat_belly', 'tap_cat_paw', 'tap_cat_tail', 'tap_cat_cheek', 'stroke', 'stroke_long', 'swipe', 'longpress',
  'double_tap', 'gum', 'shake', 'spam', 'card_lost', 'card_found', 'hello', 'bye', 'yes', 'no', 'unknown', 'silence', 'filler',
  'money', 'sberkids', 'sad', 'scared', 'echo_start', 'echo_done', 'echo_stop', 'loud', 'switch_start', 'shake_prompt', 'hello_new',
  'outro', 'welcome_back'];

/** старый отбор: по событиям в порядке приоритета, круг за кругом по одному варианту, пока не наберём PER_PERSONA */
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
export { elText };

// ───────────── задания ─────────────
let jobs;
if (BATCH) {
  const file = path.resolve(root, BATCH);
  jobs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s));
} else {
  const voices = loadVoices(root);
  const lines = parseCsv(fs.readFileSync(path.join(root, 'gen/voice_lines.csv'), 'utf8'));
  jobs = selectLines(lines).map((l) => {
    const v = voices[l.persona] ?? {};
    const text = elText(l), model = v.elevenModel ?? 'eleven_v4';
    return { id: l.id, kind: 'line', persona: l.persona, voice_id: v.elevenVoiceId, model_id: model, text, plain: l.text, t: l.text, out: `${l.persona}/${l.id}.mp3`, h: elHash(text, v.elevenVoiceId, model), chars: text.length };
  });
}
if (ONLY) jobs = jobs.filter((j) => j.persona === ONLY || j.id.includes(ONLY));
const chars = jobs.reduce((a, j) => a + j.chars, 0);
const byPersona = jobs.reduce((a, j) => ((a[j.persona] = (a[j.persona] ?? 0) + j.chars), a), {});

if (flag('--plan') || !flag('--run')) {
  console.log(`Заданий ${jobs.length}, символов с пометками: ${chars} (${Object.entries(byPersona).map(([p, n]) => `${p} ${n}`).join(', ')}). Папка: ${OUT}`);
  if (fs.existsSync(path.join(OUT, 'manifest.json'))) {
    const man = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
    const left = jobs.filter((j) => !(man.lines?.[j.id]?.h === j.h && fs.existsSync(path.join(OUT, man.lines[j.id].f))));
    console.log(`Осталось озвучить: ${left.length} заданий, ${left.reduce((a, j) => a + j.chars, 0)} символов`);
  }
  if (flag('--list')) for (const j of jobs) console.log(`${j.id}\t${j.text}`);
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

const API = process.env.EL_API || 'https://api.elevenlabs.io'; // для проверки с заглушкой
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

fs.mkdirSync(OUT, { recursive: true });
const manPath = path.join(OUT, 'manifest.json');
if (!fs.existsSync(manPath) && OUT !== LEGACY_OUT && fs.existsSync(path.join(LEGACY_OUT, 'manifest.json'))) {
  try {
    fs.cpSync(LEGACY_OUT, OUT, { recursive: true });
    console.log(`Перенёс уже озвученное из ${LEGACY_OUT}`);
  } catch (e) {
    console.log(`Не смог перенести ${LEGACY_OUT}: ${e.message}`);
  }
}
const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : { version: 2, source: 'elevenlabs', lines: {} };
man.version = 2;
man.lines ??= {};
man.templates ??= {};
const saveMan = () => {
  const tmp = `${manPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(man));
  fs.renameSync(tmp, manPath);
};
// шаблоны реплик со слотом: плееру нужно знать, из каких кусков собирать
for (const j of jobs) if (j.kind === 'part') man.templates[j.line] = { t: j.tpl, slot: j.slot, parts: j.parts, persona: j.persona };

const dec = new MPEGDecoder();
await dec.ready;
const enc = await createMp3Encoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
let used = 0, done = 0, skipped = 0, failed = 0, stop = '';
const todo = jobs.filter((j) => !(man.lines[j.id]?.h === j.h && fs.existsSync(path.join(OUT, man.lines[j.id].f))));
skipped = jobs.length - todo.length;
console.log(`ElevenLabs: заданий ${jobs.length}, уже готово ${skipped}, к синтезу ${todo.length} (${todo.reduce((a, j) => a + j.chars, 0)} симв.). Папка: ${OUT}`);
for (const j of todo) {
  if (BUDGET_S && (Date.now() - t0) / 1000 > BUDGET_S) {
    stop = `бюджет ${BUDGET_S} с`;
    break;
  }
  if (used + j.chars > MAX_CHARS) {
    stop = `лимит ${MAX_CHARS} символов`;
    break;
  }
  if (!j.voice_id) {
    failed++;
    continue;
  }
  let audio = null;
  for (let attempt = 0; attempt < 6 && !audio && !stop; attempt++) {
    const r = await fetch(`${API}/v1/text-to-speech/${j.voice_id}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: j.text, model_id: j.model_id }),
    }).catch(() => null);
    if (r?.ok) {
      audio = new Uint8Array(await r.arrayBuffer());
      break;
    }
    const st = r?.status ?? 0;
    let detail = '';
    try {
      detail = r ? JSON.stringify((await r.json())?.detail ?? '').slice(0, 160) : '';
    } catch {
      /* не json */
    }
    console.log(`  ${j.id}: HTTP ${st} ${detail}`);
    if (st === 401 || st === 402) stop = `HTTP ${st} — ключ или квота`;
    else if (st && st !== 429 && st < 500) break; // 400/422 — эту реплику пропускаем
    else await sleep(Math.min(60000, 2000 * (attempt + 1) ** 2));
  }
  if (stop) break;
  if (!audio) {
    failed++;
    continue;
  }
  used += j.chars;
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
  const plain = j.plain ?? j.t;
  const ip = ipa(plain);
  const phones = ip ? ru.phonesFromIpa(ip) : ru.phonesFromText(plain);
  const cues = ru.cuesFromAlignment(phones, ru.alignPhones(phones, f), dur);
  let mx = 0;
  for (const v of f.rms) mx = Math.max(mx, v);
  const onset = Math.max(0, f.rms.findIndex((v) => v > mx * 0.1)) * f.step;
  fs.mkdirSync(path.dirname(path.join(OUT, j.out)), { recursive: true });
  fs.writeFileSync(path.join(OUT, j.out), mp3);
  const e = { f: j.out, d: +dur.toFixed(3), o: +onset.toFixed(3), c: cues.map((c) => `${c.value}${Math.round(c.start * 1000)}`).join(' '), t: j.t, h: j.h, persona: j.persona, kind: j.kind };
  if (j.kind === 'part') Object.assign(e, { line: j.line, part: j.part, slot: j.slot, ...(j.lead ? { lead: j.lead } : {}) });
  if (j.kind === 'slot') Object.assign(e, { slot: j.slot, v: j.v });
  man.lines[j.id] = e;
  saveMan();
  done++;
  if (done % 20 === 0) console.log(`  ${done}/${todo.length} готово, символов ${used}, ${Math.round((Date.now() - t0) / 1000)} с`);
  await sleep(350);
}
man.generated = new Date().toISOString();
man.lipsync = espeak ? 'ru-espeak-align' : 'ru-letters-align';
saveMan();
const total = Object.values(man.lines).length;
let size = 0;
for (const e of Object.values(man.lines)) size += fs.existsSync(path.join(OUT, e.f)) ? fs.statSync(path.join(OUT, e.f)).size : 0;
const left = todo.length - done - failed;
console.log(`Готово: новых ${done}, пропущено ${skipped}, ошибок ${failed}${stop ? `, остановлено: ${stop}` : ''}; символов в этом прогоне ${used}; осталось ${left}; всего в манифесте ${total}, ${(size / 1048576).toFixed(2)} МБ`);
if (left > 0) console.log('Запустите ещё раз — продолжит с места остановки.');
