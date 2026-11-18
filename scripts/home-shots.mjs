#!/usr/bin/env node
// Снимки «Мира кота» (src/home): docs/ui/home_<state>.png, 390×844 — портал, гостиная, кухня, спальня, возврат.
// Запуск: npx vite --port 4180 & node scripts/home-shots.mjs   (HOME_PORT, CHROME — по желанию; HOME_CAT=kind|hooligan|glitter)
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
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.evaluateOnNewDocument(() => {
  localStorage.clear();
  // уже знакомы: сразу игра (как ?flow=home), но вход в дом — вручную, чтобы снять портал над картой
  localStorage.setItem('sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
  localStorage.setItem('ar.catalog.tried', JSON.stringify(['pet', 'tickle', 'treat', 'dance', 'riddle']));
});
await page.goto(`http://localhost:${port}/?tracker=debug&cat=${cat}&progress=0&q=0&mic=ptt`, { waitUntil: 'networkidle0', timeout: 90000 });
await page.waitForFunction(() => window.__app?.home, { timeout: 60000 });
await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
const until = async (fn, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true;
    await wait(60);
  }
  throw new Error('не дождался: ' + fn);
};
const shot = async (name) => {
  await page.screenshot({ path: path.join(outDir, `home_${name}.png`) });
  console.log('  ✓', name);
};
// портал: кот прыгает «в телефон» — вспышка замедлена для снимка (на телефоне 0,45 с)
await until(() => ['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy, 120000);
await wait(1500);
await page.addStyleTag({ content: '.home-portal.in i, .home-portal.in b { animation-duration: 8s !important; }' });
await page.evaluate(() => window.__app.home.portalDemo());
await wait(3600);
await shot('portal');
await page.addStyleTag({ content: '.home-portal.in i, .home-portal.in b { animation-duration: .45s !important; }' });
await page.evaluate(() => window.__app.home.enter('snapshot'));
await until(() => window.__app.home.phase === 'home');
await wait(2600);
await shot('living');
// перебежка между зонами закончилась (headless-рендер медленный — ждём по состоянию, а не по часам)
const settled = () => until(() => !window.__app.home.moving);
await page.evaluate(() => window.__app.home.onSwipe('right'));
await settled();
await wait(800);
await page.evaluate(() => window.__app.home.act('home:treat'));
await wait(2200);
await shot('kitchen');
await page.evaluate(() => window.__app.home.go('living'));
await settled();
await page.evaluate(() => window.__app.home.go('bedroom'));
await settled();
await wait(600);
await page.evaluate(() => window.__app.home.act('home:sleep'));
await until(() => window.__app.home.lightLevel < 0.3);
await wait(800);
await shot('bedroom');
// возврат: кнопка «На карту»
await page.evaluate(() => document.querySelector('[data-h="back"]').click());
await wait(350);
await shot('return_portal');
await until(() => window.__app.home.phase === 'ar');
await wait(2500);
await shot('return');
const st = await page.evaluate(() => ({ stats: window.__app.home.stats, mem: localStorage.getItem('sber-ar-cat:v1'), fps: window.__app.fps }));
console.log(JSON.stringify(st));
if (errors.length) console.log('ошибки страницы:\n ' + errors.join('\n '));
await browser.close();
