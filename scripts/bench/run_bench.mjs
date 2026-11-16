#!/usr/bin/env node
// Стенд распознавания: для каждой карты компилирует .mind, генерирует синтетические кадры
// и прогоняет детектор + матчер MindAR (Controller.detect/match) в headless Chromium.
// Результат: docs/TRACKING_REPORT.md (+ JSON в bench-out/).
// Usage: node scripts/bench/run_bench.mjs [c-068 c-067 ...] [--n 12]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const nIdx = args.indexOf('--n');
const N = nIdx >= 0 ? Number(args.splice(nIdx, 2)[1]) : 12;
const cardsDir = process.env.CARDS_DIR || '/home/claude/deck/cards';
const cards = args.length ? args : ['c-068', 'c-067', 'c-069', 'c-004'];
const out = path.join(root, 'bench-out');
fs.mkdirSync(out, { recursive: true });

// 1. подготовка: .mind + кадры
for (const c of cards) {
  const png = path.join(cardsDir, c + '.png');
  const dir = path.join(out, c);
  if (!fs.existsSync(path.join(dir, 'card.mind'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('node', [path.join(root, 'scripts/compile-target.mjs'), png, '--out', path.join(dir, 'card.mind'), '--png-out', path.join(dir, 'card.png')], { stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(dir, 'frames/manifest.json')))
    execFileSync('python3', [path.join(root, 'scripts/bench/gen_frames.py'), png, path.join(dir, 'frames'), '--n', String(N)], { stdio: 'inherit' });
}

// 2. сервер: dist mind-ar + bench-out
const mime = { '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.mind': 'application/octet-stream' };
const page = `<!doctype html><meta charset=utf-8><script type=module>
import { Controller } from '/dist/mindar-image.prod.js';
window.__run = async (card, manifest) => {
  const res = [];
  const ctrl = new Controller({ inputWidth: manifest.width, inputHeight: manifest.height, maxTrack: 1 });
  await ctrl.addImageTargets('/out/' + card + '/card.mind');
  for (const f of manifest.frames) {
    const img = new Image(); img.src = '/out/' + card + '/frames/' + f.file; await img.decode();
    const c = document.createElement('canvas'); c.width = manifest.width; c.height = manifest.height;
    c.getContext('2d').drawImage(img, 0, 0);
    const t0 = performance.now();
    const { featurePoints } = await ctrl.detect(c);
    const { modelViewTransform } = await ctrl.match(featurePoints, 0);
    let tracked = null;
    if (modelViewTransform) {
      // один шаг трекинга от найденной позы — проверяем, что поза «держится»
      const tr = await ctrl.track(c, modelViewTransform, 0);
      tracked = tr.worldCoords.length;
    }
    res.push({ file: f.file, cond: f.cond, found: !!modelViewTransform, features: featurePoints.length, tracked, ms: performance.now() - t0 });
  }
  return res;
};
window.__ready = true;
</script>`;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = null;
  if (u === '/') { res.setHeader('content-type', 'text/html'); return res.end(page); }
  if (u.startsWith('/dist/')) f = path.join(root, 'node_modules/mind-ar/dist', path.basename(u));
  if (u.startsWith('/out/')) f = path.join(out, u.slice(5));
  if (f && f.startsWith(path.join(root)) && fs.existsSync(f)) { res.setHeader('content-type', mime[path.extname(f)] || 'application/octet-stream'); return res.end(fs.readFileSync(f)); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const all = {};
try {
  for (const c of cards) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => console.error('pageerror', e.message));
    await p.goto(`http://127.0.0.1:${server.address().port}/`);
    await p.waitForFunction('window.__ready === true');
    const manifest = JSON.parse(fs.readFileSync(path.join(out, c, 'frames/manifest.json'), 'utf8'));
    console.log(`${c}: ${manifest.frames.length} кадров…`);
    all[c] = await p.evaluate((c, m) => window.__run(c, m), c, manifest);
    await p.close();
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(all, null, 1));

// 3. отчёт
const conds = [...new Set(Object.values(all).flat().map((r) => r.cond))];
const LABEL = {
  base_front: 'Фронтально, карта 60% кадра', tilt_30: 'Наклон 30°', tilt_45: 'Наклон 45°', tilt_60: 'Наклон 60°', tilt_45_yaw_30: 'Наклон 45° + поворот 30°',
  scale_small_25: 'Мелко: карта 25% кадра (наклон 30°)', scale_large_90: 'Крупно: карта 90% кадра', roll_45: 'Поворот в плоскости 45°', blur_2px: 'Размытие 2 px', blur_4px: 'Размытие 4 px (движение/фокус)',
  glare: 'Блик', shadow: 'Тень на половине кадра', noise_15: 'Шум σ=15 (темно, ISO)', dim_light: 'Тусклый свет (35%)', finger_15: 'Палец перекрывает ~15%', finger_30: 'Палец перекрывает ~30%',
};
let md = `# Отчёт: распознавание карт (MindAR 1.2.5, синтетический стенд)\n\n`;
md += `> **Цифры предварительные.** Исходники карт — низкое разрешение (~300×190 px, апскейл до 1000 px при компиляции),\n> кадры синтетические (640×480, перспектива/эффекты сгенерированы программно, без реальной камеры, автофокуса и бликов ламината).\n> Проверяется только **первичное обнаружение** (detect + match по одному кадру) и один шаг трекинга; в живом режиме MindAR\n> после обнаружения переходит в трекинг, который держит карту устойчивее, чем показывает этот тест.\n> Перезапуск: \`node scripts/bench/run_bench.mjs c-068 c-067 c-069 c-004 --n ${N}\` (при новом хайрезе — положите PNG и укажите CARDS_DIR).\n\n`;
md += `Кадров на условие: ${N}. Ячейка — доля кадров, где карта найдена (в скобках — среднее число точек трекинга после обнаружения).\n\n`;
md += `| Условие | ${cards.join(' | ')} |\n|---|${cards.map(() => '---').join('|')}|\n`;
for (const cond of conds) {
  md += `| ${LABEL[cond] ?? cond} |`;
  for (const c of cards) {
    const rs = all[c].filter((r) => r.cond === cond);
    const ok = rs.filter((r) => r.found);
    const pct = Math.round((ok.length / rs.length) * 100);
    const tr = ok.length ? Math.round(ok.reduce((a, r) => a + (r.tracked ?? 0), 0) / ok.length) : 0;
    md += ` ${pct}%${ok.length ? ` (${tr})` : ''} |`;
  }
  md += '\n';
}
md += `| **Итого** |`;
for (const c of cards) {
  const rs = all[c];
  md += ` **${Math.round((rs.filter((r) => r.found).length / rs.length) * 100)}%** |`;
}
md += `\n\nСреднее время detect+match на кадр в headless (SwiftShader, CPU): ${Math.round(Object.values(all).flat().reduce((a, r) => a + r.ms, 0) / Object.values(all).flat().length)} мс — на телефоне с GPU быстрее, для оценки не использовать.\n`;
fs.writeFileSync(path.join(out, 'report.md'), md);
console.log(md);
