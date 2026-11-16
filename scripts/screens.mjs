#!/usr/bin/env node
// Headless-проверка ?debug: собирает скриншоты в docs/screens/ и падает при ошибках в консоли.
// Запуск: npm run build && npm run screens  (Chromium: CHROME_PATH / PUPPETEER_EXECUTABLE_PATH)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/screens');
fs.mkdirSync(outDir, { recursive: true });
const only = process.argv[2];
const port = 4173;
const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'pipe' });
await new Promise((r) => {
  server.stdout.on('data', (d) => /Local/.test(String(d)) && r());
  setTimeout(r, 6000);
});

const chrome = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(vp, query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${vp.name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${vp.name}] pageerror ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[${vp.name}] requestfailed ${r.url()} ${r.failure()?.errorText}`));
  // закрыть панель отладки, чтобы не перекрывала кадр
  await page.goto(`http://localhost:${port}/?debug${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__app?.director, { timeout: 20000 });
  return page;
}
const click = (page, id) => page.evaluate((id) => document.querySelector(`[data-dbg="${id}"]`)?.click(), id);
const shot = async (page, name) => {
  await page.evaluate(() => document.querySelector('.dbg')?.classList.add('closed'));
  await wait(60);
  await page.screenshot({ path: path.join(outDir, name + '.png') });
  console.log('  ✓', name);
};

const VPS = [
  { name: '375x812', w: 375, h: 812 },
  { name: '390x844', w: 390, h: 844 },
  { name: '430x932', w: 430, h: 932 },
  { name: '360x800', w: 360, h: 800 },
];

try {
  // 1. основной прогон на 390×844
  if (!only || only === 'main') {
    const vp = VPS[1];
    const page = await openPage(vp);
    await shot(page, '01_start');
    await page.click('.start .btn-primary');
    await wait(400);
    await shot(page, '02_appear');
    await wait(2600);
    await shot(page, '03_ask_name');
    await page.type('.namebox input', 'Маша');
    await page.click('.namebox .ok');
    await wait(3500);
    await page.evaluate(() => window.__app.director.dispatch({ type: 'choice_shown' }));
    await shot(page, '04_choice');
    await page.evaluate(() => window.__app.director.dispatch({ type: 'choose', persona: 'hooligan' }));
    await wait(700);
    await shot(page, '05_hooligan_gum_bubble');
    await wait(1700);
    await shot(page, '06_hooligan_gum_splat');
    await wait(3000);
    for (const [id, name, ms] of [
      ['tap_screen', '07_hooligan_knock', 250], ['swipe', '08_hooligan_claws', 300], ['shake', '09_hooligan_shake_glitch', 200],
      ['fx:sticker', '10_hooligan_sticker', 400], ['walk', '11_walk', 700],
    ]) {
      await click(page, id);
      await wait(ms);
      await shot(page, name);
      await wait(1200);
    }
    await page.evaluate(() => window.__app.director.text('Сколько у меня денег?'));
    await wait(600);
    await shot(page, '12_money_sberkids');
    // смена характера
    await page.evaluate(() => window.__app.director.text('давай другого'));
    await wait(3900);
    await shot(page, '13_switch_covered');
    // отклеивание наклейки с угла
    const st = await page.evaluate(() => { const s = window.__app.fx.stickers.at(-1); return { x: s.x, y: s.y, size: s.size, rot: s.rot }; });
    await page.evaluate(({ x, y, size, rot }) => {
      const fx = window.__app.fx;
      const c = Math.cos(rot), sn = Math.sin(rot), h = size * 0.4;
      const cx = x + (-h) * c - (-h) * sn, cy = y + (-h) * sn + (-h) * c;
      if (fx.beginPeel(cx, cy)) fx.dragPeel(cx + size * 0.25, cy + size * 0.25);
    }, st);
    await wait(100);
    await shot(page, '14_sticker_peel');
    await page.evaluate(() => window.__app.fx.endPeel());
    await click(page, 'shake');
    await wait(500);
    await shot(page, '15_blow_stickers_glitter');
    await wait(2500);
    await shot(page, '16_glitter_heart');
    await wait(4500);
    for (const [id, name, ms] of [
      ['tap_screen', '17_glitter_burst', 300], ['swipe', '18_glitter_trail', 250], ['shake', '19_glitter_snowglobe', 700], ['longpress', '20_glitter_glass_cat', 700],
    ]) {
      await click(page, id);
      await wait(ms);
      await shot(page, name);
      await wait(2800);
    }
    await click(page, 'lost');
    await wait(500);
    await shot(page, '21_card_lost_hold');
    await wait(3200);
    await shot(page, '22_card_lost_glass');
    await click(page, 'found');
    await wait(1200);
    // 3D-режимы
    await click(page, 'mode:rig');
    await wait(800);
    await shot(page, '23_rig_glitter');
    await click(page, 'persona:hooligan');
    await wait(300);
    await shot(page, '24_rig_hooligan');
    for (const c of ['walk', 'jump', 'flip', 'tumble', 'knock_glass']) {
      await click(page, 'clip:' + c);
      await wait(c === 'walk' ? 300 : 450);
      await shot(page, '25_rig_' + c);
      await wait(900);
    }
    await click(page, 'mode:glb');
    await wait(2500);
    await shot(page, '26_glb_stub');
    await page.close();
  }
  // 2. адекватность размеров на 4 вьюпортах: спрайт и риг, на карте и «у стекла»
  if (!only || only === 'vp') {
    for (const vp of VPS) {
      const page = await openPage(vp);
      await click(page, 'fast');
      await wait(5200);
      await page.evaluate(() => { window.__app.fx.clearStickers(); });
      await wait(3500);
      await shot(page, `vp_${vp.name}_sprite_card`);
      await click(page, 'mode:rig');
      await wait(600);
      await shot(page, `vp_${vp.name}_rig_card`);
      await click(page, 'glass');
      await wait(1200);
      await shot(page, `vp_${vp.name}_rig_glass`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}
const relevant = errors.filter((e) => !/speech|favicon/i.test(e));
if (relevant.length) {
  console.error('\nОшибки в консоли:\n' + relevant.join('\n'));
  process.exit(1);
}
console.log('\nОшибок в консоли нет.');
