// Снимок tools/body-preview.html: node tools/body-shot.mjs out.png "<query>"  (vite dev на BODY_PORT, по умолч. 4181)
import puppeteer from 'puppeteer-core';
const [out, query] = process.argv.slice(2);
const port = process.env.BODY_PORT || 4181;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 600000, args: ['--no-sandbox', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.setViewport({ width: 2400, height: 600 });
await page.goto(`http://localhost:${port}/tools/body-preview.html?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, { timeout: 180000 }).catch(() => errs.push('timeout'));
const el = await page.$('canvas');
await el.screenshot({ path: out });
if (errs.length) console.log(errs.join('\n'));
await browser.close();
