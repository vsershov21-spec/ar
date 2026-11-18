#!/usr/bin/env node
// Лист всего пака наклеек → docs/ui/sticker_pack.png (рисунок, подпись, тема).
// Запуск: node scripts/stickers/pack-sheet.mjs   Chrome: CHROME (по умолчанию /usr/bin/google-chrome)
// Лист одного кота: node scripts/stickers/pack-sheet.mjs --persona hooligan → docs/ui/stickers_hooligan.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'public/stickers/sber');
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const uri = (src) => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(root, 'public', src)).toString('base64');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const persona = arg('--persona');
const list = persona ? man.stickers.filter((s) => s.theme === persona || s.personas.includes(persona)) : man.stickers;
const cols = persona ? Math.min(6, Math.ceil(list.length / 2)) : 6;
const cells = list.map((s, i) => `
  <figure style="--r:${((i * 37) % 11) - 5}deg">
    <img src="${uri(s.src)}" alt="">
    <figcaption><b>${s.title}</b><span>${man.themes[s.theme]}</span></figcaption>
  </figure>`).join('');
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; font: 14px/1.25 Inter, system-ui, sans-serif; color: #12301e;
    background: radial-gradient(120% 90% at 20% 0%, #eef8f1 0%, #d9ece2 60%, #cbe2d6 100%); }
  header { padding: 28px 36px 6px; display: flex; align-items: baseline; gap: 16px; }
  h1 { margin: 0; font-size: 30px; font-weight: 900; letter-spacing: -.02em; }
  header p { margin: 0; color: #3d6150; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, 200px); gap: 10px 18px; padding: 14px 36px 30px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; }
  img { width: 176px; height: 176px; transform: rotate(var(--r)); filter: drop-shadow(0 6px 8px rgba(10,60,30,.28)); }
  figcaption { text-align: center; } figcaption b { display: block; font-size: 14px; } figcaption span { color: #4f7462; font-size: 12px; }
</style><header><h1>${persona ? `${man.title}: ${man.themes[persona] ?? persona}` : man.title}</h1><p>${list.length} наклеек · SVG · палитра Сбера, без логотипов</p></header>
<div class="grid">${cells}</div>`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 36 * 2 + cols * 200 + (cols - 1) * 18, height: 200, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
const out = path.join(root, persona ? `docs/ui/stickers_${persona}.png` : 'docs/ui/sticker_pack.png');
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('✓', path.relative(root, out));
