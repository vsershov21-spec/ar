#!/usr/bin/env node
// Кадры заставки «вылупление из карты» (feature 'intro.quick', src/quick/splash.ts) → docs/qa/ui/hatch/.
// Запуск: AR_EDITIONS=pilot node scripts/build/editions.mjs && node scripts/hatch-shots.mjs
// Цикл 5 с снимается детерминированно: все CSS-анимации на паузе, currentTime = t. Плюс касание, «Узнать, кто там»,
// prefers-reduced-motion, первый кадр и средний fps на живой анимации (4× замедление CPU — грубая оценка телефона).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const out = path.join(root, 'docs/qa/ui/hatch');
fs.mkdirSync(out, { recursive: true });
const html = fs.readFileSync(path.join(DIST, 'mvp/index.html'), 'utf8');
// только заставка: бандл не грузим (кадры заставки не зависят от него, и он не уберёт её до нажатия)
const page0 = html.replace(/<script type="module"[^>]*><\/script>/g, '').replace(/<link rel="modulepreload"[^>]*>/g, '');
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page0);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/mvp/`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(w = 390, h = 844) {
  const pg = await browser.newPage();
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const t0 = Date.now();
  await pg.goto(url, { waitUntil: 'domcontentloaded' });
  return { pg, t0 };
}
const shot = async (pg, name) => {
  const f = path.join(out, `${name}.jpg`);
  await pg.screenshot({ path: f, type: 'jpeg', quality: 76 });
  console.log('  ✓', path.relative(root, f));
  return f;
};
const seek = (pg, ms) =>
  pg.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = ms;
    }
  }, ms);

const report = [];
{
  const { pg } = await open();
  const fcp = await pg.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? performance.now())))));
  report.push(`первый кадр (FCP, локально): ${Math.round(fcp)} мс`);
  // цикл: 20 кадров по 0,25 с
  const seq = [];
  for (let i = 0; i < 20; i++) {
    const ms = i * 250;
    await seek(pg, ms);
    await wait(30);
    seq.push(await shot(pg, `seq_${String(i).padStart(2, '0')}_${(ms / 1000).toFixed(2)}s`));
  }
  // ключевые моменты крупно
  for (const [ms, n] of [[0, '01_calm'], [1610, '02_tuk'], [2760, '03_tuk_tuk'], [3510, '04_TUK'], [3900, '05_peek_eyes']]) {
    await seek(pg, ms);
    await wait(30);
    await shot(pg, n);
  }
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', path.join(out, 'seq_*.jpg'), '-vf', 'scale=260:-1,tile=10x2', '-frames:v', '1', path.join(out, '00_cycle_sheet.jpg')]);
    for (const f of seq) fs.rmSync(f);
    console.log('  ✓ docs/qa/ui/hatch/00_cycle_sheet.jpg');
  } catch (e) {
    console.warn('  ! ffmpeg: лист цикла не собран', e.message);
  }
  await pg.close();
}
{
  // касание карты и «Узнать, кто там» — на живой анимации
  const { pg } = await open();
  await wait(600);
  await pg.tap('.q-card');
  await wait(90);
  await shot(pg, '06_tap_knock');
  // fps: 3 с живой анимации, CPU ×4
  const cdp = await pg.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const fps = await pg.evaluate(() => new Promise((r) => {
    let n = 0, worst = 0, last = performance.now();
    const t0 = last;
    const f = (now) => {
      n++;
      worst = Math.max(worst, now - last);
      last = now;
      if (now - t0 < 3000) requestAnimationFrame(f);
      else r({ fps: Math.round((n * 1000) / (now - t0)), worst: Math.round(worst) });
    };
    requestAnimationFrame(f);
  }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  report.push(`живая анимация, CPU ×4 (headless): ${fps.fps} к/с, худший кадр ${fps.worst} мс`);
  await pg.tap('.q-cta');
  await wait(180);
  await shot(pg, '07_open_crack_180ms');
  await wait(320);
  await shot(pg, '08_open_crack_500ms');
  await pg.close();
}
{
  const { pg } = await open();
  await pg.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await wait(300);
  await shot(pg, '09_reduced_motion');
  await pg.close();
}
{
  const { pg } = await open(375, 667);
  await seek(pg, 3900);
  await wait(30);
  await shot(pg, '10_375x667_peak');
  await pg.close();
}
const gz = execFileSync('sh', ['-c', `node -e "const h=require('fs').readFileSync('${path.join(DIST, 'mvp/index.html')}','utf8');const a=h.indexOf('<style id=\\"quick-css\\">');const b=h.indexOf('</script>',h.indexOf('<div id=\\"quick\\"'))+9;process.stdout.write(h.slice(a,b))" | gzip -9 | wc -c`]).toString().trim();
report.push(`встроенный блок заставки (стили + разметка + скрипт): ${gz} Б gzip`);
fs.writeFileSync(path.join(out, 'REPORT.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
await browser.close();
srv.close();
