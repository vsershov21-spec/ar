// Время кадра котов (tools/fur-perf.html) в одном окружении: node tools/fur-perf.mjs   env PORT (vite dev)
// CASES="hooligan:&fur=6 glitter:&models=v5&fur=6" — свой набор
import puppeteer from 'puppeteer-core';
const port = process.env.PORT || 4190;
const cases = (process.env.CASES || 'hooligan:&fur=6 kind:&fur=6 glitter:&models=v5&fur=6 glitter:&models=v5&fur=0').split(' ');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const c of cases) {
  const [p, qs] = [c.slice(0, c.indexOf(':')), c.slice(c.indexOf(':') + 1)];
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/tools/fur-perf.html?p=${p}${qs}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready, { timeout: 600000, polling: 500 });
  const r = await page.evaluate(() => ({ ms: window.__ms, calls: window.__calls, tris: window.__tris }));
  console.log(`${p}${qs}\t${r.ms.toFixed(1)} мс/кадр\tвызовов ${r.calls}\tтреуг. ${r.tris}`);
  await page.close();
}
await browser.close();
