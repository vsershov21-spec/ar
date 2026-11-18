#!/usr/bin/env node
// Снимки наклеек в игре → docs/ui/stickers_<состояние>.png (390×844).
// Запуск: npx vite build && npx vite preview --port 4175 & node scripts/stickers/shots.mjs [состояние…]
// Кадры анимации «замораживаются»: лист наклеек перестаёт обновляться, фазы выставляются руками.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'docs/ui');
const port = Number(process.env.UI_PORT ?? 4175);
const only = process.argv.slice(2);
const VP = { w: 390, h: 844 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});

async function open() {
  const page = await browser.newPage();
  await page.setViewport({ width: VP.w, height: VP.h, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => console.warn('  pageerror', e.message));
  await page.evaluateOnNewDocument(() => (localStorage.removeItem('ar.catalog.tried'), localStorage.removeItem('ar.stickers.collected')));
  await page.goto(`http://localhost:${port}/?debug`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__app?.director && window.__debugPanel && window.__cat, { timeout: 120000 });
  await page.evaluate(() => window.__debugPanel.open(false));
  await page.evaluate(() => window.__debugPanel.fastForward());
  await page.waitForFunction(() => window.__app.director.state.phase === 'play', { timeout: 30000 });
  await wait(2500);
  await page.evaluate(() => (window.__app.director.queue?.clear?.(), window.__debugPanel.open(false)));
  await calm(page);
  return page;
}
/** на снимке — только наклейки: прочие эффекты кота (жвачка, блёстки) убрать и не запускать */
const calm = (page) => page.evaluate(() => {
  const d = window.__app.director, fx = window.__app.fx;
  d.__runFx ??= d.runFx;
  d.runFx = (id) => (/^sticker/.test(id) ? d.__runFx.call(d, id) : Promise.resolve());
  for (const l of fx.live) l.inst.stop?.();
  fx.live = [];
  fx.gum.clear();
  fx.fog.clear();
  fx.parts.clear();
});
const shot = async (page, name) => {
  await wait(350);
  await page.screenshot({ path: path.join(outDir, `stickers_${name}.png`) });
  console.log('  ✓ stickers_' + name);
};
/** заморозить / разморозить лист наклеек (кадр анимации стоит) */
const freeze = (page, on) => page.evaluate((on) => {
  const sh = window.__app.fx.sheet;
  sh.__upd ??= sh.update;
  sh.update = on ? () => {} : sh.__upd;
}, on);
/** заклеить экран (смена образа) и дождаться конца серии */
async function cover(page) {
  await page.evaluate(() => window.__app.director.dispatch({ type: 'switch_request' }));
  // переспрос «Давай!» / «Не надо» — согласиться (чип или как будто сказали)
  for (let t = 0; t < 100; t++) {
    const st = await page.evaluate(() => {
      const yes = document.querySelector('.sug[data-chip="yes"]');
      if (yes) yes.click();
      return { n: window.__app.fx.sheet.coverCount, phase: window.__app.director.state.phase, yes: !!yes };
    });
    if (st.n >= 8) break;
    if (t === 60) console.warn('   cover: ждём', JSON.stringify(st));
    await wait(250);
  }
  await wait(1700);
  await calm(page);
}

const STATES = {
  /** «Чудеса → Наклейки»: наклейка сбоку от морды */
  async single(page) {
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.__app.director.action('sticker'));
      await wait(1600);
    }
    await shot(page, 'single');
  },
  /** шлепок: три фазы — в воздухе (крупная, тень далеко), касание с прогибом, прилипла и бежит блик */
  async slap(page) {
    await page.evaluate(() => {
      const fx = window.__app.fx;
      const { w, h } = { w: innerWidth, h: innerHeight };
      fx.clearStickers();
      const P = ['cat_paw', 'w_kruto', 'k_cocoa'];
      const at = [[w * 0.26, h * 0.2], [w * 0.74, h * 0.34], [w * 0.3, h * 0.62]];
      P.forEach((id, i) => fx.addSticker({ kind: 'image', id, src: `stickers/sber/${id}.svg` }, at[i][0], at[i][1], { size: Math.min(w, h) * 0.36, rot: [-0.25, 0.2, -0.1][i] }));
    });
    await wait(600); // картинки догрузились
    await freeze(page, true);
    await page.evaluate(() => {
      const L = window.__app.fx.sheet.list.slice(-3);
      [0.05, 0.27, 0.62].forEach((a, i) => (L[i].age = a));
      window.__app.fx.sheet.dirty = true;
    });
    await shot(page, 'slap');
    await freeze(page, false);
  },
  /** экран заклеен при смене образа: тематические нового кота + общие, кнопка «Сдёрнуть наклейки» */
  async cover(page) {
    await cover(page);
    await page.evaluate(() => window.__app.ui.show('shake_button', true));
    await shot(page, 'cover');
  },
  /** отклеивание: одну тянут пальцем за уголок, другая после тапа уже загибается и улетает */
  async peel(page) {
    await cover(page);
    await freeze(page, true);
    await page.evaluate(() => {
      const L = window.__app.fx.sheet.list.filter((s) => !s.flying);
      const near = (x, y) => L.reduce((m, s) => (Math.hypot(s.x - x, s.y - y) < Math.hypot(m.x - x, m.y - y) ? s : m));
      const a = near(innerWidth * 0.7, innerHeight * 0.3), b = near(innerWidth * 0.3, innerHeight * 0.62);
      // наверх: их видно целиком
      const sh = window.__app.fx.sheet;
      sh.list = [...sh.list.filter((s) => s !== a && s !== b), b, a];
      // уголок, смотрящий в центр экрана (его видно)
      const toC = (s) => {
        const c = Math.cos(-s.rot), sn = Math.sin(-s.rot), dx = innerWidth / 2 - s.x, dy = innerHeight / 2 - s.y;
        const lx = dx * c - dy * sn, ly = dx * sn + dy * c;
        return { x: Math.sign(lx || 1) * s.size / 2, y: Math.sign(ly || 1) * s.size / 2 };
      };
      a.peelCorner = toC(a);
      a.peel = 0.5;
      b.peelCorner = toC(b);
      b.peel = 0.4;
      b.flying = true;
      b.flyT = 0.12;
      b.x -= 30;
      b.y -= 60;
      b.rot -= 0.4;
      window.__app.fx.sheet.dirty = true;
    });
    await shot(page, 'peel');
    await freeze(page, false);
  },
  /** встряска: наклейки рассыпаются волной от центра (уголки отгибаются, улетают с вращением) */
  async blow(page) {
    await cover(page);
    await page.evaluate(() => window.__app.fx.blowStickers());
    await freeze(page, true);
    // прогнать физику вручную до середины разлёта
    await page.evaluate(() => {
      const sh = window.__app.fx.sheet;
      for (let i = 0; i < 14; i++) sh.__upd.call(sh, 1 / 60);
      sh.dirty = true;
    });
    await shot(page, 'blow');
    await freeze(page, false);
  },
  /** после встряски — новый кот и наклейка из каталога; в каталоге «Чудеса» у «Наклеек» — «собрал N из M» */
  async catalog(page) {
    await cover(page);
    await page.evaluate(() => window.__app.input.simulateShake());
    await page.waitForFunction(() => window.__app.director.state.phase !== 'switching', { timeout: 20000 });
    await wait(7000); // модель нового кота догружается
    await page.evaluate(() => window.__app.director.action('sticker'));
    await wait(1500);
    await page.evaluate(() => (window.__app.tracker.distance = 6, window.__app.director.queue?.clear?.()));
    await wait(300);
    await page.evaluate(() => document.querySelector('[data-a="paw"]').click());
    await wait(300);
    await page.evaluate(() => document.querySelector('.cat-tab[data-tab="magic"]')?.click());
    await page.evaluate(() => document.querySelector('.cat-row [data-item="sticker"]')?.scrollIntoView({ inline: 'end', block: 'nearest' }));
    await shot(page, 'catalog');
  },
};

for (const [name, fn] of Object.entries(STATES)) {
  if (only.length && !only.includes(name)) continue;
  const page = await open();
  try {
    await fn(page);
  } catch (e) {
    console.warn('  ✗', name, e.message);
  }
  await page.close();
}
await browser.close();
