#!/usr/bin/env node
// Снимок десктоп-просмотра (src/input/orbit.ts): /lab/?desktop на «Маке» 1280×800, мышью повернули кота → docs/ui/desktop_orbit.png.
// Запуск: собранный dist (npm run build) отдать статикой (python3 -m http.server 4181 -d dist) и node scripts/desktop-orbit-shot.mjs
// или при `npx vite --port 4180` — ORBIT_URL=http://localhost:4180/?desktop (CHROME — по желанию).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs/ui/desktop_orbit.png');
const url = process.env.ORBIT_URL ?? 'http://localhost:4181/lab/?desktop&cat=kind&progress=0&q=0';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  protocolTimeout: 240000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.evaluateOnNewDocument(() => {
  localStorage.clear();
  // уже знакомы — без знакомства, сразу игра
  for (const p of ['', 'lab:']) localStorage.setItem(p + 'sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
});
await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
await page.waitForFunction(() => window.__app?.director && window.__orbit, { timeout: 60000 });
const label = await page.evaluate(() => document.querySelector('[data-a="wake"]')?.textContent);
await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
const until = async (fn, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true;
    await wait(80);
  }
  throw new Error('не дождался: ' + fn);
};
await until(() => ['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy);
await wait(1200);
const hint = await page.evaluate(() => document.querySelector('.orbit-hint')?.textContent ?? null);
// перетаскивание мышью по пустому месту: вправо и вниз — площадка повернулась, смотрим чуть выше
const taps = await page.evaluate(() => {
  window.__taps = 0;
  for (const k of ['tap_cat', 'stroke', 'tap_screen', 'double_tap']) window.__app.input.on(k, () => window.__taps++);
  return 0;
});
await page.mouse.move(1000, 420);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(1000 - i * 8, 420 + i * 2);
  await wait(16);
}
await page.mouse.up();
await wait(2500);
const pose = await page.evaluate(() => window.__orbit.pose);
const after = await page.evaluate(() => window.__taps);
await page.screenshot({ path: out });
console.log({ label, hint, pose, tapsDuringDrag: after - taps, errors: errors.slice(0, 5) });
await browser.close();
