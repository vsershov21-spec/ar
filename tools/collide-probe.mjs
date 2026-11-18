// node tools/collide-probe.mjs <out.json> <cat> <model url> [clips] — позы до/после коррекции (tools/collide-probe.html)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const [out, cat, m, clips] = process.argv.slice(2);
const port = process.env.PORT || 4190;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 900000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://localhost:${port}/tools/collide-probe.html?p=${cat}&m=${m}&clips=${clips || 'scratch,poke_head,shy,think,laugh_01,laugh_02,wave_goodbye_01,cover_ears,poke_cheek,cry,idle_hooligan_headphones'}&frames=${process.env.FRAMES || 8}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, { timeout: 600000, polling: 500 });
const res = await page.evaluate(() => window.__poses);
fs.writeFileSync(out, JSON.stringify(res));
console.log(cat, 'прокси:', res.proxies.join(','), '| клипы:', Object.entries(res.clips).map(([k, v]) => `${k}:${v ? v.length : 'нет'}`).join(' '), errs.slice(0, 2).join(' | '));
await browser.close();
