// Снимки котов в приложении (390×844, ?debug): обычный план и крупный («у стекла»), покой / рот «А» / улыбка.
// Запуск: npx vite --port 4180 --strictPort &  node tools/look-shots.mjs <prefix> [persona…]
// Кадры: docs/look/<prefix>_<persona>_<state>.png ; LOOK_PORT (4180), CHROME (/usr/bin/google-chrome).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/look');
fs.mkdirSync(outDir, { recursive: true });
const prefix = process.argv[2] || 'after';
const personas = process.argv.slice(3).length ? process.argv.slice(3) : ['hooligan', 'kind', 'glitter'];
const port = Number(process.env.LOOK_PORT ?? 4180);
const extra = process.env.LOOK_QUERY ?? '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

for (const p of personas) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => console.warn('  pageerror', e.message));
  await page.goto(`http://localhost:${port}/?debug${extra}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__app?.director && window.__debugPanel && window.__cat, { timeout: 60000 });
  await page.evaluate(() => window.__debugPanel.open?.(false));
  // стартовый экран (онбординг или «Разбудить кота») — нажимаем кнопку пробуждения, дальше debug-перемотка
  await page.evaluate(() => (document.querySelector('[data-a="wake"]') ?? [...document.querySelectorAll('button')].find((b) => /Разбудить/.test(b.textContent)))?.click());
  await wait(800);
  await page.evaluate(() => window.__debugPanel.fastForward());
  await page.waitForFunction(() => window.__app.director.state.phase === 'play', { timeout: 30000 }).catch(() => console.warn('  фаза не play'));
  await wait(800);
  await page.evaluate((id) => window.__cat.persona(id), p);
  // ждём, пока загрузится GLB этого характера
  await page.waitForFunction(() => window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 90000 }).catch(() => {});
  await wait(7000); // пузырь появления и первая реплика успевают закончиться
  // тишина: кот не говорит сам и не бегает по idle-набору
  await page.evaluate(() => {
    const d = window.__app.director;
    d.queue?.clear?.();
    d.paused = true;
    window.__app.ui?.say?.('', '', '', 1);
    document.querySelectorAll('.dbg, .debug-panel, #debug').forEach((e) => (e.style.display = 'none'));
    const c = window.__app.character;
    c.play('idle');
    c.__sm = c.setMouth.bind(c);
    window.__mouth = null;
    c.setMouth = (v, w, s) => (window.__mouth ? c.__sm(...window.__mouth) : c.__sm(v, w, s));
  });
  const shot = async (name) => {
    // один и тот же клип покоя перед каждым кадром (idle-набор режиссёра не подменяет позу)
    await page.evaluate(() => {
      const c = window.__app.character;
      c.play('idle');
      c.clips.setIdles?.(['idle'], c.personaId);
    });
    await wait(700);
    await page.screenshot({ path: path.join(outDir, `${prefix}_${p}_${name}.png`) });
    console.log('  ✓', p, name);
  };
  const face = (f) => page.evaluate((f) => window.__app.character.face(f), f);
  const mouth = (m) => page.evaluate((m) => (window.__mouth = m), m);
  for (const mode of ['card', 'glass']) {
    await page.evaluate((m) => window.__app.stage.setMode(m), mode);
    await wait(1500);
    await face('neutral');
    await mouth(null);
    await shot(`${mode}_neutral`);
    await mouth(['D', 1, { open: 0.9, wide: 0.4, round: 0 }]);
    await shot(`${mode}_A`);
    await mouth(['E', 1, { open: 0.55, wide: 0, round: 0.6 }]);
    await shot(`${mode}_O`);
    await mouth(null);
    await face('happy');
    await shot(`${mode}_happy`);
    // речь: настоящий липсинк (cues «при-вет, как де-ла») — 6 кадров через 120 мс, рот и голова в движении
    await face('neutral');
    await page.evaluate(() => {
      const seq = 'BDXBCDXAEDBFDXCDBEX'.repeat(4).split('');
      const cues = seq.map((v, i) => ({ start: i * 0.13, end: (i + 1) * 0.13, value: v }));
      window.__app.voice.lip.playCues(cues, () => performance.now() / 1000);
    });
    for (let i = 0; i < 6; i++) {
      await wait(i ? 120 : 250);
      await page.screenshot({ path: path.join(outDir, `${prefix}_${p}_${mode}_talk${i}.png`) });
    }
    await page.evaluate(() => window.__app.voice.lip.stop());
  }
  await page.close();
}
await browser.close();
