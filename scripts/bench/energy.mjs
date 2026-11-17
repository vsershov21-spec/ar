#!/usr/bin/env node
// Стенд энергобюджета: сколько работы делает прототип за секунду в типичных фазах (headless Chrome как iPhone).
// Видеокарта в headless программная (SwiftShader) — её время не похоже на телефон, поэтому рендер подменяется
// счётчиком (--gpu=stub, по умолчанию): меряем главный поток (JS/стили), частоту рендера, трекер (Гц и мс воркера),
// микрофон; «работа GPU» оценивается как кадры/с × пиксели буфера × проходы (тело + оболочки меха).
//
// Камера — синтетическое видео с картой (Chrome --use-file-for-fake-video-capture):
//   python3 scripts/bench/gen_card_video.py [/tmp/ebench] — still.y4m (телефон на столе), move.y4m (медленное движение)
// Запуск:
//   npx vite build && npx vite preview --port 4176 --strictPort &
//   node scripts/bench/energy.mjs --url=http://localhost:4176/ [--label=new] [--video=/tmp/ebench/still.y4m]
//     [--throttle=4] [--secs=8] [--extra=&energy=0] [--phases=calm,taps,doze]
import puppeteer from 'puppeteer-core';

const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const base = arg('url', 'http://localhost:4176/');
const label = arg('label', base);
const video = arg('video', '/tmp/ebench/still.y4m');
const throttle = Number(arg('throttle', '4'));
const secs = Number(arg('secs', '8'));
const extra = arg('extra', '');
const gpu = arg('gpu', 'stub');
const phases = arg('phases', 'calm,hand,taps,doze').split(',');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU',
  ],
});
const page = await browser.newPage();
await page.setUserAgent(IPHONE_UA);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const cdp = await page.createCDPSession();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}?tracker=card&perf${extra}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]') && !!window.__app?.input, { timeout: 120000, polling: 100 });
await page.waitForFunction(() => window.__app.character?.kind === 'glb', { timeout: 180000, polling: 200 });
// рендер: счётчик (+ заглушка GPU)
await page.evaluate((stub) => {
  const r = window.__app.renderer;
  const orig = r.render.bind(r);
  window.__renders = 0;
  r.render = (s, c) => {
    window.__renders++;
    if (!stub) orig(s, c);
  };
}, gpu === 'stub');
await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
// кот на карте (детектор нашёл и посадил)
const sat = await page
  .waitForFunction(() => window.__app.stage.root.visible && window.__app.tracker.isLocked, { timeout: 90000, polling: 200 })
  .then(() => true, () => false);
await wait(6000); // появление, первые реплики
await cdp.send('Performance.enable');
const met = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

async function measure(name, during) {
  const m0 = await met();
  const s0 = await page.evaluate(() => ({ r: window.__renders, tr: window.__perf?.totals?.tracker ?? 0, mic: window.__perf?.totals?.mic ?? 0, t: performance.now(), wms: window.__perf?.report().sections['tracker.worker'], trf: window.__app.tracker.stats?.fps }));
  await page.evaluate(() => window.__perf?.reset());
  const stop = during ? during() : null;
  await wait(secs * 1000);
  if (stop) await stop();
  const m1 = await met();
  const s1 = await page.evaluate(() => {
    const app = window.__app;
    const shells = [];
    app.character.object.traverse((o) => /^BD_FurShell_\d+$/.test(o.name) && o.visible && shells.push(o.name));
    const rep = window.__perf?.report();
    return {
      r: window.__renders, tr: window.__perf?.totals?.tracker ?? 0, mic: window.__perf?.totals?.mic ?? 0, t: performance.now(),
      pr: app.renderer.getPixelRatio(), w: app.root.clientWidth, h: app.root.clientHeight, shells: shells.length,
      trFps: app.tracker.stats?.fps, workerMs: rep?.sections['tracker.worker']?.avg ?? app.tracker.stats?.ms, grabMs: rep?.sections['tracker.grab']?.avg,
      frameJs: rep?.frameJs?.avg, mode: app.energy?.out?.mode ?? '—', locked: app.tracker.isLocked, tracking: app.tracker.isTracking,
      vw: app.tracker.video?.videoWidth, vh: app.tracker.video?.videoHeight,
    };
  });
  const T = (s1.t - s0.t) / 1000;
  const renderFps = (s1.r - s0.r) / T;
  const px = s1.w * s1.h * s1.pr * s1.pr;
  const trackerHz = s1.tr ? (s1.tr - s0.tr) / T : s1.trFps;
  const out = {
    build: label, phase: name, throttle, mode: s1.mode, locked: s1.locked, tracking: s1.tracking,
    renderFps: +renderFps.toFixed(1),
    mainThreadPct: +(((m1.TaskDuration - m0.TaskDuration) / T) * 100).toFixed(1),
    scriptPct: +(((m1.ScriptDuration - m0.ScriptDuration) / T) * 100).toFixed(1),
    stylePct: +((((m1.RecalcStyleDuration - m0.RecalcStyleDuration) + (m1.LayoutDuration - m0.LayoutDuration)) / T) * 100).toFixed(1),
    trackerHz: +(+trackerHz).toFixed(1),
    workerMs: s1.workerMs != null ? +(+s1.workerMs).toFixed(2) : null,
    grabMs: s1.grabMs != null ? +(+s1.grabMs).toFixed(2) : null,
    workerPct: s1.workerMs != null ? +((trackerHz * s1.workerMs) / 10).toFixed(1) : null,
    micHz: s1.mic ? +((s1.mic - s0.mic) / T).toFixed(1) : null,
    pixelRatio: s1.pr, furShells: s1.shells, camera: `${s1.vw}x${s1.vh}`,
    // оценка работы GPU: мегапиксели/с (тело + оболочки меха — проходы по площади кота, порядок величины)
    gpuMpxPerSec: +((renderFps * px * (1 + s1.shells)) / 1e6).toFixed(0),
  };
  console.log(JSON.stringify(out));
  return out;
}

/** гироскоп: рука держит телефон (дрожание ~dps °/с), 60 событий в секунду */
const gyro = (dps) => () => {
  const id = page.evaluate((d) => (window.__gyro = setInterval(() => {
    const r = () => (Math.random() * 2 - 1) * d * 0.6;
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: r(), beta: r(), gamma: r() }, interval: 16 }));
  }, 16)), dps);
  return async () => {
    await id;
    await page.evaluate(() => clearInterval(window.__gyro));
  };
};

for (const ph of phases) {
  if (ph === 'calm') await measure('кот в покое, телефон на столе');
  if (ph === 'hand') await measure('телефон в руке (гироскоп ~8°/с)', gyro(8));
  if (ph === 'taps')
    await measure('ребёнок тыкает в кота (раз в 0,7 с)', () => {
      let on = true;
      (async () => {
        while (on) {
          await page.touchscreen.tap(195, 470).catch(() => undefined);
          await wait(700);
        }
      })();
      return async () => {
        on = false;
        await wait(800);
      };
    });
  if (ph === 'doze') {
    const has = await page.evaluate(() => !!window.__app.energy);
    if (has) {
      await page.evaluate(() => (window.__app.energy.idleMs = 3000));
      await wait(4000);
    } else await wait(4000);
    await measure(has ? 'простой (дрёма; порог 60 с сокращён до 3 с)' : 'простой');
    if (has) await page.evaluate(() => (window.__app.energy.idleMs = 60000));
  }
}
if (!sat) console.log(JSON.stringify({ build: label, warn: 'кот не сел на карту за 90 с — трекер мерился в поиске' }));
if (errors.length) console.log(JSON.stringify({ build: label, errors: errors.slice(0, 5) }));
await browser.close();
