#!/usr/bin/env node
// Снимки раскраски карты (src/card/paint.ts, lab/pilot): docs/ui/paint_{hooligan,kind,glitter}_{mid,done}.png, 390×844.
//   mid  — кот идёт по карте с кистью (Хулиган — с баллончиком), рисунок проявился примерно наполовину
//   done — рисунок закрыл карту целиком, «Та-да!», салют
// Трекер ?debug — карта лежит на столе перед камерой (плоскость карты видна).
// Запуск: npx vite --port 4192 & node scripts/paint-shots.mjs   (PAINT_PORT, CHROME, PAINT_CATS=kind,glitter — по желанию)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/ui');
fs.mkdirSync(outDir, { recursive: true });
const port = Number(process.env.PAINT_PORT ?? 4192);
const cats = (process.env.PAINT_CATS ?? 'hooligan,kind,glitter').split(',');
const swatch = { hooligan: 1, kind: 0, glitter: 0 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  protocolTimeout: 240000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});

for (const cat of cats) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument((c) => {
    localStorage.clear();
    localStorage.setItem('sber-ar-cat:v1', JSON.stringify({ name: null, persona: c, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
    // headless рисует медленно: время приложения идёт медленнее (window.__slowK), чтобы поймать середину мазка
    const pn = performance.now.bind(performance);
    performance.now = () => {
      const t = pn(), a = window.__slowAt;
      return a ? a + (t - a) * (window.__slowK ?? 0.35) : t;
    };
  }, cat);
  await page.goto(`http://localhost:${port}/?debug&flow=paint&swatch=${swatch[cat]}&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics&awake=0`, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__app?.director, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  const until = async (fn, ms = 180000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await page.evaluate(fn)) return;
      await wait(60);
    }
    throw new Error(`${cat}: не дождался ${fn}`);
  };
  // отладочная панель и плашки — не в кадр
  await page.addStyleTag({ content: '  .dbg, .dbg-toggle, .dbg-fps, .edition-badge { display: none !important; }' });
  await until(() => window.__paint?.painting);
  await page.evaluate(() => (window.__slowAt = performance.now()));
  await until(() => window.__paint.progress >= 0.55);
  await page.screenshot({ path: path.join(outDir, `paint_${cat}_mid.png`) });
  const mid = await page.evaluate(() => ({ p: +window.__paint.progress.toFixed(2), clip: window.__app.character?.currentClip }));
  await page.evaluate(() => (window.__slowAt = 0));
  await until(() => !window.__paint.painting);
  // «Та-да!» в пузыре и салют разорвался. Headless — 4–8 к/с: салют идёт по времени приложения, а пузырь гаснет
  // по настоящему таймеру раньше — для снимка показываем ту же реплику ещё раз (на телефоне они идут вместе)
  await until(() => /Та-да/.test(document.querySelector('.bubble .txt')?.textContent ?? ''), 8000).catch(() => undefined);
  const tada = await page.evaluate(() => document.querySelector('.bubble .txt')?.textContent ?? '');
  await until(() => (window.__paint.salute?.live ?? 0) > 90, 12000).catch(() => undefined);
  await page.evaluate((t) => {
    const d = window.__app.director;
    if (t) window.__app.ui.say(t, d.persona.name, d.persona.id, 6000);
  }, tada);
  await wait(250);
  await page.screenshot({ path: path.join(outDir, `paint_${cat}_done.png`) });
  const saved = await page.evaluate(() => localStorage.getItem('sber-ar-cat:paint'));
  console.log('  ✓', cat, JSON.stringify(mid), saved, errors.length ? `ошибки: ${errors.join(' | ')}` : '');
  await page.close();
}
await browser.close();
