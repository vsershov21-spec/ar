#!/usr/bin/env node
// Скриншоты всех экранов и состояний интерфейса в docs/ui/<prefix>_<state>_<viewport>.png.
// Запуск: npx vite build && npx vite preview --port 4175 & node scripts/ui-shots.mjs before|after [state…]
// Chrome: CHROME (по умолчанию /usr/bin/google-chrome). Порт: UI_PORT (4175).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/ui');
fs.mkdirSync(outDir, { recursive: true });
const prefix = process.argv[2] || 'after';
const onlyStates = process.argv.slice(3);
const port = Number(process.env.UI_PORT ?? 4175);
const VPS = [
  { name: '390x844', w: 390, h: 844 },
  { name: '360x640', w: 360, h: 640 },
  { name: '430x932', w: 430, h: 932 },
  { name: 'land844x390', w: 844, h: 390 },
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});

async function open(vp) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => console.warn(`  [${vp.name}] pageerror ${e.message}`));
  await page.goto(`http://localhost:${port}/?debug`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__app?.director && window.__debugPanel && window.__cat, { timeout: 30000 });
  await page.evaluate(() => window.__debugPanel.open(false));
  return page;
}
const phase = (page) => page.evaluate(() => window.__app.director.state.phase);
async function until(page, fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true;
    await wait(150);
  }
  return false;
}
/** реплика в пузыре без озвучки (кот молчит, текст как в игре) */
const say = (page, text) => page.evaluate((t) => {
  const d = window.__app.director;
  window.__app.ui.say(t, d.persona.title, d.persona.id, 60000);
}, text);
const shot = async (page, state, vp) => {
  await wait(450);
  await page.screenshot({ path: path.join(outDir, `${prefix}_${state}_${vp.name}.png`) });
  console.log('  ✓', state, vp.name);
};
const wake = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Разбудить/.test(b.textContent))?.click());
};

const STATES = {
  async start(page, vp) {
    await shot(page, 'start', vp);
  },
  async scan(page, vp) {
    await wake(page);
    await wait(300);
    // карта ещё не найдена: подсказка наведения (debug-трекер находит карту сам — показываем принудительно)
    await page.evaluate(() => {
      window.__app.stage.show(false);
      window.__app.ui.show('scan_hint', true);
      window.__app.ui.show('mic', false);
    });
    await shot(page, 'scan', vp);
  },
  async ask_name(page, vp) {
    await wake(page);
    await until(page, () => window.__app.director.state.phase === 'ask_name');
    await wait(1200);
    await page.evaluate(() => window.__app.ui.show('name_prompt', true));
    await say(page, 'Привет! Я кот из твоей карты. А тебя как зовут?');
    await shot(page, 'ask_name', vp);
  },
  async choose(page, vp) {
    await wake(page);
    await until(page, () => window.__app.director.state.phase === 'ask_name');
    await page.evaluate(() => window.__app.director.dispatch({ type: 'skip_name' }));
    await until(page, () => document.querySelector('.choice-sheet') ? !document.querySelector('.choice-sheet').classList.contains('hidden') : window.__app.fx.stickers.some((s) => s.choice), 20000);
    // таймер выбора по умолчанию не должен закрыть выбор до снимка
    await page.evaluate(() => window.__app.director.timers?.forEach?.((t) => clearTimeout(t)));
    await wait(1200);
    await shot(page, 'choose', vp);
  },
  async play(page, vp) {
    await window_fast(page);
    await say(page, 'Йо! Давай играть: потыкай в меня, погладь или потряси телефон!');
    await shot(page, 'play_bubble', vp);
  },
  async chips(page, vp) {
    await window_fast(page);
    await page.evaluate(() => window.__app.ui.show('chips', true));
    await say(page, 'Не расслышал. Нажми подсказку!');
    await shot(page, 'chips', vp);
  },
  async mic_on(page, vp) {
    await window_fast(page);
    await page.evaluate(() => {
      const m = document.querySelector('.mic');
      m.classList.add('on');
      m.style.setProperty('--lvl', '0.5');
      window.__app.ui.micHintText('Слушаю…');
    });
    await shot(page, 'mic_listening', vp);
  },
  async mic_denied(page, vp) {
    await window_fast(page);
    await page.evaluate(() => window.__app.ui.micHintText('Нет доступа к микрофону — жми подсказки'));
    await shot(page, 'mic_denied', vp);
  },
  async muted(page, vp) {
    await window_fast(page);
    await page.evaluate(() => document.querySelector('[data-a="mute"]')?.click());
    await shot(page, 'muted', vp);
  },
  async switching(page, vp) {
    await window_fast(page);
    await page.evaluate(() => window.__app.director.dispatch({ type: 'switch_request' }));
    await wait(4200);
    await page.evaluate(() => window.__app.ui.show('shake_button', true));
    await shot(page, 'switching', vp);
  },
  async outro(page, vp) {
    await window_fast(page);
    await page.evaluate(() => window.__cat.outro());
    await wait(1500);
    await page.evaluate(() => window.__app.ui.show('sberkids', true));
    await say(page, 'Мне пора домой, в СберKids. Пойдёшь со мной?');
    await shot(page, 'outro', vp);
  },
  async no_camera(page, vp) {
    await wake(page);
    await wait(500);
    await page.evaluate(() => {
      window.__app.stage.show(false);
      const ui = window.__app.ui;
      if (ui.error) ui.error('Камера не включилась', 'Разреши доступ к камере в настройках браузера и попробуй ещё раз.');
      else ui.toast('Камера не включилась. Разреши доступ к камере в настройках браузера и обнови страницу.', 60000);
    });
    await shot(page, 'no_camera', vp);
  },
  async debug(page, vp) {
    await window_fast(page);
    await page.evaluate(() => window.__debugPanel.open(true));
    await shot(page, 'debug_open', vp);
    await page.evaluate(() => window.__debugPanel.open(false));
    await shot(page, 'debug_closed', vp);
  },
};
async function window_fast(page) {
  await page.evaluate(() => window.__debugPanel.fastForward());
  await until(page, () => window.__app.director.state.phase === 'play');
  await wait(2500);
  await page.evaluate(() => {
    const d = window.__app.director;
    d.queue?.clear?.();
    window.__debugPanel.open(false);
  });
}

for (const vp of VPS.filter((v) => !process.env.UI_VP || process.env.UI_VP.split(',').includes(v.name))) {
  for (const [name, fn] of Object.entries(STATES)) {
    if (onlyStates.length && !onlyStates.includes(name)) continue;
    // landscape — один проход по основным экранам
    if (vp.name.startsWith('land') && !['start', 'ask_name', 'choose', 'play', 'chips', 'outro', 'no_camera'].includes(name)) continue;
    const page = await open(vp);
    try {
      await fn(page, vp);
    } catch (e) {
      console.warn('  ✗', name, vp.name, e.message, await phase(page).catch(() => '?'));
    }
    await page.close();
  }
}
await browser.close();
