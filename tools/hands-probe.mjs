// node tools/hands-probe.mjs [--models v1,v2] [--cats hooligan,kind,glitter] [--clips a,b] [--throttle 4] [--no-shots]
// Руки у головы и одежды (tools/hands-probe.html на dev-сервере vite, PORT=4190): «до» (кисть по осям, 18.11–19.11) и
// «после» (точки поверхности + контакт) → bench-out/hands/<v>_<кот>.json (позы для scripts/models/penetration.py
// --pose-json), листы худших кадров docs/qa/hands/<v>_<кот>_<клип>.png (клип как есть | до | после; анфас и профиль),
// время коррекции на кадр (--throttle N — замедление ЦП в N раз, «телефон»).
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const port = process.env.PORT || 4190;
const models = arg('--models', 'v1,v2').split(',');
const cats = arg('--cats', 'hooligan,kind,glitter').split(',');
const clips = arg('--clips', '');
const throttle = +arg('--throttle', 1);
const shots = !argv.includes('--no-shots');
const OUT = 'bench-out/hands', SHEETS = 'docs/qa/hands';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHEETS, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 1800000, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const summary = [];
for (const v of models)
  for (const cat of cats) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    if (throttle > 1) await (await page.target().createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: throttle });
    // v2 — по умолчанию (основа p1, variantGlb), v1 — прежний вид (?models=v1), v2h — геометрия v2
    const m = v === 'v2h' ? `/models/v2/${cat}_v2.glb` : v === 'v1' ? `/models/${cat}_v1.glb` : `/models/v2/${cat}_p1.glb`;
    await page.goto(`http://localhost:${port}/tools/hands-probe.html?p=${cat}&m=${m}&frames=${process.env.FRAMES || 12}&shots=${shots ? 1 : 0}${clips ? `&clips=${clips}` : ''}${v === 'v2' ? '' : `&models=${v}`}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready, { timeout: 1800000, polling: 500 });
    const res = await page.evaluate(() => window.__poses);
    await page.close();
    for (const [id, fr] of Object.entries(res.clips)) {
      if (!fr) continue;
      const w = fr.find((f) => f.worst);
      if (w?.shots) {
        const S = 300, lab = 22, top = 26;
        const cols = [['raw', `клип как есть · ${w.mmRaw.mm} мм`], ['before', `до (оси) · ${w.mmBefore.mm} мм`], ['after', `после (поверхность) · ${w.mmAfter.mm} мм`]];
        const tiles = [];
        for (let c = 0; c < 3; c++)
          for (let r = 0; r < 2; r++) {
            const buf = Buffer.from(w.shots[cols[c][0]][r].split(',')[1], 'base64');
            tiles.push({ input: await sharp(buf).resize(S, S).toBuffer(), left: c * S, top: top + lab + r * S });
          }
        const esc = (x) => String(x).replace(/[<&>]/g, '');
        const svg = Buffer.from(`<svg width="${3 * S}" height="${top + lab}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="6" y="18" font-size="15" font-family="DejaVu Sans" fill="#fff">${esc(`${v} · ${cat} · ${id} · t=${w.t} с (худший кадр «до»)`)}</text>${cols.map((c, i) => `<text x="${i * S + 6}" y="${top + 16}" font-size="13" font-family="DejaVu Sans" fill="${i === 2 ? '#8f8' : i === 1 ? '#fc8' : '#ccc'}">${esc(c[1])}</text>`).join('')}</svg>`);
        await sharp({ create: { width: 3 * S, height: top + lab + 2 * S, channels: 3, background: '#000' } }).composite([{ input: svg, left: 0, top: 0 }, ...tiles]).png({ palette: true, quality: 80, compressionLevel: 9 }).toFile(path.join(SHEETS, `${v}_${cat}_${id}.png`));
        delete w.shots;
      }
      // кадры без поз (между 12 равномерными) — только цифры
      const mx = (k) => Math.max(0, ...fr.map((f) => f[k].mm));
      // доля кадров с проникновением > 1 мм
      const share = (k) => +(fr.filter((f) => f[k].mm > 1).length / fr.length).toFixed(3);
      summary.push({ v, cat, clip: id, raw: mx('mmRaw'), before: mx('mmBefore'), after: mx('mmAfter'), frames: fr.length, over1Before: share('mmBefore'), over1After: share('mmAfter'), worstAfter: fr.reduce((a, f) => (f.mmAfter.mm > a.mm ? f.mmAfter : a), { mm: 0, pair: '' }).pair });
    }
    // для penetration.py --pose-json — только кадры с позами (12 равномерных + худший)
    const posed = { ...res, clips: Object.fromEntries(Object.entries(res.clips).map(([k, fr]) => [k, fr ? fr.filter((f) => f.after && f.pairs) : fr])) };
    fs.writeFileSync(path.join(OUT, `${v}_${cat}${throttle > 1 ? `_x${throttle}` : ''}.json`), JSON.stringify(posed));
    console.log(v, cat, 'прокси', res.proxies.length, 'точек', res.samples, 'perf', JSON.stringify(res.perf), errs.slice(0, 2).join(' | '));
  }
await browser.close();
for (const s of summary) console.log(`${s.v} ${s.cat} ${s.clip}: как есть ${s.raw} мм, до ${s.before}, после ${s.after} ${s.worstAfter} (кадров > 1 мм: до ${(s.over1Before * 100).toFixed(0)}%, после ${(s.over1After * 100).toFixed(0)}%)`);
fs.writeFileSync(path.join(OUT, `summary${throttle > 1 ? `_x${throttle}` : ''}.json`), JSON.stringify(summary, null, 1));
