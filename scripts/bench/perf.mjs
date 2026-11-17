#!/usr/bin/env node
// Стенд производительности (headless Chrome как прокси слабого телефона): старт и частота кадров.
// Запуск: npx vite build && npx vite preview --port 4176 --strictPort &  node scripts/bench/perf.mjs [опции]
//   --throttle=1,4,6   замедление CPU (CDP Emulation.setCPUThrottlingRate)
//   --secs=8           сколько секунд мерить кадры после появления кота
//   --q=auto           уровень качества (?q=0 — без адаптации)
//   --tracker=debug    debug (кот сам на карте) | card (камера Chrome-заглушка: детектор ищет карту каждый кадр)
//   --net=4g           эмуляция сети для замера старта (4g | 3g | none)
//   --dpr=3 --w=390 --h=844
//   --extra=...        добавить к адресу (например &modelopt=0)
// Вывод — JSON по каждому прогону (марки старта, байты до первого кадра с котом, fps, мс участков кадра, renderer.info).
import puppeteer from 'puppeteer-core';

const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const base = arg('url', 'http://localhost:4176/');
const throttles = arg('throttle', '1,4,6').split(',').map(Number);
const secs = Number(arg('secs', '8'));
const q = arg('q', 'auto');
const tracker = arg('tracker', 'debug');
const net = arg('net', 'none');
const dpr = Number(arg('dpr', '3'));
const W = Number(arg('w', '390')), H = Number(arg('h', '844'));
const extra = arg('extra', '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const NET = {
  '4g': { offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 },
  '3g': { offline: false, latency: 300, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU', '--ignore-gpu-blocklist'],
});

async function run(throttle) {
  const ctx = await browser.createBrowserContext(); // чистый кэш на прогон
  const page = await ctx.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  if (NET[net]) await cdp.send('Network.emulateNetworkConditions', NET[net]);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // длинные задачи главного потока (онбординг «замирает»): до готовности кота
  await page.evaluateOnNewDocument(() => {
    window.__long = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true });
    } catch {}
  });
  const url = `${base}?tracker=${tracker}&perf&q=${q}${extra}`;
  const tNav = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // отметки старта снаружи (одинаково для старой и новой сборки): опрос по кадрам
  const M = {};
  const at = async (name, fn, timeout) => {
    await page.waitForFunction(fn, { timeout, polling: 50 });
    M[name] = Math.round(await page.evaluate(() => performance.now()));
  };
  await at('ui', () => !!document.querySelector('[data-a="wake"]'), 120000);
  await at('char', () => !!window.__app?.character?.object && window.__app.character.kind === 'glb' && !!window.__app.input, 180000);
  // «Открыть камеру»
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  let catOk = true;
  if (tracker === 'debug') {
    catOk = await at('cat', () => window.__app.stage.root.visible, 60000).then(() => true, () => false);
  } else await wait(2000);
  const tCat = Date.now() - tNav;
  await wait(1500); // появление
  // --strip-morph: программная видеокарта headless (SwiftShader) тратит ~250 мс/кадр на морф-таргеты лица — на телефоне
  // это доли миллисекунды. Чтобы мерить главный поток, а не эмулятор GPU, убираем морфы из отрисовки (JS их считает как обычно)
  if (process.argv.includes('--strip-morph'))
    await page.evaluate(() => window.__app.scene.traverse((o) => {
      if (o.isMesh && o.geometry.morphAttributes && Object.keys(o.geometry.morphAttributes).length) {
        o.geometry = o.geometry.clone();
        o.geometry.morphAttributes = {};
        o.material.needsUpdate = true;
      }
    }));
  await cdp.send('Performance.enable');
  const met = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const m0 = await met();
  await page.evaluate(() => {
    window.__perf?.reset();
    window.__fpsN = 0;
    window.__fpsT0 = performance.now();
    window.__dts = [];
    let last = performance.now();
    const f = (t) => {
      window.__fpsN++;
      window.__dts.push(t - last);
      last = t;
      if (!window.__fpsStop) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await wait(secs * 1000);
  await page.evaluate((m) => (window.__M = m), M);
  const res = await page.evaluate(() => {
    window.__fpsStop = true;
    const T = (performance.now() - window.__fpsT0) / 1000;
    const app = window.__app;
    const info = app.renderer.info;
    const dts = [...window.__dts].sort((a, b) => a - b);
    const res = performance.getEntriesByType('resource');
    const bytesTo = (t) => res.filter((r) => r.responseEnd <= t).reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0);
    const m = window.__M;
    const tr = app.tracker?.stats;
    return {
      fps: +(window.__fpsN / T).toFixed(1),
      frameMsP50: +dts[Math.floor(dts.length / 2)].toFixed(1),
      frameMsP95: +dts[Math.floor(dts.length * 0.95)].toFixed(1),
      quality: app.quality ? { level: app.quality.level, pr: app.renderer.getPixelRatio() } : null,
      marks: m,
      kbBeforeUi: Math.round(bytesTo(m.ui) / 1024),
      kbBeforeChar: Math.round(bytesTo(m.char) / 1024),
      kbTotal: Math.round(bytesTo(1e12) / 1024),
      big: res.filter((r) => (r.transferSize || r.encodedBodySize) > 200000).map((r) => `${r.name.replace(/^.*\/\/[^/]+\//, '')} ${Math.round((r.transferSize || r.encodedBodySize) / 1024)}K @${Math.round(r.responseEnd)}ms`),
      render: { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length, textures: info.memory.textures, geometries: info.memory.geometries },
      tracker: tr ? { fps: +tr.fps.toFixed(1), workerMs: +tr.ms.toFixed(1), mode: tr.mode } : null,
      perf: window.__perf?.report() ?? null,
      longBeforeChar: (() => {
        const L = window.__long.filter(([t]) => t < m.char);
        return { n: L.length, max: Math.max(0, ...L.map((x) => x[1])), sum: L.reduce((a, x) => a + x[1], 0) };
      })(),
    };
  });
  const m1 = await met();
  const sec = secs;
  // доля времени главного потока (с на с): скрипты и вся работа задач — одинаково для старой и новой сборки
  res.mainThread = {
    scriptPct: +(((m1.ScriptDuration - m0.ScriptDuration) / sec) * 100).toFixed(1),
    taskPct: +(((m1.TaskDuration - m0.TaskDuration) / sec) * 100).toFixed(1),
    stylePct: +((((m1.RecalcStyleDuration - m0.RecalcStyleDuration) + (m1.LayoutDuration - m0.LayoutDuration)) / sec) * 100).toFixed(1),
    heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
  };
  res.throttle = throttle;
  res.catVisible = catOk;
  res.tCatWall = tCat;
  res.errors = errors.slice(0, 5);
  await ctx.close();
  return res;
}

for (const t of throttles) {
  const r = await run(t);
  console.log(JSON.stringify(r, null, 1));
}
await browser.close();
