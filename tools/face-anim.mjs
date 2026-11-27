// Кадры живого лица (tools/face-anim.html) → PNG и GIF: node tools/face-anim.mjs out.gif "<query>"   env PORT (vite dev)
// GIF собирает python3 (PIL) из кадров во временной папке; подпись «покой» / «реплика» в углу.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [out, query] = process.argv.slice(2);
const port = process.env.PORT || 4190;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-anim-'));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 1800000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://localhost:${port}/tools/face-anim.html?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, { timeout: 600000, polling: 500 });
const n = await page.evaluate(() => window.__total);
const meta = [];
for (let i = 0; i < n; i++) {
  const m = await page.evaluate((k) => window.__frame(k), i);
  const url = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  fs.writeFileSync(`${dir}/f${String(i).padStart(4, '0')}.png`, Buffer.from(url.split(',')[1], 'base64'));
  meta.push(m.label ?? (m.talk ? 'реплика' : 'покой'));
}
await browser.close();
fs.writeFileSync(`${dir}/meta.json`, JSON.stringify(meta));
const fps = +(new URLSearchParams(query).get('fps') || 12);
execFileSync('python3', ['-c', `
import sys, json, glob
from PIL import Image, ImageDraw, ImageFont
d, out, fps = sys.argv[1], sys.argv[2], float(sys.argv[3])
meta = json.load(open(d + '/meta.json'))
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 18)
fr = []
for f, m in zip(sorted(glob.glob(d + '/f*.png')), meta):
    im = Image.open(f).convert('RGB'); dr = ImageDraw.Draw(im)
    dr.rectangle((0, 0, 12 + 11 * len(m), 28), fill=(255, 255, 255)); dr.text((6, 4), m, fill=(20, 20, 30), font=F)
    fr.append(im)
# палитра — по кадрам со всей записи (смена эмоций: красный рот смеха, румянец; по одному кадру рот темнел)
step = max(1, len(fr) // 16)
sm = fr[::step]
mont = Image.new('RGB', (sm[0].width * len(sm), sm[0].height))
for i_, f_ in enumerate(sm):
    mont.paste(f_, (i_ * sm[0].width, 0))
pal = mont.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in fr]
q[0].save(out, save_all=True, append_images=q[1:], duration=int(1000 / fps), loop=0, optimize=True)
print(out, len(fr), 'кадров')
`, dir, out, String(fps)], { stdio: 'inherit' });
if (errs.length) console.log(errs.join('\n'));
