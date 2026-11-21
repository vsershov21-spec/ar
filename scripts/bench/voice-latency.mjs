#!/usr/bin/env node
// Стенд задержки голоса (iPhone 20.11: «озвучка запаздывает»): headless Chrome, настоящие VoicePlayer + Audio
// (src/voice/voicePlayer.ts, src/audio/audio.ts через vite dev), озвучка ElevenLabs подменена mp3 той же длины и
// битрейта (ffmpeg), сеть — перехват запросов с задержкой RTT + размер/полоса, CPU ×throttle.
// Два режима на одной последовательности нажатий (кот Добряк, действия пилота, два чипа меняются раз в 3 нажатия):
//   before — как было: пузырь сразу, затем speak (сеть + декодирование), прогрев — 1 реплика на 6 событий;
//   after  — warmEvents как app.ts (все варианты сжатыми, чипы — декодированными) + режиссёр: ждёт запись ≤ 300 мс,
//            пузырь — по onStart.
// Метрики: «пузырь → звук» и «нажатие → звук» (p50/p90, мс), разбор: сеть, декодирование, hold, resume.
//   node scripts/bench/voice-latency.mjs [--rtt=150] [--mbps=5] [--throttle=4] [--n=40] [--json=bench-out/voice-latency.json]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const RTT = Number(arg('rtt', 150)), MBPS = Number(arg('mbps', 5)), THROTTLE = Number(arg('throttle', 4)), N = Number(arg('n', 40));
const OUT = path.join(root, 'bench-out/voice-latency');
fs.mkdirSync(OUT, { recursive: true });

// ── mp3 как у ElevenLabs (44,1 кГц, 128 кбит/с), длины 1,4–3,8 с ──
const DUR = [1.4, 1.8, 2.1, 2.4, 2.7, 3.0, 3.3, 3.8];
for (const d of DUR) {
  const f = path.join(OUT, `tone_${d}.mp3`);
  if (fs.existsSync(f)) continue;
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=d=${d}:c=pink:a=0.2,highpass=f=200,lowpass=f=3500`, '-ar', '44100', '-ac', '1', '-b:a', '128k', f]);
  if (r.status) throw new Error(`ffmpeg: ${r.stderr}`);
}
const mp3 = DUR.map((d) => fs.readFileSync(path.join(OUT, `tone_${d}.mp3`)));

// ── манифест: события пилота у Добряка, по 4–5 вариантов (как в voice-src/el_batch_all.jsonl) ──
const EVENTS = ['stroke', 'tap_cat_head', 'tap_cat_belly', 'tap_cat_paw', 'treat', 'stroke_long', 'dance', 'flip', 'cocoa', 'gum', 'tap_cat', 'double_tap', 'hello_new', 'invite', 'switch_ask', 'riddle'];
const lines = {};
const files = new Map();
let k = 0;
for (const ev of EVENTS) {
  const n = ev === 'tap_cat' ? 4 : 5;
  for (let i = 1; i <= n; i++) {
    const id = `kind.${ev}.0${i}`;
    const j = k++ % mp3.length;
    const f = `el/kind/${id}.mp3`;
    files.set(`/voice/${f}`, mp3[j]);
    lines[id] = { f, d: DUR[j], o: 0.02, c: 'X0 B120 C240 X400', t: `${ev} ${i}` };
  }
}
const manifest = JSON.stringify({ version: 2, source: 'elevenlabs', lines, templates: {} });

const server = await createServer({ root, logLevel: 'error', server: { port: 0, hmr: false }, configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}`;

const PAGE = `<!doctype html><html><body><script type="module">
import { Audio } from '/src/audio/audio.ts';
import { VoicePlayer } from '/src/voice/voicePlayer.ts';
window.__bench = { Audio, VoicePlayer };
window.__ready = true;
</script></body></html>`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(mode) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/__voicebench.html') return r.respond({ status: 200, contentType: 'text/html', body: PAGE });
    if (u.pathname.endsWith('/voice/el/manifest.json')) return r.respond({ status: 200, contentType: 'application/json', body: manifest });
    if (u.pathname.endsWith('/voice/manifest.json')) return r.respond({ status: 404, body: '' });
    const b = files.get(u.pathname);
    if (b) {
      // сеть телефона: RTT + время передачи
      await sleep(RTT + (b.length * 8) / (MBPS * 1000));
      return r.respond({ status: 200, contentType: 'audio/mpeg', body: b });
    }
    r.continue();
  });
  const cdp = await page.createCDPSession();
  page.on('console', (m) => process.env.BENCH_DEBUG && console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${base}/__voicebench.html`);
  await page.waitForFunction(() => window.__ready, { timeout: 60_000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const res = await page.evaluate(
    async (mode, N, EVENTS) => {
      const { Audio, VoicePlayer } = window.__bench;
      const audio = new Audio();
      audio.unlock(false);
      const v = new VoicePlayer(audio);
      await v.load();
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let seed = 11;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const ACTIONS = ['stroke', 'tap_cat_head', 'tap_cat_belly', 'tap_cat_paw', 'treat', 'stroke_long', 'dance', 'flip', 'cocoa', 'gum'];
      const variants = (ev) => Object.keys(v.el).filter((id) => id.split('.')[1] === ev);
      // смена кота / посадка (director.setPersona → preloadEvents раньше; app.ts warmVoice теперь)
      if (mode === 'before') v.preloadEvents('kind', ['hello_new', 'invite', 'tap_cat', 'tap_screen', 'swipe', 'double_tap'], 1);
      else {
        v.warmEvents('kind', ['hello_new', 'invite'], { fetch: 6, decode: 1 });
        v.warmEvents('kind', [...ACTIONS, 'tap_cat', 'double_tap', 'switch_ask'], { fetch: 6, decode: 0 });
      }
      let chips = [pick(ACTIONS), pick(ACTIONS)];
      if (mode === 'after') v.warmEvents('kind', chips, { fetch: 6, decode: 6 });
      await wait(1200); // ребёнок видит кота и тянется к кнопке
      const out = [];
      for (let i = 0; i < N; i++) {
        // половина нажатий — по чипам кота, половина — касания/каталог
        const ev = rnd() < 0.5 ? pick(chips) : pick([...ACTIONS, 'tap_cat']);
        const id = pick(variants(ev));
        const req = { persona: 'kind', template: v.el[id].t, text: v.el[id].t, pitch: 1, rate: 1, lineId: id };
        const t0 = performance.now();
        let bubbleAt = -1, soundAt = -1, prepWait = 0;
        const preWarm = v.isWarm(req);
        if (mode === 'before') {
          bubbleAt = performance.now();
          await v.speak(req, { onStart: () => (soundAt = performance.now()) }).catch(() => undefined);
        } else {
          if (!preWarm) {
            const tw = performance.now();
            await Promise.race([v.warmLine(req), wait(300)]);
            prepWait = performance.now() - tw;
          }
          await v.speak(req, {
            onStart: () => {
              soundAt = performance.now();
              bubbleAt = soundAt;
            },
          }).catch(() => undefined);
        }
        const tm = v.timings.at(-1);
        out.push({ preWarm, prepWait, ev, id, tapToSound: soundAt - t0, bubbleToSound: soundAt - bubbleAt, fetchMs: tm?.fetchMs ?? 0, decodeMs: tm?.decodeMs ?? 0, holdMs: tm?.holdMs ?? 0, resumeMs: tm?.resumeMs ?? 0, warm: tm?.warm ?? false, startMs: tm?.startMs ?? 0, lead: (tm?.startMs ?? 0) - (tm?.prepMs ?? 0) - (tm?.holdMs ?? 0) - (tm?.resumeMs ?? 0) });
        if (i % 3 === 2) {
          chips = [pick(ACTIONS), pick(ACTIONS)];
          if (mode === 'after') v.warmEvents('kind', chips, { fetch: 6, decode: 6 });
        }
        await wait(600 + rnd() * 1400);
      }
      return { out, cache: v.cacheStats(), ctx: audio.ctx?.state, outLat: audio.ctx?.outputLatency ?? null };
    },
    mode,
    N,
    EVENTS,
  );
  await page.close();
  return res;
}

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]);
};
const summary = {};
for (const mode of ['before', 'after']) {
  const r = await run(mode);
  const rest = r.out.slice(1); // «после первого взаимодействия»
  const m = (k) => ({ p50: q(rest.map((x) => x[k]), 0.5), p90: q(rest.map((x) => x[k]), 0.9), max: q(rest.map((x) => x[k]), 1) });
  summary[mode] = {
    first: { tapToSound: Math.round(r.out[0].tapToSound), bubbleToSound: Math.round(r.out[0].bubbleToSound) },
    tapToSound: m('tapToSound'), bubbleToSound: m('bubbleToSound'), fetchMs: m('fetchMs'), decodeMs: m('decodeMs'),
    prepWait: m('prepWait'), startLead: m('lead'),
    decodedShare: +(rest.filter((x) => (mode === 'after' ? x.preWarm : x.warm)).length / rest.length).toFixed(2), cache: r.cache, ctx: r.ctx, outLat: r.outLat,
  };
  console.log(mode, JSON.stringify(summary[mode]));
}
const json = arg('json', path.join(OUT, 'result.json'));
fs.writeFileSync(json, JSON.stringify({ rtt: RTT, mbps: MBPS, throttle: THROTTLE, n: N, ...summary }, null, 2));
console.log(`→ ${path.relative(root, json)}`);
await browser.close();
await server.close();
