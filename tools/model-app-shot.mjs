// Кот в приложении без карты (?nocard=off: фирменный фон, свет и мех приложения) → PNG 390×844 @2.
// npx vite --port 4190 &  node tools/model-app-shot.mjs <outdir> [hooligan kind glitter]   env: PORT, Q (доп. query)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [outdir, ...cats] = process.argv.slice(2);
const list = cats.length ? cats : ['hooligan', 'kind', 'glitter'];
const port = process.env.PORT || 4190;
fs.mkdirSync(outdir, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'] });
for (const cat of list) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    const P = location.pathname.startsWith('/lab') ? 'lab:' : location.pathname.startsWith('/mvp') ? 'pilot:' : '';
    localStorage.setItem(P + 'sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
    localStorage.setItem(P + 'ar.catalog.tried', JSON.stringify(['pet', 'tickle', 'treat']));
  });
  await page.goto(`http://localhost:${port}/${process.env.ED ?? 'mvp'}/?from=test&nocard=off&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics&${process.env.Q || ''}`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.__app?.home && window.__edition, { timeout: 300000 }).catch(() => errs.push('timeout'));
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  await page.waitForFunction(() => ['play', 'free'].includes(window.__app?.director?.state?.phase), { timeout: 300000 }).catch(() => errs.push('phase'));
  await wait(+(process.env.WAIT || 25000));
  await page.screenshot({ path: `${outdir}/v2_app_${cat}.png` });
  console.log(cat, errs.slice(0, 3).join(' | '));
  await page.close();
}
await browser.close();
