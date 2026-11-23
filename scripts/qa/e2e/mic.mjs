#!/usr/bin/env node
// Голосовой контур пилота /mvp на фейковом микрофоне: `npm run e2e:mic` (docs/qa/E2E.md, раздел «Микрофон»).
//   Chrome --use-file-for-fake-audio-capture: петля WAV (тишина комнаты + фраза espeak-ng раз в PERIOD с).
//   Всё — настоящее (getUserMedia заставки → cardTracker → MicInput.adopt → AudioWorklet → VAD → окно ответа → режиссёр →
//   озвучка), кроме Kaldi: модели Vosk на стенде нет, вместо неё — заглушка распознавателя (FAKE_ASR): получает те же
//   кадры 16 кГц, итог фразы — текст, который сценарий «вложил в рот» (window.__say) перед ближайшей фразой петли.
//   Без звука в кадрах (микрофон молчит / дорожка потеряна) заглушка возвращает пусто — как Vosk.
// Замеры: конец фразы (VAD end) → текст → реплика кота; говорит ли кот при открытом микрофоне (hold); после дома,
// смены кота и сна. Отчёт — bench-out/e2e-mic/report.json.
//
//   npm run e2e:mic                 — нужна сборка pilot (dist/mvp: AR_EDITIONS=pilot node scripts/build/editions.mjs)
//   npm run e2e:mic -- --db -38     — громкость фразы, dBFS RMS (по умолчанию −30: голос ребёнка на iPhone с AEC)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openPhone, toPlay, sleep, watchTexts, SETTLED } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT = path.join(root, 'bench-out/e2e-mic');
const DIST = path.join(root, 'dist');
const PERIOD = 7;
const DB = Number(arg('--db', '-30'));
const log = (...a) => console.log(`[mic ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

// ── WAV: PERIOD с петли, фраза (espeak-ng, «сделай сальто», ≈1,2 с) с 3-й секунды; тишина — шум −62 dBFS ──
function loopWav() {
  const sr = 48000, n = sr * PERIOD, at = sr * 3;
  const speech = path.join(OUT, 'phrase.wav');
  const raw = path.join(OUT, 'phrase_raw.wav');
  let pcm = null;
  const es = spawnSync('espeak-ng', ['-v', 'ru', '-s', '150', '-w', raw, 'сделай сальто'], { stdio: 'ignore' });
  if (!es.status && fs.existsSync(raw)) {
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', raw, '-ar', String(sr), '-ac', '1', speech], { stdio: 'ignore' });
    const b = fs.readFileSync(speech);
    const off = b.indexOf('data') + 8;
    pcm = new Float32Array((b.length - off) >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(off + i * 2) / 32768;
  } else {
    // нет espeak-ng: «слоги» — гармонический тон 180 Гц с огибающей 4 Гц, 1,2 с
    pcm = new Float32Array(Math.round(sr * 1.2));
    for (let i = 0; i < pcm.length; i++) {
      const t = i / sr;
      pcm[i] = Math.sin(2 * Math.PI * 4 * t) ** 2 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 720 * t));
    }
  }
  const rms = Math.sqrt(pcm.reduce((s, v) => s + v * v, 0) / pcm.length) || 1e-6;
  const k = Math.pow(10, DB / 20) / rms;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8); out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  let s = 7;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    let v = ((s / 2147483647) * 2 - 1) * 0.0008 * 1.7; // ≈ −62 dBFS
    const j = i - at;
    if (j >= 0 && j < pcm.length) v += pcm[j] * k;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  const f = path.join(OUT, `loop_${PERIOD}s_${-DB}db.wav`);
  fs.writeFileSync(f, out);
  return f;
}

/**
 * Заглушка Vosk (до бандла, ждёт window.__voice): модель «в памяти», распознаватель считает голос во входящих кадрах
 * (16 кГц ×32768) и на retrieveFinalResult отдаёт window.__say (один раз), если голоса было ≥ 300 мс. Журнал — __micLog.
 */
function FAKE_ASR() {
  const L = (window.__micLog = []);
  const now = () => (window.__qaReal ? window.__qaReal.now() : performance.now());
  const push = (ev, o = {}) => L.push({ t: Math.round(now()), ev, ...o });
  window.__say = '';
  // запросы getUserMedia: на iOS второй запрос микрофона глушит первый / рвёт камеру — считаем, с аудио ли
  window.__gum = [];
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    const g = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => (window.__gum.push({ t: Math.round(now()), audio: !!c?.audio, video: !!c?.video }), g(c));
  }
  class Rec {
    constructor() {
      this.h = {};
      this.voiced = 0;
      this.total = 0;
      push('rec_new');
    }
    setWords() {}
    on(e, f) {
      this.h[e] = f;
    }
    acceptWaveformFloat(b, sr) {
      let e = 0;
      for (let i = 0; i < b.length; i++) e += b[i] * b[i];
      const db = 10 * Math.log10(e / b.length + 1e-12);
      this.total += b.length / sr;
      if (db > -45) this.voiced += b.length / sr;
    }
    retrieveFinalResult() {
      const text = this.voiced >= 0.3 && window.__say ? window.__say : '';
      push('asr_final', { text, voiced: +this.voiced.toFixed(2), total: +this.total.toFixed(2) });
      if (text) window.__say = '';
      setTimeout(() => this.h.result?.({ result: { text, result: text.split(' ').map((w) => ({ word: w, conf: 0.95 })) } }), 60);
    }
    remove() {}
  }
  const tick = setInterval(() => {
    const v = window.__voice;
    if (!v) return;
    clearInterval(tick);
    const a = v.engine.asr;
    a.model = { KaldiRecognizer: Rec };
    a.health = 'ok';
    a.loading = null;
    const e = v.engine;
    e.on('text', ({ text, source }) => push('text', { text, source }));
    e.on('event', ({ id }) => push('event', { id }));
    const vad = e.vad, vp = vad.push.bind(vad);
    vad.push = (f) => {
      const r = vp(f);
      if (r) push('vad_' + r.type, r.type === 'end' ? { dur: r.durMs } : {});
      return r;
    };
    const vo = window.__app?.voice;
    e.on('state', (s) => {
      if (s.listening !== window.__lastListening) push(s.listening ? 'listen_on' : 'listen_off', { reason: s.listenReason });
      window.__lastListening = s.listening;
    });
    void vo;
    push('fake_asr_installed');
  }, 20);
}

const dist = DIST;
if (!fs.existsSync(path.join(dist, 'mvp/index.html'))) throw new Error('нет dist/mvp — сборка pilot: AR_EDITIONS=pilot node scripts/build/editions.mjs');
spawnSync('node', [path.join(root, 'scripts/scenario/fake-voice.mjs'), dist, '1'], { cwd: root, stdio: 'ignore' });
const wav = loopWav();
const server = await startServer({ dist, pub: path.join(root, 'public'), cache: process.env.AR_MODEL_CACHE || path.join(root, '.cache/model-opt') });
const MEDIA = path.join(root, 'bench-out/qa/media');
const browser = await launch({ media: path.join(MEDIA, 'still.y4m'), room: wav, headful: argv.includes('--headful') });
log(`сервер ${server.base}, петля ${PERIOD} с, фраза ${DB} dBFS`);

const results = [];
const res = (name, ok, o = {}) => {
  results.push({ name, ok, ...o });
  log(`${ok ? '✓' : '✗'} ${name} ${JSON.stringify(o)}`);
};

/** сказать фразу в ближайший проход петли и дождаться текста; → { ok, text, vadEnd→text, text→speak, speakId, holdMs } */
async function say(P, phrase, ms = PERIOD * 2500) {
  const t0 = await P.ev((p) => {
    window.__say = p;
    return Math.round(window.__qaReal.now());
  }, phrase);
  const ok = await P.until((t0) => (window.__micLog ?? []).some((r) => r.t >= t0 && r.ev === 'text' && r.source === 'asr'), ms, t0);
  await sleep(4500);
  return P.ev(
    ({ t0, ok }) => {
      const L = window.__micLog.filter((r) => r.t >= t0);
      const txt = L.find((r) => r.ev === 'text' && r.source === 'asr');
      const end = txt ? [...L].reverse().find((r) => r.ev === 'vad_end' && r.t <= txt.t) : null;
      const r0 = window.__qaR0;
      const sp = txt ? (window.__qaRec ?? []).find((r) => r.kind === 'speak' && r.rt + r0 >= txt.t) : null;
      const tm = window.__app.voice.timings ?? [];
      const last = sp ? tm.find((x) => x.id === sp.id) : null;
      const finals = L.filter((r) => r.ev === 'asr_final');
      return {
        ok, text: txt?.text ?? null,
        vadEndToText: end && txt ? txt.t - end.t : null,
        textToSpeak: sp && txt ? Math.round(sp.rt + r0 - txt.t) : null,
        speakId: sp?.id ?? null, holdMs: last ? Math.round(last.holdMs) : null, outcome: last?.outcome ?? null,
        finals: finals.map((f) => `${f.text || '∅'}/${f.voiced}`).join(' '), state: window.__voice.state().asrState, micOpen: window.__voice.audio().micOpen,
      };
    },
    { t0, ok },
  );
}

const FLOWS = [];
try {
  // ── 1. уже знакомы: свободная игра, команды голосом ──
  {
    const P = await openPhone(browser, server, { url: null, memory: { met: true, persona: 'kind', visits: 3, name: null } });
    await P.page.evaluateOnNewDocument(FAKE_ASR);
    await P.go('cat=kind');
    await toPlay(P);
    await watchTexts(P);
    await P.must(SETTLED, 40000, 'кот свободен');
    const a = await P.ev(() => window.__voice.audio());
    res('mic_open_after_landing', !!a.micOpen, { audio: a, mode: await P.ev(() => window.__voice.state().mode) });
    for (const ph of ['привет', 'сделай сальто', 'загадай загадку']) {
      const r = await say(P, ph);
      FLOWS.push({ step: ph, ...r });
      res(`say «${ph}»`, r.ok && !!r.speakId, r);
      await P.until(SETTLED, 20000);
      if (ph === 'загадай загадку') {
        // загадка: ответ голосом «не знаю» → подсказка/ответ
        const r2 = await say(P, 'не знаю');
        FLOWS.push({ step: 'загадка: не знаю', ...r2 });
        res('say «не знаю» (загадка)', r2.ok && !!r2.speakId, r2);
        await P.until(SETTLED, 25000);
      }
    }
    // кот говорит, пока микрофон открыт («слушаю всегда»): реплики и hold за всё время
    const held = await P.ev(() => {
      const tm = window.__app.voice.timings ?? [];
      return { lines: tm.length, silent: tm.filter((x) => x.outcome === 'silent').length, maxHold: Math.round(Math.max(0, ...tm.map((x) => x.holdMs))), held: tm.filter((x) => x.holdMs > 300).length };
    });
    res('cat_speaks_with_open_mic', held.lines > 0 && held.maxHold < 6000, held);
    // индикатор на кнопке: «Слышу»/«Думаю…» во время фразы (опрос подписи)
    {
      const seen = await P.ev(async (ms) => {
        const st = new Set();
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          const sl = document.querySelector('.mic-slot');
          st.add(`${sl?.dataset.vs ?? '-'}:${sl?.querySelector('.mic-st')?.textContent ?? ''}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        return [...st];
      }, PERIOD * 1000 + 500);
      res('mic_indicator', seen.some((x) => /^hearing:Слышу/.test(x)) && seen.some((x) => /^thinking:Думаю/.test(x)), { seen });
    }
    // iPhone: контекст «interrupted» (камера/звонок), resume вне жеста не отвечает → «Не слышу» + подсказка; касание будит
    {
      const r = await P.ev(async () => {
        const ctx = window.__app.audio.ctx, res0 = ctx.resume.bind(ctx);
        ctx.resume = () => new Promise(() => {});
        await ctx.suspend();
        const t0 = performance.now();
        let vs = '', hint = '', deafAt = 0, hintAt = 0;
        while (performance.now() - t0 < 7000) {
          vs = document.querySelector('.mic-slot')?.dataset.vs ?? '';
          if (vs === 'deaf' && !deafAt) deafAt = performance.now() - t0;
          const h = document.querySelector('.mic-hint.show')?.textContent ?? '';
          if (/не слышит/.test(h)) {
            hint = h;
            hintAt = performance.now() - t0;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        ctx.resume = res0;
        return { vs, hint, deafMs: Math.round(deafAt), hintMs: Math.round(hintAt), health: window.__voice.engine.mic.health };
      });
      await P.tapXY(195, 420);
      const back = await P.until(() => window.__voice.engine.mic.health === 'ok' && window.__app.audio.ctx.state === 'running', 5000);
      res('ctx_interrupted: deaf → hint → tap wakes', r.deafMs > 0 && /не слышит/.test(r.hint) && back, { ...r, back });
      await P.until(SETTLED, 20000);
      const r2 = await say(P, 'привет');
      FLOWS.push({ step: 'после interrupted: привет', ...r2 });
      res('after_interrupted: voice', r2.ok && !!r2.speakId, r2);
    }
    // дом → голос → на карту → голос
    await P.tap('.tom-home').catch((e) => log('дом:', e.message));
    const inHome = await P.until(() => window.__app.home?.phase === 'home', 20000);
    await P.until(SETTLED, 20000);
    const rh = await say(P, 'привет');
    FLOWS.push({ step: 'дома: привет', ...rh });
    res('home: voice', inHome && rh.ok && !!rh.speakId, { inHome, ...rh });
    await P.tap('.tom-home').catch((e) => log('на карту:', e.message));
    await P.until(() => window.__app.home?.phase === 'ar' && window.__app.tracker.isTracking, 30000);
    await P.until(SETTLED, 20000);
    const ra = await say(P, 'сделай сальто');
    FLOWS.push({ step: 'после дома: сальто', ...ra });
    res('after_home: voice', ra.ok && !!ra.speakId, { ...ra, audio: await P.ev(() => window.__voice.audio()) });
    // смена кота голосом / кнопкой → голос
    await P.ev(() => window.__app.director.dispatch({ type: 'intent', intent: { type: 'choose_hooligan' } }));
    await P.until(() => window.__app.director.persona.id === 'hooligan', 30000);
    await P.until(SETTLED, 40000);
    const rs = await say(P, 'привет');
    FLOWS.push({ step: 'после смены кота: привет', ...rs });
    res('after_switch: voice', rs.ok && !!rs.speakId, { persona: await P.ev(() => window.__app.director.persona.id), ...rs });
    // сон (дрёма) → «просыпайся» голосом
    await P.ev(() => window.__app.director.action('sleep'));
    await sleep(3000);
    const dz = await P.ev(() => window.__app.director.dozing);
    const rw = await say(P, 'просыпайся');
    FLOWS.push({ step: 'сон: просыпайся', ...rw });
    res('sleep: wake by voice', rw.ok, { dozingBefore: dz, dozingAfter: await P.ev(() => window.__app.director.dozing), ...rw });
    const gum = await P.ev(() => window.__gum);
    res('one_mic_request', gum.filter((g) => g.audio).length === 1, { gum: gum.map((g) => `${g.video ? 'v' : ''}${g.audio ? 'a' : ''}`).join(' ') });
    fs.writeFileSync(path.join(OUT, 'flow1.log.txt'), (await P.log()).join('\n'));
    fs.writeFileSync(path.join(OUT, 'flow1.mic.json'), JSON.stringify(await P.ev(() => window.__micLog), null, 1));
    await P.close();
  }
  // ── 1б. модель ещё качается: голос не держит кота, подсказка «учится слушать» один раз ──
  {
    const P = await openPhone(browser, server, { url: null, memory: { met: true, persona: 'glitter', visits: 3, name: null } });
    await P.page.evaluateOnNewDocument(FAKE_ASR);
        await P.go('cat=glitter');
    await toPlay(P);
    await watchTexts(P);
    await P.until(SETTLED, 40000);
    const t0 = await P.ev(() => {
      const a = window.__voice.engine.asr;
      a.model = null;
      a.health = 'loading';
      a.preload = () => new Promise(() => {}); // распаковка идёт
      return Math.round(window.__qaReal.now());
    });
    const hints = [];
    const tEnd = Date.now() + PERIOD * 2000 + 1500;
    while (Date.now() < tEnd) {
      const h = await P.ev(() => document.querySelector('.mic-hint.show')?.textContent ?? '');
      if (h && !hints.includes(h)) hints.push(h);
      await sleep(200);
    }
    const r = await P.ev((t0) => {
      const L = window.__micLog.filter((x) => x.t >= t0);
      const tm = (window.__app.voice.timings ?? []).filter((x) => x.t0 + window.__qaR0 >= t0 - 1);
      return { vad: L.filter((x) => x.ev === 'vad_start').length, waits: L.filter((x) => x.ev === 'event' && x.id === 'asr_wait').length, listens: L.filter((x) => x.ev === 'listen_on' && x.reason === 'vad').length, maxHold: Math.round(Math.max(0, ...tm.map((x) => x.holdMs))) };
    }, t0);
    res('model_loading: hint once, no hold', r.vad >= 2 && r.waits === 1 && r.listens === 0 && hints.some((h) => /учится слушать/.test(h)), { ...r, hints });
    await P.close();
  }
  // ── 2. первое знакомство: имя голосом ──
  {
    const P = await openPhone(browser, server, { url: null });
    await P.page.evaluateOnNewDocument(FAKE_ASR);
    await P.go('cat=kind');
    await P.must(() => !!document.querySelector('#quick .q-cta'), 20000, 'кнопка');
    await P.tap('#quick .q-cta');
    await P.install();
    await watchTexts(P);
    const asked = await P.until(() => window.__app.director.state.phase === 'ask_name', 200000);
    const nb = await P.ev(() => !document.querySelector('.namebox')?.classList.contains('hidden'));
    await P.until(() => !window.__app.voice.speaking, 15000);
    const r = await say(P, 'меня зовут маша');
    const after = await P.ev(() => ({ name: window.__app.director.state.name, phase: window.__app.director.state.phase }));
    FLOWS.push({ step: 'имя голосом', ...r, ...after });
    res('name_by_voice', asked && r.ok && after.name === 'Маша', { asked, nameboxShown: nb, ...r, ...after });
    fs.writeFileSync(path.join(OUT, 'flow2.log.txt'), (await P.log()).join('\n'));
    fs.writeFileSync(path.join(OUT, 'flow2.mic.json'), JSON.stringify(await P.ev(() => window.__micLog), null, 1));
    await P.close();
  }
} catch (e) {
  res('crash', false, { error: String(e?.stack ?? e).slice(0, 600) });
}
await browser.close();
await server.close();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), db: DB, period: PERIOD, results, flows: FLOWS }, null, 2));
const pass = results.filter((r) => r.ok).length;
console.log(`\nмикрофон: ${pass}/${results.length}`);
for (const f of FLOWS) console.log(`  ${f.step.padEnd(28)} текст ${f.text ?? '—'}  VAD→текст ${f.vadEndToText ?? '—'} мс  текст→реплика ${f.textToSpeak ?? '—'} мс  ${f.speakId ?? ''} hold ${f.holdMs ?? '—'}`);
process.exit(pass === results.length ? 0 : 1);
