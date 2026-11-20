#!/usr/bin/env node
// Листы «предмет в лапе / скейт» (20.11, вторая итерация): кнопка каталога → 12 кадров действия крупно + крупный план
// кисти с предметом, замеры каждого кадра (хват, рот, вертикаль кружки, зеркальце к морде, стопы на деке).
//
//   node scripts/qa/props-sheet.mjs --dist DIR --tag after          — DIR: сборка pilot (VITE_EDITION=pilot vite build)
//   node scripts/qa/props-sheet.mjs --url http://localhost:5199/ …  — или уже запущенный сервер (vite dev)
//   --cats kind,glitter,hooligan  --acts cocoa,treat  (по умолчанию — свои действия кота, см. ACTS)
//   --out docs/qa/props/after (листы)  → bench-out/props/<tag>.json (замеры)
//
// Метрики (мм на карте, рост кота — cfg.height × 85,6 мм):
//   grip   — от точки хвата предмета (начало узла prop = ручка/донышко на доле grip) до центра ладони; макс. по кадрам,
//            где предмет виден (масштаб > 0,5). Тест «нет отрывов»: ≤ 8 мм каждый кадр;
//   mouth  — от «рабочего» края предмета (верх кружки / голова рыбки / пластинка) до рта, мин. в фазе use;
//   up     — наклон оси кружки от вертикали, град (макс. вне глотка);
//   face   — зеркальце: угол между нормалью стекла и направлением на морду, град; dist — до морды в ширинах головы;
//   deck   — скейт: от стопы до точки на деке, мм (макс. на проезде), wheel — оборотов колеса за проезд.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { reactionClock } from './reactions-clock.js';
import { installProbe } from './reactions-probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TAG = arg('--tag', 'now');
const OUTD = path.resolve(root, arg('--out', `docs/qa/props/${TAG}`));
const DIST = arg('--dist', '') ? path.resolve(arg('--dist')) : '';
const PORT = Number(arg('--port', 4197));
const URL0 = arg('--url', `http://localhost:${PORT}/`);
const CATS = arg('--cats', 'kind,glitter,hooligan').split(',');
const ACTS = { kind: ['cocoa', 'treat'], glitter: ['mirror', 'treat'], hooligan: ['skate', 'bubbles', 'treat'] };
const ONLY = arg('--acts', '') ? arg('--acts').split(',') : null;
const N = Number(arg('--frames', 12));
const log = (...a) => console.log(`[props ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUTD, { recursive: true });
fs.mkdirSync(path.join(root, 'bench-out/props'), { recursive: true });

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ktx2': 'image/ktx2' };
function serve() {
  return http
    .createServer((q, r) => {
      let p = decodeURIComponent(q.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(DIST, path.normalize(p));
      if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return (r.statusCode = 404), r.end();
      r.setHeader('content-type', TYPES[path.extname(f)] ?? 'application/octet-stream');
      fs.createReadStream(f).pipe(r);
    })
    .listen(PORT);
}

/** замеры предмета/скейта за кадр (в странице) */
function propProbe() {
  const app = window.__app, rx = window.__rx;
  const orig = rx.frame;
  rx.frame = () => {
    const r = orig();
    const c = app.character, st = c.actState, po = c.props?.object;
    const V = c.object.position.constructor;
    const s = c.object.getWorldScale(new V()).y || 1;
    const mm = (d) => +((d / s) * (rx.catMM ?? 94)).toFixed(1);
    r.prop = null;
    if (st && po && st.id !== 'skate' && po.visible && po.scale.x > 0.5) {
      const hand = c.bones.get(st.id === 'mirror' ? 'LeftHand' : 'RightHand');
      const side = st.id === 'mirror' ? 'Left' : 'Right';
      const m1 = c.object.getObjectByName('mixamorig' + side + 'HandMiddle1');
      const hp = hand.getWorldPosition(new V());
      const palm = m1 ? hp.clone().lerp(m1.getWorldPosition(new V()), 0.6) : hp;
      const g = po.getWorldPosition(new V());
      const q = po.getWorldQuaternion(new c.object.quaternion.constructor());
      const up = new V(0, 1, 0).applyQuaternion(q);
      const objUp = new V(0, 1, 0).applyQuaternion(c.object.getWorldQuaternion(new c.object.quaternion.constructor()));
      const mouth = c.mouthLocal ? c.mouthLocal() : c.anchorLocal ? c.anchorLocal('mouth') : null;
      const mw = mouth ? c.object.localToWorld(mouth.clone()) : null;
      // «рабочий» край: верх предмета по его оси (кружка — край, рыбка — голова, жвачка — верх)
      const h = (c.props.dims?.h ?? 0.1) * s;
      const grip = { hold_cocoa: 0.45, hold_mirror: 0.14, hold_fish: 0.12, hold_gum: 0.15 }[c.props.holding] ?? 0;
      const top = g.clone().addScaledVector(up, h * (1 - grip) * 0.92);
      const head = c.bones.get('Head').getWorldPosition(new V());
      // кружку держат за ручку сбоку: ось кружки — на 0,78 радиуса от ладони (placeHold)
      const off = c.props.holding === 'hold_cocoa' ? (c.props.dims?.r ?? 0) * 0.78 * s * (po.scale.x || 1) : 0;
      r.prop = {
        grip: mm(Math.abs(g.distanceTo(palm) - off)),
        stretch: +(c.holdDbg?.stretch ?? 1).toFixed(2),
        miss: mm((c.holdDbg?.miss ?? 0) * s),
        mouth: mw ? mm(top.distanceTo(mw)) : -1,
        up: +((Math.acos(Math.max(-1, Math.min(1, up.dot(objUp)))) * 180) / Math.PI).toFixed(1),
      };
      if (st.id === 'mirror') {
        const ctr = g.clone().addScaledVector(up, h * 0.6);
        const n = new V(0, 0, 1).applyQuaternion(q);
        const eyes = head.clone().addScaledVector(objUp, 0.08 * s);
        const toFace = eyes.clone().sub(ctr).normalize();
        r.prop.face = +((Math.acos(Math.max(-1, Math.min(1, Math.abs(n.dot(toFace))))) * 180) / Math.PI).toFixed(1);
        r.prop.dist = +(ctr.distanceTo(eyes) / (0.3 * s)).toFixed(2);
      }
    }
    if (st?.id === 'skate' && c.skateDbg) r.skate = { ...c.skateDbg, deck: mm(c.skateDbg.deck * s), lean: +(c.skateDbg.lean * 57.3).toFixed(1) };
    r.phase2 = st ? `${st.id}:${st.phase}` : '';
    return r;
  };
  return true;
}

async function runCat(browser, cat) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log(`  [${cat}] pageerror`, e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(reactionClock, { persona: cat });
  await page.goto(`${URL0}?from=test&nocard=off&debug`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.__app?.director && window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 300000 });
  await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]'), { timeout: 120000 });
  await page.evaluate(() => window.__debugPanel?.open?.(false));
  await page.addStyleTag({ content: 'html.rxshot *{visibility:hidden!important} html.rxshot canvas{visibility:visible!important}' });
  await page.evaluate(() => window.__vt.manual());
  await page.evaluate(installProbe);
  await page.evaluate(propProbe);
  await page.evaluate(() => document.querySelector('[data-a="wake"]').click());
  await page.evaluate(() => (window.__rx.begin('boot'), window.__rx.run(8000)));
  await page.evaluate(async () => {
    for (let i = 0; i < 40 && !(['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy); i++) await window.__rx.run(window.__rx.t() + 500);
  });
  await page.evaluate(() => window.__rx.calibrate());
  const out = [];
  for (const act of ACTS[cat].filter((a) => !ONLY || ONLY.includes(a))) {
    await page.evaluate(async () => {
      const app = window.__app, d = app.director, rx = window.__rx;
      rx.begin('settle');
      d.queue.clear?.();
      for (let i = 0; i < 14; i++) {
        await rx.run(rx.t() + 250);
        if (!d.queue.busy && app.character.clips.idleMode && !app.stage.walking && !app.character.actState) break;
      }
      if (!app.character.clips.idleMode) app.character.play('idle');
      await rx.run(rx.t() + 1000);
    });
    const dur = act === 'skate' ? 8000 : act === 'bubbles' ? 4500 : 6500;
    await page.evaluate((id) => {
      window.__rx.begin(id);
      window.__rx.add({ op: 'action', at: 300, id });
    }, act);
    const shots = [];
    let best = null, useN = 0;
    for (let i = 1; i <= N; i++) {
      const t = Math.round(300 + ((dur - 300) * i) / (N + 1));
      await page.evaluate((t) => window.__rx.run(t, true), t);
      const info = await page.evaluate(() => {
        const rx = window.__rx, f = rx.frames[rx.frames.length - 1], c = window.__app.character;
        const st = c.actState;
        const hand = rx.screen(st?.id === 'mirror' ? 'LeftHand' : 'RightHand');
        const head = st?.id === 'skate' ? rx.screen('RightFoot') : rx.screen('Head');
        return { box: rx.catBox(), t: f?.t, clip: f?.clip, ph: f?.phase2, emo: f?.emo ?? f?.preset, hand, head, prop: f?.prop, use: /:(use|raise|ride)$/.test(f?.phase2 ?? '') };
      });
      await page.evaluate(() => document.documentElement.classList.add('rxshot'));
      const buf = await page.screenshot({ type: 'png' });
      await page.evaluate(() => document.documentElement.classList.remove('rxshot'));
      shots.push({ buf, ...info });
      // крупно — второй кадр фазы use (глоток, укус, взгляд в зеркальце; у скейта — проезд)
      if (/:(use|ride|ollie)$/.test(info.ph ?? '')) useN++;
      if (useN === 2 || (!best && info.use)) best = shots[shots.length - 1];
    }
    await page.evaluate((t) => window.__rx.run(t), dur);
    const data = await page.evaluate(() => window.__rx.end());
    const fr = data.frames.filter((f) => !f.mark);
    const P = fr.filter((f) => f.prop);
    const use = P.filter((f) => /:use$/.test(f.phase2));
    const mx = (a) => (a.length ? Math.max(...a) : null);
    const mn = (a) => (a.length ? Math.min(...a) : null);
    const sk = fr.filter((f) => f.skate);
    const sum = {
      cat,
      act,
      frames: P.length,
      gripMax: mx(P.map((f) => f.prop.grip)),
      gripMed: P.length ? [...P.map((f) => f.prop.grip)].sort((a, b) => a - b)[Math.floor(P.length / 2)] : null,
      mouthMin: mn(use.map((f) => f.prop.mouth)),
      upMax: mx(P.filter((f) => !/:use$/.test(f.phase2)).map((f) => f.prop.up)),
      faceMed: use.length && use[0].prop.face !== undefined ? [...use.map((f) => f.prop.face)].sort((a, b) => a - b)[Math.floor(use.length / 2)] : null,
      distMed: use.length && use[0].prop.dist !== undefined ? [...use.map((f) => f.prop.dist)].sort((a, b) => a - b)[Math.floor(use.length / 2)] : null,
      deckMax: sk.length ? mx(sk.filter((f) => f.skate.onDeck).map((f) => f.skate.deck ?? 0)) : null,
      wheelTurns: sk.length ? +(sk[sk.length - 1].skate.wheel ?? 0).toFixed(1) : null,
      leanMax: sk.length ? mx(sk.map((f) => Math.abs(f.skate.lean ?? 0))) : null,
      // проникновение лап в тело/одежду за действие, мм (BodyCollider.measurePairs) — самая глубокая пара
      penMax: mx(fr.filter((f) => f.phase2).map((f) => f.penMM ?? 0)),
      penPair: fr.filter((f) => f.phase2).reduce((b, f) => ((f.penMM ?? 0) > (b.v ?? 0) ? { v: f.penMM, p: f.penPair + '@' + f.phase2 } : b), {}).p ?? '',
      stretchMax: mx(P.map((f) => f.prop.stretch ?? 1)),
      clips: [...new Set(fr.map((f) => f.clip))],
      plays: data.plays.map((p) => `${(p.t / 1000).toFixed(2)} ${p.name}`),
    };
    log(cat, act, JSON.stringify(sum));
    out.push({ ...sum, frames: fr });
    await sheet(cat, act, shots, best ?? shots[Math.floor(N / 2)]);
  }
  await page.close();
  return out;
}

async function sheet(cat, id, shots, close) {
  const S = 160, H = 272, cols = 6, lab = 34;
  const esc = (x) => String(x ?? '').replace(/[<&>]/g, '');
  const tile = async (s) => {
    const b = s.box ?? { x0: 120, x1: 270, y0: 250, y1: 600 };
    // кости: от стоп до головы — сверху ещё уши и макушка (≈ 0,6 роста костей)
    const bh = Math.max(60, b.y1 - b.y0);
    const ch = Math.max(160, bh * 2.3), cw = (ch * S) / H;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 - bh * 0.6 + b.y1 + bh * 0.3) / 2;
    const L = Math.max(0, Math.min(390 - cw, cx - cw / 2)), T = Math.max(0, Math.min(844 - ch, cy - ch / 2));
    const ex = { left: Math.round(L * 2), top: Math.round(T * 2), width: Math.round(Math.min(cw, 390) * 2), height: Math.round(Math.min(ch, 844) * 2) };
    const img = await sharp(s.buf).extract(ex).resize(S, H, { fit: 'cover' }).toBuffer();
    const p = s.prop ? `хват ${s.prop.grip} · рот ${s.prop.mouth}${s.prop.face !== undefined ? ` · ∠${s.prop.face}°` : ''}` : '';
    const svg = Buffer.from(`<svg width="${S}" height="${lab}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="4" y="14" font-size="11" font-family="DejaVu Sans" fill="#fff">${(s.t / 1000).toFixed(2)} с · ${esc((s.ph || s.clip).replace(/^\w+:/, ''))}</text><text x="4" y="29" font-size="10" font-family="DejaVu Sans" fill="#9cf">${esc(p || s.emo)}</text></svg>`);
    return sharp({ create: { width: S, height: H + lab, channels: 3, background: '#111' } }).composite([{ input: img, top: 0, left: 0 }, { input: svg, top: H, left: 0 }]).png().toBuffer();
  };
  const tiles = await Promise.all(shots.map(tile));
  // крупный план кисти (кадр фазы use): 2 плитки шириной
  const CW = S * 2, CH = H + lab;
  let closeBuf = null;
  if (close?.hand) {
    const b = close.box;
    const bh = Math.max(60, b.y1 - b.y0);
    const hx = close.hand.x, hy = close.hand.y, fx = close.head?.x ?? hx, fy = (close.head?.y ?? hy) + bh * 0.15;
    const hh = Math.max(bh * 0.9, Math.abs(fy - hy) * 1.8);
    const cx = (hx + fx) / 2, cy = (hy + fy) / 2;
    const w = hh * (CW / CH);
    const L = Math.max(0, Math.min(390 - w, cx - w / 2)), T = Math.max(0, Math.min(844 - hh, cy - hh / 2));
    const img = await sharp(close.buf).extract({ left: Math.round(L * 2), top: Math.round(T * 2), width: Math.round(w * 2), height: Math.round(hh * 2) }).resize(CW, H, { fit: 'cover' }).toBuffer();
    const svg = Buffer.from(`<svg width="${CW}" height="${lab}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#222"/><text x="4" y="14" font-size="11" font-family="DejaVu Sans" fill="#fff">крупно: кисть и морда, ${(close.t / 1000).toFixed(2)} с · ${esc(close.ph)}</text><text x="4" y="29" font-size="10" font-family="DejaVu Sans" fill="#9cf">${esc(close.prop ? JSON.stringify(close.prop) : '')}</text></svg>`);
    closeBuf = await sharp({ create: { width: CW, height: CH, channels: 3, background: '#111' } }).composite([{ input: img, top: 0, left: 0 }, { input: svg, top: H, left: 0 }]).png().toBuffer();
  }
  const rows = Math.ceil((tiles.length + (closeBuf ? 2 : 0)) / cols);
  const comp = tiles.map((input, i) => ({ input, left: (i % cols) * S, top: Math.floor(i / cols) * (H + lab) }));
  if (closeBuf) {
    const i = tiles.length;
    comp.push({ input: closeBuf, left: (i % cols) * S, top: Math.floor(i / cols) * (H + lab) });
  }
  await sharp({ create: { width: cols * S, height: rows * (H + lab), channels: 3, background: '#000' } }).composite(comp).png({ palette: true, quality: 75, compressionLevel: 9 }).toFile(path.join(OUTD, `${cat}_${id}.png`));
}

async function main() {
  const srv = DIST ? serve() : null;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    protocolTimeout: 900000,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const all = [];
  try {
    for (const cat of CATS) all.push(...(await runCat(browser, cat)));
  } finally {
    await browser.close();
    srv?.close();
  }
  const f = path.join(root, 'bench-out/props', `${TAG}.json`);
  fs.writeFileSync(f, JSON.stringify(all));
  log('готово', path.relative(root, f), path.relative(root, OUTD));
}
main().catch((e) => (console.error(e), process.exit(1)));
