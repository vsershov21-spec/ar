#!/usr/bin/env node
// Headless-проверка ?debug: скриншоты в docs/screens/ (JPEG 80%) и падение при ошибках в консоли.
// Запуск: npm run build && npm run screens [main|personas|switch|vp]   (Chromium: CHROME_PATH / PUPPETEER_EXECUTABLE_PATH)
// Касания по коту — настоящие (touchscreen), чтобы проверялись зоны, глажка и тычки целиком.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/screens');
fs.mkdirSync(outDir, { recursive: true });
const only = process.argv[2];
const port = Number(process.env.SCREENS_PORT ?? 4173);
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'pipe' });
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
const DSF = 1.5;

async function openPage(vp, query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: DSF, isMobile: true, hasTouch: true });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${vp.name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${vp.name}] pageerror ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`[${vp.name}] requestfailed ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`http://localhost:${port}/?debug${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__app?.director && window.__debugPanel, { timeout: 20000 });
  return page;
}
const click = (page, id) => page.evaluate((id) => document.querySelector(`[data-dbg="${id}"]`)?.click(), id);
const shot = async (page, name, keepPanel = false) => {
  if (!keepPanel) await page.evaluate(() => window.__debugPanel?.open(false));
  await wait(60);
  await page.screenshot({ path: path.join(outDir, name + '.jpg'), type: 'jpeg', quality: 80 });
  console.log('  ✓', name);
};
const quiet = (page) => page.evaluate(() => {
  const d = window.__app.director;
  d.queue?.clear?.();
  d.dialog?.clear?.();
  window.__app.fx.reset();
});
const anchor = (page, n) => page.evaluate((n) => window.__app.stage.anchorScreen(n, innerWidth, innerHeight), n);
/** экранная точка, где зона кота (перебор сетки вокруг кота) */
const zonePoint = (page, zone) => page.evaluate((zone) => {
  const app = window.__app;
  const h = app.stage.anchorScreen('head', innerWidth, innerHeight);
  const f = app.stage.anchorScreen('feet', innerWidth, innerHeight);
  const s = Math.abs(f.y - h.y) * 1.3;
  for (let dy = -0.35; dy <= 1.05; dy += 0.025)
    for (let dx = -0.55; dx <= 0.55; dx += 0.025) {
      const x = h.x + dx * s, y = h.y + dy * s;
      if (app.zoneAt(x, y) === zone) return { x, y };
    }
  return null;
}, zone);
/** двойной тап синтетическими pointer-событиями (у headless-тача задержки больше окна двойного тапа) */
const dblTap = (page, x, y) => page.evaluate(({ x, y }) => {
  const c = document.querySelector('.fx-layer');
  for (const type of ['pointerdown', 'pointerup', 'pointerdown', 'pointerup']) c.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, bubbles: true }));
}, { x, y });
async function tapAt(page, p) {
  if (p) await page.touchscreen.tap(p.x, p.y);
}
async function stroke(page, ms = 1500) {
  const b = (await zonePoint(page, 'belly')) ?? (await zonePoint(page, 'body')) ?? (await anchor(page, 'body'));
  await page.touchscreen.touchStart(b.x - 30, b.y);
  const steps = Math.round(ms / 50);
  for (let i = 0; i < steps; i++) {
    await page.touchscreen.touchMove(b.x - 30 + Math.abs(((i % 12) - 6)) * 10, b.y + Math.sin(i / 2) * 5);
    await wait(50);
  }
  return () => page.touchscreen.touchEnd();
}
async function intoGame(page, persona = 'hooligan') {
  await click(page, 'fast');
  await page.waitForFunction(() => ['play', 'free'].includes(window.__app.director.state.phase), { timeout: 15000 }).catch(() => undefined);
  await page.evaluate((p) => window.__app.director.setPersona(p), persona);
  await wait(2500);
  await quiet(page);
}

const VPS = [
  { name: '375x812', w: 375, h: 812 },
  { name: '390x844', w: 390, h: 844 },
  { name: '430x932', w: 430, h: 932 },
  { name: '360x800', w: 360, h: 800 },
];

try {
  // 1. сценарий начала (спрайт-режим, 390×844)
  if (!only || only === 'main') {
    const page = await openPage(VPS[1]);
    await shot(page, '01_start');
    await page.click('.start .btn-primary');
    await wait(400);
    await shot(page, '02_appear');
    await wait(2600);
    await shot(page, '03_ask_name');
    await page.evaluate(() => window.__app.director.dispatch({ type: 'skip_name' }));
    await wait(3000);
    await page.evaluate(() => window.__app.director.dispatch({ type: 'choice_shown' }));
    await shot(page, '04_choice');
    await page.close();
  }

  // 2. три характера: idle, стук, свайп, долгое, встряска, фирменный трюк, глажка, тычки по зонам (риг)
  if (!only || only === 'personas') {
    for (const persona of ['hooligan', 'kind', 'glitter']) {
      const page = await openPage(VPS[1], '&char=rig');
      await intoGame(page, persona);
      const P = (n) => `p_${persona}_${n}`;
      await shot(page, P('01_idle'));
      const W = VPS[1].w, H = VPS[1].h;
      // стук мимо кота и мимо карты
      await page.touchscreen.tap(W * 0.2, H * 0.22);
      await wait(700);
      await shot(page, P('02_knock'));
      await wait(1500);
      await quiet(page);
      await click(page, 'swipe');
      await wait(450);
      await shot(page, P('03_swipe'));
      await wait(1800);
      await quiet(page);
      await click(page, 'longpress');
      await wait(1100);
      await shot(page, P('04_longpress'));
      await wait(2600);
      await quiet(page);
      await click(page, 'shake');
      await wait(700);
      await shot(page, P('05_shake'));
      await wait(2500);
      await quiet(page);
      // фирменный трюк — двойной тап мимо кота
      await dblTap(page, W * 0.82, H * 0.3);
      await wait(persona === 'hooligan' ? 1900 : 1100);
      await shot(page, P('06_signature'));
      await wait(3500);
      await quiet(page);
      // глажка
      const end = await stroke(page, 1800);
      await shot(page, P('07_stroke'));
      await end();
      await wait(1200);
      // тычки по зонам
      for (const z of ['head', 'cheek', 'belly', 'paw', 'tail']) {
        await quiet(page);
        // хвост виден, когда кот оборачивается за ним (idle_tail_play)
        await page.evaluate((z) => window.__app.character.play(z === 'tail' ? 'idle_tail_play' : 'idle'), z);
        await wait(z === 'tail' ? 1500 : 1300);
        const p = await zonePoint(page, z);
        if (!p) {
          console.log(`  · ${persona}: зона ${z} не видна в этой позе`);
          continue;
        }
        await tapAt(page, p);
        await wait(320);
        await shot(page, P(`08_poke_${z}`));
      }
      await page.close();
    }
  }

  // 3. смена характера: заклеивание → отклеивание → встряска → новый образ; потеря карты
  if (!only || only === 'switch') {
    const page = await openPage(VPS[1]);
    await intoGame(page, 'hooligan');
    await page.evaluate(() => window.__app.director.text('давай другого'));
    await page.waitForFunction(() => window.__app.fx.stickers.length >= 12, { timeout: 12000 }).catch(() => undefined);
    await wait(900);
    await shot(page, '10_switch_covered');
    const st = await page.evaluate(() => { const s = window.__app.fx.stickers.at(-1); return { x: s.x, y: s.y, size: s.size, rot: s.rot }; });
    await page.evaluate(({ x, y, size, rot }) => {
      const fx = window.__app.fx;
      const c = Math.cos(rot), sn = Math.sin(rot), h = size * 0.4;
      const cx = x + -h * c - -h * sn, cy = y + -h * sn + -h * c;
      if (fx.beginPeel(cx, cy)) fx.dragPeel(cx + size * 0.25, cy + size * 0.25);
    }, st);
    await wait(100);
    await shot(page, '11_sticker_peel');
    await page.evaluate(() => window.__app.fx.endPeel());
    await click(page, 'shake');
    await wait(450);
    await shot(page, '12_stickers_blow');
    await wait(2500);
    await shot(page, '13_new_persona');
    await quiet(page);
    await click(page, 'lost');
    await wait(900);
    await shot(page, '14_card_lost_hold');
    await wait(3200);
    await shot(page, '15_card_lost_glass');
    await click(page, 'found');
    await wait(1500);
    // debug-панель: вкладка «Анимации и эффекты»
    await page.evaluate(() => { window.__debugPanel.open(true); window.__debugPanel.show('fx'); });
    await wait(300);
    await shot(page, '16_debug_fx_tab', true);
    await page.close();
  }

  // 4. размеры на 4 вьюпортах: спрайт и риг, на карте и «у стекла»
  if (!only || only === 'vp') {
    for (const vp of VPS) {
      const page = await openPage(vp);
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.__app?.director && window.__debugPanel);
      await intoGame(page, 'hooligan');
      await shot(page, `vp_${vp.name}_sprite_card`);
      await click(page, 'mode:rig');
      await wait(700);
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
// Vosk-модель (public-extra) докладывается только на сервере сборки — локально её архива нет
const relevant = errors.filter((e) => !/speech|favicon|Unrecognized archive format|vosk/i.test(e));
if (relevant.length) {
  console.error('\nОшибки в консоли:\n' + relevant.join('\n'));
  process.exit(1);
}
console.log('\nОшибок в консоли нет.');
process.exit(0);
