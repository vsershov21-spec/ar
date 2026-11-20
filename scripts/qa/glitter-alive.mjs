#!/usr/bin/env node
// «Блёстка живая» (20.11): покой и реакции в пилоте (/mvp, headless) до/после слоя aliveIdle + фатин + хвост.
//   node scripts/qa/glitter-alive.mjs --url http://localhost:5199/      (vite dev, VITE_EDITION=pilot)
//   node scripts/qa/glitter-alive.mjs --dist DIR                        (сборка pilot)
// «До» — тот же код с выключенным слоем (character.aliveOff = true, фатин без пружины, хвост — прежний размах).
// Выход: docs/qa/glitter_alive/{before,after}.png (16 кадров покоя + 6 кадров реакции), {before,after}.gif (покой,
// 10 к/с), bench-out/glitter_alive.json — замеры:
//   hipSway — размах таза вбок, мм; tail — размах кончика хвоста, мм; tulle — макс. сдвиг подола, мм; elbow — средний
//   сгиб локтя, град (палка — ≈ 0–10°); pen — макс. проникновение лап в тело/одежду, мм; slide — уезд опорной стопы, мм;
//   frameMs — время update() кота на кадр, мс (headless swiftshader, относительное до/после).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { reactionClock } from './reactions-clock.js';
import { installProbe } from './reactions-probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DIST = arg('--dist', '') ? path.resolve(arg('--dist')) : '';
const PORT = Number(arg('--port', 4198));
const URL0 = arg('--url', `http://localhost:${PORT}/`);
const OUTD = path.resolve(root, arg('--out', 'docs/qa/glitter_alive'));
const log = (...a) => console.log(`[alive ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUTD, { recursive: true });
fs.mkdirSync(path.join(root, 'bench-out'), { recursive: true });

function serve() {
  const T = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.png': 'image/png', '.ktx2': 'image/ktx2', '.mp3': 'audio/mpeg' };
  return http
    .createServer((q, r) => {
      let p = decodeURIComponent(q.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(DIST, path.normalize(p));
      if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return (r.statusCode = 404), r.end();
      r.setHeader('content-type', T[path.extname(f)] ?? 'application/octet-stream');
      fs.createReadStream(f).pipe(r);
    })
    .listen(PORT);
}

/** замеры кадра (в странице): таз, кончик хвоста, подол, локти, время update */
function aliveProbe() {
  const app = window.__app, rx = window.__rx, c = app.character;
  const V = c.object.position.constructor;
  const orig = rx.frame;
  if (!c.__aliveT) {
    const up = c.update.bind(c);
    c.update = (dt, cam) => {
      const t0 = window.__vt.real.now();
      up(dt, cam);
      c.__lastMs = window.__vt.real.now() - t0;
    };
    c.__aliveT = true;
  }
  rx.frame = () => {
    const r = orig();
    const L = (n) => {
      const b = c.bones.get(n) ?? c.object.getObjectByName(n);
      return b ? c.object.worldToLocal(b.getWorldPosition(new V())) : null;
    };
    const mm = (v) => +(v * (rx.catMM ?? 94)).toFixed(1);
    const hip = L('Hips'), tail = L('Tail4');
    r.al = { hipX: hip ? mm(hip.x) : 0, tailX: tail ? mm(tail.x) : 0, tailY: tail ? mm(tail.y) : 0, tulle: mm(c.aliveDbg?.tulle ?? 0), w: +(c.aliveDbg?.w ?? 0).toFixed(2), pose: c.aliveDbg?.pose ?? '', ms: +(c.__lastMs ?? 0).toFixed(2) };
    const el = [];
    for (const s of ['Left', 'Right']) {
      const a = L(s + 'Arm'), e = L(s + 'ForeArm'), h = L(s + 'Hand');
      if (a && e && h) el.push((e.clone().sub(a).angleTo(h.clone().sub(e)) * 180) / Math.PI);
    }
    r.al.elbow = +(el.reduce((x, y) => x + y, 0) / Math.max(1, el.length)).toFixed(1);
    return r;
  };
  return true;
}

async function run(browser, off) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log('pageerror', e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(reactionClock, { persona: 'glitter' });
  await page.goto(`${URL0}?from=test&nocard=off&debug`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.__app?.director && window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 300000 });
  await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]'), { timeout: 120000 });
  await page.evaluate(() => window.__debugPanel?.open?.(false));
  await page.addStyleTag({ content: 'html.rxshot *{visibility:hidden!important} html.rxshot canvas{visibility:visible!important}' });
  await page.evaluate(() => window.__vt.manual());
  await page.evaluate(installProbe);
  await page.evaluate(aliveProbe);
  await page.evaluate((off) => {
    const c = window.__app.character;
    c.aliveOff = off;
    // «до»: фатин без пружины, хвост с прежним размахом (tailRig: glitter amp 1.15)
    if (off) {
      c.applyTulle = () => {};
      const tr = c.tailRig;
      if (tr) tr.personaScale = 1.15 / 1.45;
    }
  }, off);
  await page.evaluate(() => document.querySelector('[data-a="wake"]').click());
  await page.evaluate(() => (window.__rx.begin('boot'), window.__rx.run(8000)));
  await page.evaluate(async () => {
    for (let i = 0; i < 40 && !(['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy); i++) await window.__rx.run(window.__rx.t() + 500);
    // инициатива режиссёра не перебивает замер покоя
    window.__app.director.queue.clear?.();
  });
  const shots = [], gif = [];
  // покой 8 с: 16 кадров листа, GIF — 10 к/с
  await page.evaluate(() => window.__rx.begin('idle'));
  for (let i = 1; i <= 80; i++) {
    const t = i * 100;
    const sheet = i % 5 === 0;
    await page.evaluate((t) => window.__rx.run(t, true), t);
    const info = await page.evaluate(() => ({ box: window.__rx.catBox(), f: window.__rx.frames[window.__rx.frames.length - 1] }));
    await page.evaluate(() => document.documentElement.classList.add('rxshot'));
    const buf = await page.screenshot({ type: 'png' });
    await page.evaluate(() => document.documentElement.classList.remove('rxshot'));
    gif.push({ buf, box: info.box });
    if (sheet) shots.push({ buf, box: info.box, t: info.f.t, lab: `${info.f.clip} · ${info.f.al.pose || '—'}` });
  }
  const idle = await page.evaluate(() => window.__rx.end());
  // реакция: тап по голове (кокетливо) — 3 с, 6 кадров
  await page.evaluate(() => {
    window.__rx.begin('react');
    window.__rx.add({ op: 'tap', at: 100, bone: 'Head', dy: -0.04 });
  });
  for (let i = 1; i <= 6; i++) {
    await page.evaluate((t) => window.__rx.run(t, true), 100 + i * 500);
    const info = await page.evaluate(() => ({ box: window.__rx.catBox(), f: window.__rx.frames[window.__rx.frames.length - 1] }));
    await page.evaluate(() => document.documentElement.classList.add('rxshot'));
    const buf = await page.screenshot({ type: 'png' });
    await page.evaluate(() => document.documentElement.classList.remove('rxshot'));
    shots.push({ buf, box: info.box, t: info.f.t, lab: `тап голова · ${info.f.clip}` });
  }
  const react = await page.evaluate(() => window.__rx.end());
  await page.close();
  return { shots, gif, idle, react };
}

function stats(fr) {
  const f = fr.filter((x) => !x.mark && x.al);
  const rng = (a) => (a.length ? +(Math.max(...a) - Math.min(...a)).toFixed(1) : 0);
  // уезд опорной стопы: стопа на опоре (≤ 4 мм) — сколько уехала от точки постановки
  let slide = 0;
  const plant = [];
  for (const x of f) {
    for (let k = 0; k < (x.fh?.length ?? 0); k++) {
      const px = x.fp[2 * k], py = x.fp[2 * k + 1], h = x.fh[k];
      if (h > 4 || /look_around|turn/.test(x.clip)) {
        plant[k] = null;
        continue;
      }
      if (!plant[k]) plant[k] = { px, py };
      slide = Math.max(slide, Math.hypot(px - plant[k].px, py - plant[k].py));
    }
  }
  const med = (a) => (a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : 0);
  return {
    hipSway: rng(f.map((x) => x.al.hipX)),
    tail: +Math.hypot(rng(f.map((x) => x.al.tailX)), rng(f.map((x) => x.al.tailY))).toFixed(1),
    tulle: Math.max(0, ...f.map((x) => x.al.tulle)),
    elbow: +(f.reduce((a, x) => a + x.al.elbow, 0) / Math.max(1, f.length)).toFixed(1),
    pen: Math.max(0, ...f.map((x) => x.penMM ?? 0)),
    penPair: f.reduce((b, x) => ((x.penMM ?? 0) > (b.v ?? 0) ? { v: x.penMM, p: x.penPair } : b), {}).p ?? '',
    slide: +slide.toFixed(1),
    frameMs: +med(f.map((x) => x.al.ms)).toFixed(2),
    poses: [...new Set(f.map((x) => x.al.pose).filter(Boolean))],
  };
}

async function crop(s, S = 160, H = 272) {
  const b = s.box;
  const bh = Math.max(60, b.y1 - b.y0);
  const ch = Math.max(160, bh * 2.1), cw = (ch * S) / H;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 - bh * 0.6 + b.y1 + bh * 0.15) / 2;
  const L = Math.max(0, Math.min(390 - cw, cx - cw / 2)), T = Math.max(0, Math.min(844 - ch, cy - ch / 2));
  return sharp(s.buf).extract({ left: Math.round(L * 2), top: Math.round(T * 2), width: Math.round(Math.min(cw, 390) * 2), height: Math.round(Math.min(ch, 844) * 2) }).resize(S, H, { fit: 'cover' });
}

async function sheet(name, shots, st) {
  const S = 160, H = 272, lab = 30, cols = 8;
  const esc = (x) => String(x ?? '').replace(/[<&>]/g, '');
  const tiles = await Promise.all(
    shots.map(async (s) => {
      const img = await (await crop(s, S, H)).toBuffer();
      const svg = Buffer.from(`<svg width="${S}" height="${lab}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="4" y="13" font-size="11" font-family="DejaVu Sans" fill="#fff">${(s.t / 1000).toFixed(1)} с</text><text x="4" y="26" font-size="10" font-family="DejaVu Sans" fill="#9cf">${esc(s.lab)}</text></svg>`);
      return sharp({ create: { width: S, height: H + lab, channels: 3, background: '#111' } }).composite([{ input: img, top: 0, left: 0 }, { input: svg, top: H, left: 0 }]).png().toBuffer();
    }),
  );
  const rows = Math.ceil(tiles.length / cols);
  const head = 26;
  const title = Buffer.from(`<svg width="${cols * S}" height="${head}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#222"/><text x="6" y="17" font-size="13" font-family="DejaVu Sans" fill="#fff">${esc(name)}: таз ${st.hipSway} мм · хвост ${st.tail} мм · фатин ${st.tulle} мм · локоть ${st.elbow}° · проникн. ${st.pen} мм · стопа ${st.slide} мм</text></svg>`);
  await sharp({ create: { width: cols * S, height: rows * (H + lab) + head, channels: 3, background: '#000' } })
    .composite([{ input: title, top: 0, left: 0 }, ...tiles.map((input, i) => ({ input, left: (i % cols) * S, top: head + Math.floor(i / cols) * (H + lab) }))])
    .png({ palette: true, quality: 75, compressionLevel: 9 })
    .toFile(path.join(OUTD, `${name}.png`));
}

async function makeGif(name, frames) {
  const dir = fs.mkdtempSync('/tmp/alive-gif-');
  await Promise.all(frames.map(async (s, i) => (await crop(s, 240, 408)).png().toFile(path.join(dir, `f${String(i).padStart(3, '0')}.png`))));
  const out = path.join(OUTD, `${name}.gif`);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '10', '-i', path.join(dir, 'f%03d.png'), '-vf', 'split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status) log('ffmpeg:', String(r.stderr).slice(0, 300));
}

async function main() {
  const srv = DIST ? serve() : null;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 900000, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'] });
  const res = {};
  try {
    for (const [name, off] of [['before', true], ['after', false]]) {
      const r = await run(browser, off);
      const st = { idle: stats(r.idle.frames), react: stats(r.react.frames) };
      res[name] = st;
      log(name, JSON.stringify(st));
      await sheet(name, r.shots, st.idle);
      await makeGif(name, r.gif);
    }
  } finally {
    await browser.close();
    srv?.close();
  }
  fs.writeFileSync(path.join(root, 'bench-out/glitter_alive.json'), JSON.stringify(res, null, 1));
  log('готово', path.relative(root, OUTD));
}
main().catch((e) => (console.error(e), process.exit(1)));
