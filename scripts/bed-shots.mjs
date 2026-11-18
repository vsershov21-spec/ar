#!/usr/bin/env node
// Снимки кровати кота (src/home/bedFlow.ts, lab): docs/ui/bed_{night,asleep,wake}.png, 390×844.
//   night  — уложили вечером (?bed=night): полумрак, ночник, шторка, одеяло, «спокойной ночи»
//   asleep — спит днём, тап — бормочет во сне (Zzz, чипы «Разбудить» / «Открыть шторку»)
//   wake   — разбудили (?bed=wake): шторка вверх, одеяло сползло, кот садится в кровати
// Запуск: npx vite --port 4180 & node scripts/bed-shots.mjs   (HOME_PORT, CHROME, HOME_CAT=kind|hooligan|glitter — по желанию)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/ui');
fs.mkdirSync(outDir, { recursive: true });
const port = Number(process.env.HOME_PORT ?? 4180);
const cat = process.env.HOME_CAT ?? 'kind';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  protocolTimeout: 240000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});

/** одна сцена: открыть флоу, дождаться дома, выполнить шаги, снять */
async function scene(name, bed, hour, steps) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    // headless рисует медленно: замедлить время приложения, чтобы поймать нужный момент перехода (window.__slow)
    const pn = performance.now.bind(performance);
    performance.now = () => {
      const t = pn(), a = window.__slowAt;
      return a ? a + (t - a) * (window.__slowK ?? 0.2) : t;
    };
    localStorage.clear();
    localStorage.setItem('sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
  });
  await page.goto(`http://localhost:${port}/?flow=home&zone=bedroom&nocard=off&bed=${bed}&hour=${hour}&cat=${cat}&progress=0&q=0&mic=ptt`, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__app?.home?.bed, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  const until = async (fn, ms = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await page.evaluate(fn)) return;
      await wait(80);
    }
    throw new Error(`${name}: не дождался ${fn}`);
  };
  await until(() => window.__app.home.phase === 'home');
  await steps(page, until);
  await page.screenshot({ path: path.join(outDir, `bed_${name}.png`) });
  const st = await page.evaluate(() => ({ bed: window.__app.home.bed.state, light: +window.__app.home.lightLevel.toFixed(2), zzz: window.__app.home.bed.zzz, clip: window.__app.character?.currentClip }));
  console.log('  ✓', name, JSON.stringify(st), errors.length ? `ошибки: ${errors.join(' | ')}` : '');
  await page.close();
}

await scene('night', 'night', 21, async (page, until) => {
  await until(() => window.__app.home.bed.state === 'asleep');
  await wait(700); // пузырь «спокойной ночи» ещё виден
});
await scene('asleep', 'sleep', 12, async (page, until) => {
  await until(() => window.__app.home.bed.state === 'asleep');
  await wait(2500);
  await page.evaluate(() => window.__app.home.onTouch('tap_cat'));
  await wait(900);
});
await scene('wake', 'wake', 12, async (page, until) => {
  await until(() => window.__app.home.bed.state === 'waking');
  await page.evaluate(() => (window.__slowAt = performance.now()));
  await until(() => {
    const p = window.__app.home.bed.m.progress(performance.now());
    return p.step?.id === 'wake_stretch_in_bed' && p.k > 0.72;
  });
});
await browser.close();
