#!/usr/bin/env node
// Стенд звукового стека (headless Chrome как iPhone): что создаётся и грузится, сколько стоит микрофон.
// Считает: AudioContext (сколько создано/закрыто), getUserMedia (по видам), смены navigator.audioSession.type,
// speechSynthesis.speak, ScriptProcessor / AudioWorklet, запросы voice/* и models/*, главный поток (% CPU) и
// куча JS — в двух режимах: «слушаю всегда» (микрофон открыт; фейковый микрофон Chrome пищит раз в секунду —
// VAD видит «фразы») и «по кнопке» (микрофон закрыт). Разница = цена микрофона на главном потоке.
// Рендер подменён счётчиком (GPU в headless программный — не похож на телефон).
//   npx vite build && npx vite preview --port 4177 --strictPort &
//   node scripts/bench/audio.mjs --url=http://localhost:4177/ [--secs=10] [--throttle=4] [--label=new]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const base = arg('url', 'http://localhost:4177/');
const label = arg('label', base);
const secs = Number(arg('secs', '10'));
const throttle = Number(arg('throttle', '4'));
const extra = arg('extra', '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});

/** CPU всех процессов Chrome (рендер, GPU, аудиосервис), секунды — /proc, только Linux */
function chromeCpu() {
  const hz = 100;
  let t = 0;
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!/chrome/.test(cmd)) continue;
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      t += (Number(st[11]) + Number(st[12])) / hz;
    } catch {
      /* процесс завершился */
    }
  }
  return t;
}

async function run(mic) {
  const page = await browser.newPage();
  await page.setUserAgent(IPHONE_UA);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  const reqs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (/\/(voice|models\/vosk)/.test(u.pathname)) reqs.push(u.pathname.replace(/^.*?\/(voice|models)/, '$1'));
  });
  // --sr=48000 — частота контекста как на iPhone (Howler на 48 кГц закрывал свой контекст и создавал новый)
  await page.evaluateOnNewDocument((sr) => (window.__benchSr = sr), Number(arg('sr', '0')));
  await page.evaluateOnNewDocument(() => {
    const c = (window.__audioBench = { ctx: 0, ctxClosed: 0, gumAudio: 0, gumVideo: 0, session: [], synth: 0, sp: 0, worklet: 0, latency: [], micMs: 0, micN: 0 });
    // время главного потока в обработчиках звука микрофона (ScriptProcessor.onaudioprocess / порт ворклета)
    const timed = (fn) => function (...a) {
      const t = performance.now();
      try {
        return fn.apply(this, a);
      } finally {
        c.micMs += performance.now() - t;
        c.micN++;
      }
    };
    for (const [proto, prop] of [[ScriptProcessorNode.prototype, 'onaudioprocess'], [MessagePort.prototype, 'onmessage']]) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (d?.set) Object.defineProperty(proto, prop, { ...d, set(fn) { d.set.call(this, fn ? timed(fn) : fn); } });
    }
    const AC = window.AudioContext;
    window.AudioContext = class extends AC {
      constructor(o) {
        super(window.__benchSr ? { ...o, sampleRate: window.__benchSr } : o);
        c.ctx++;
        c.latency.push(o?.latencyHint ?? 'default');
      }
      close() {
        c.ctxClosed++;
        return super.close();
      }
      createScriptProcessor(...a) {
        c.sp++;
        return super.createScriptProcessor(...a);
      }
    };
    const W = window.AudioWorkletNode;
    if (W)
      window.AudioWorkletNode = class extends W {
        constructor(...a) {
          super(...a);
          c.worklet++;
        }
      };
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = (cs) => {
      if (cs?.audio) c.gumAudio++;
      if (cs?.video) c.gumVideo++;
      return gum(cs);
    };
    let type = 'auto';
    Object.defineProperty(navigator, 'audioSession', { value: { get type() { return type; }, set type(v) { c.session.push(v); type = v; } }, configurable: true });
    const sp = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (u) => {
      c.synth++;
      return sp(u);
    };
  });
  const cdp = await page.createCDPSession();
  await page.goto(`${base}?tracker=debug&mic=${mic}&perf${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]') && !!window.__app?.input, { timeout: 120000, polling: 100 });
  await page.evaluate(() => {
    const r = window.__app.renderer;
    r.render = () => undefined;
  });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  await wait(7000);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await cdp.send('Performance.enable');
  const met = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const m0 = await met();
  const t0 = await page.evaluate(() => ({ t: performance.now(), mic: window.__perf?.totals?.mic ?? 0, ms: window.__audioBench.micMs, n: window.__audioBench.micN }));
  const cpu0 = chromeCpu();
  await wait(secs * 1000);
  const cpu1 = chromeCpu();
  const m1 = await met();
  const s = await page.evaluate(() => ({ t: performance.now(), mic: window.__perf?.totals?.mic ?? 0, open: window.__app.engine.mic.isOpen, b: window.__audioBench, st: window.__voice?.state?.() }));
  const T = (s.t - t0.t) / 1000;
  const out = {
    build: label, mic, micOpen: s.open, throttle,
    mainThreadPct: +(((m1.TaskDuration - m0.TaskDuration) / T) * 100).toFixed(1),
    scriptPct: +(((m1.ScriptDuration - m0.ScriptDuration) / T) * 100).toFixed(1),
    heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
    micChunksHz: +((s.mic - t0.mic) / T).toFixed(1),
    micHandlerMsPerSec: +((s.b.micMs - t0.ms) / T).toFixed(2),
    chromeCpuPct: +(((cpu1 - cpu0) / T) * 100).toFixed(1),
    audioContexts: s.b.ctx, closed: s.b.ctxClosed, latencyHint: s.b.latency.join(','), gumAudio: s.b.gumAudio, gumVideo: s.b.gumVideo,
    audioSessionSets: s.b.session.join('→') || '—', speechSynth: s.b.synth, scriptProcessor: s.b.sp, audioWorklet: s.b.worklet,
    requests: reqs.length, reqSample: [...new Set(reqs)].slice(0, 6), lastEvent: s.st?.lastEvent,
  };
  console.log(JSON.stringify(out));
  if (errors.length) console.log(JSON.stringify({ build: label, mic, errors: errors.slice(0, 5) }));
  await page.close();
}

const reps = Number(arg('reps', '1'));
for (let i = 0; i < reps; i++) {
  await run('auto');
  await run('ptt');
}
await browser.close();
