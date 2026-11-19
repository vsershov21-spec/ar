// Кот «как в приложении» (tools/persona-shot.html) → PNG; лист с рефами — tools/persona-sheet.py.
// node tools/persona-shot.mjs <outdir> <prefix> [hooligan kind glitter]   env: PORT (vite dev, 4190), Q (доп. query), PERF=N
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [outdir, prefix, ...cats] = process.argv.slice(2);
const list = cats.length ? cats : ['hooligan', 'kind', 'glitter'];
const port = process.env.PORT || 4190;
fs.mkdirSync(outdir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 900000, args: ['--no-sandbox', '--no-first-run', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const p of list) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => (m.type() === 'error' || (process.env.LOG && new RegExp(process.env.LOG).test(m.text()))) && errs.push(m.text()));
  await page.setViewport({ width: 1600, height: 600 });
  const perf = process.env.PERF ? `&perf=${process.env.PERF}` : '';
  await page.goto(`http://localhost:${port}/tools/persona-shot.html?p=${p}${perf}&${process.env.Q || ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready, { timeout: 600000, polling: 500 }).catch(() => errs.push('timeout'));
  const info = await page.evaluate(() => window.__info);
  const url = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  fs.writeFileSync(`${outdir}/${prefix}_${p}.png`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(p, JSON.stringify(info), errs.join(' | '));
  await page.close();
}
await browser.close();
