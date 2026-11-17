// Скриншот tools/face-preview.html (или PAGE=eye-preview): node tools/face-shot.mjs out.png "<query>"  (vite dev на FACE_PORT, по умолч. 4177)
import puppeteer from 'puppeteer-core';
const [out, query] = process.argv.slice(2);
const port = process.env.FACE_PORT || 4177;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.setViewport({ width: 2000, height: 2000 });
await page.goto(`http://localhost:${port}/tools/${process.env.PAGE || "face-preview"}.html?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, { timeout: 120000 }).catch(() => {});
const info = await page.evaluate(() => ({ labels: window.__labels, morphs: window.__morphs }));
if (process.env.ALPHA) {
  // PNG с прозрачностью прямо из WebGL-холста (для наложения на фото)
  const url = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  (await import('node:fs')).writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
} else {
  const el = await page.$('canvas');
  await el.screenshot({ path: out });
}
console.log(JSON.stringify(info), errs.join('\n'));
await browser.close();
