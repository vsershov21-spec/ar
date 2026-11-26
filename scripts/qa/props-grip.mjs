#!/usr/bin/env node
// Хват предметов (продакт 26.11: «предметы держат очень криво, они проникают в руки»): каждый предмет в лапах × кот —
// кадры крупно (кисть с предметом) и замеры по кадрам:
//   pen   — проникновение предмета в кота, мм на карте (GlbCharacter.propPen → character/propPen.ts: точки сетки кота
//           внутри предмета, глубина до его поверхности); по частям: палец / кисть / тело. Норма — ≤ 2 мм;
//   jit   — дрожь предмета в кисти: отклонение положения предмета в системе кости кисти от середины соседних кадров, мм
//           (≤ 0,5 — без дрожи); skate — относительно корня кота;
//   gap   — зазор: ближайшая точка предмета до ладони, мм (предмет «висит» рядом с лапой — > 6).
//
//   node scripts/qa/props-grip.mjs --url http://localhost:5199/   (VITE_EDITION=pilot npx vite --port 5199)
//   --cats hooligan,kind,glitter  --acts cocoa,attr:skate_show  --out /home/claude  --tag now
// Листы: <out>/props_grip_<кот>.jpg; замеры: bench-out/props/grip_<tag>.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { reactionClock } from './reactions-clock.js';
import { installProbe } from './reactions-probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TAG = arg('--tag', 'now');
const OUTD = path.resolve(arg('--out', '/home/claude'));
const URL0 = arg('--url', 'http://localhost:5199/');
const Q = arg('--q', '');
const CATS = arg('--cats', 'hooligan,kind,glitter').split(',');
/** предметы в лапах пилота по котам: фирменные, «Угостить» (рыбка), пузыри Добряка (палочка); attr: — предмет появления */
const ACTS = {
  hooligan: ['attr:skate_show', 'skate', 'treat'],
  kind: ['attr:cocoa', 'treat', 'bubbles'],
  glitter: ['attr:mirror', 'treat'],
};
const ONLY = arg('--acts', '') ? arg('--acts').split(',') : null;
const SHOTS = Number(arg('--shots', 6));
/** --appear: лист появления каждого кота (выбран листом в игре → вспышка → выход из карты → предмет) → <out>/attrs_<кот>.jpg */
const APPEAR = argv.includes('--appear');
const log = (...a) => console.log(`[grip ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUTD, { recursive: true });
fs.mkdirSync(path.join(root, 'bench-out/props'), { recursive: true });

/** замеры предмета за кадр (в странице) */
function gripProbe() {
  const app = window.__app, rx = window.__rx;
  const orig = rx.frame;
  let n = 0;
  rx.frame = () => {
    const r = orig();
    const c = app.character, po = c.props?.object, st = c.actState;
    r.grip = null;
    if (!po || !po.visible || !c.propPen) return r;
    const V = c.object.position.constructor;
    const s = c.object.getWorldScale(new V()).y || 1;
    const mm = rx.catMM ?? 94;
    const id = st?.id ?? c.clips?.cur?.id ?? '';
    const skate = /skate/.test(id) || c.props.holding === 'skateboard';
    const side = /mirror/.test(id) ? 'Left' : 'Right';
    const hand = c.bones.get(side + 'Hand');
    // дрожь: предмет в системе кисти (скейт — в системе кота), вторая разность по кадрам
    const ref = skate ? c.object : hand;
    const p = ref.worldToLocal(po.getWorldPosition(new V())).multiplyScalar(skate ? 1 : ref.getWorldScale(new V()).y / s);
    rx.__gq ??= [];
    const q = rx.__gq;
    q.push(p.clone());
    if (q.length > 4) q.shift();
    // дрожь — колебание, а не разгон: вторые разности двух соседних кадров направлены навстречу (знак меняется),
    // величина — меньшая из двух (одиночный рывок появления/ухода дрожью не считается)
    let jit = 0;
    if (q.length === 4) {
      const d1 = q[2].clone().sub(q[1].clone().add(q[3]).multiplyScalar(0.5));
      const d0 = q[1].clone().sub(q[0].clone().add(q[2]).multiplyScalar(0.5));
      if (d1.dot(d0) < 0) jit = Math.min(d1.length(), d0.length()) * mm;
    }
    const g = { push: +((c.gripDbg?.push ?? 0) * mm).toFixed(2), p: [p.x, p.y, p.z].map((v) => +(v * mm).toFixed(2)), jit: +jit.toFixed(2), scale: +(po.getWorldScale(new V()).y / s).toFixed(3), side, id, ph: st ? `${st.id}:${st.phase}` : '' };
    // проникновение — каждый 2-й кадр (дорого: скиннинг всех точек сетки и лучи по треугольникам предмета)
    if (n++ % 2 === 0 && g.scale > 0.05) {
      const pen = c.propPen(1);
      if (pen) {
        g.pen = +(pen.depth * mm).toFixed(2);
        g.part = pen.part;
        g.bone = pen.bone;
        g.n = pen.n;
        g.finger = +(pen.byPart.finger * mm).toFixed(2);
        g.handP = +(pen.byPart.hand * mm).toFixed(2);
        g.body = +(pen.byPart.body * mm).toFixed(2);
        g.mouth = +((pen.mouth ?? 0) * mm).toFixed(2);
      }
    }
    r.grip = g;
    return r;
  };
  return true;
}

async function runCat(browser, cat) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log(`  [${cat}] pageerror`, e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(reactionClock, { persona: cat });
  await page.goto(`${URL0}?from=test&nocard=off&debug${Q ? '&' + Q : ''}`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.__app?.director && window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 300000 });
  await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]'), { timeout: 120000 });
  await page.evaluate(() => window.__debugPanel?.open?.(false));
  await page.addStyleTag({ content: 'html.rxshot *{visibility:hidden!important} html.rxshot canvas{visibility:visible!important}' });
  await page.evaluate(() => window.__vt.manual());
  await page.evaluate(installProbe);
  await page.evaluate(gripProbe);
  await page.evaluate(() => document.querySelector('[data-a="wake"]').click());
  await page.evaluate(() => (window.__rx.begin('boot'), window.__rx.run(8000)));
  await page.evaluate(async () => {
    for (let i = 0; i < 40 && !(['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy); i++) await window.__rx.run(window.__rx.t() + 500);
  });
  await page.evaluate(() => (window.__rx.catMM = window.__rx.calibrate().catMM));
  const out = [];
  for (const act of ACTS[cat].filter((a) => !ONLY || ONLY.includes(a))) {
    await page.evaluate(async () => {
      const app = window.__app, d = app.director, rx = window.__rx;
      rx.begin('settle');
      d.queue.clear?.();
      for (let i = 0; i < 20; i++) {
        await rx.run(rx.t() + 250);
        if (!d.queue.busy && app.character.clips.idleMode && !app.stage.walking && !app.character.actState) break;
      }
      if (!app.character.clips.idleMode) app.character.play('idle');
      await rx.run(rx.t() + 1000);
    });
    const dur = /skate/.test(act) ? (act === 'skate' ? 8200 : 4600) : act === 'bubbles' ? 4500 : 6200;
    await page.evaluate((id) => {
      window.__rx.begin(id);
      if (id.startsWith('attr:')) window.__rx.add({ op: 'js', at: 300, label: id, code: `app.director.propAct('${id.slice(5)}')` });
      else window.__rx.add({ op: 'action', at: 300, id });
    }, act);
    // кадры крупно: равномерно по времени, пока предмет виден
    const shots = [];
    for (let i = 1; i <= SHOTS; i++) {
      const t = Math.round(300 + ((dur - 300) * (i - 0.3)) / SHOTS);
      await page.evaluate((t) => window.__rx.run(t, true), t);
      const info = await page.evaluate(() => {
        const rx = window.__rx, f = rx.frames[rx.frames.length - 1], c = window.__app.character;
        const g = f?.grip;
        const skate = /skate/.test(g?.id ?? '');
        const pts = skate ? [rx.screen('LeftFoot'), rx.screen('RightFoot')] : [rx.screen((g?.side ?? 'Right') + 'Hand'), rx.screen(`${g?.side ?? 'Right'}HandMiddle2`) ?? rx.screen((g?.side ?? 'Right') + 'Hand')];
        // центр предмета на экране
        const po = c.props?.object;
        let pp = null;
        if (po && po.visible) {
          const V = c.object.position.constructor;
          const w = po.getWorldPosition(new V());
          const cam = window.__app.stage.camera;
          const v = w.clone().project(cam);
          pp = { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
        }
        return { t: f?.t, ph: f?.grip?.ph || f?.clip, g, pts: pts.filter(Boolean), pp, box: rx.catBox() };
      });
      await page.evaluate(() => document.documentElement.classList.add('rxshot'));
      const buf = await page.screenshot({ type: 'png' });
      await page.evaluate(() => document.documentElement.classList.remove('rxshot'));
      shots.push({ buf, ...info });
    }
    await page.evaluate((t) => window.__rx.run(t), dur);
    const data = await page.evaluate(() => window.__rx.end());
    const fr = data.frames.filter((f) => !f.mark && f.grip);
    const P = fr.filter((f) => f.grip.pen !== undefined);
    // дрожь — у предмета в полный рост (появление из искры и уход — масштаб меняется, это не дрожь)
    const vis = fr.filter((f) => f.grip.scale > 0.95);
    const mx = (a) => (a.length ? +Math.max(...a).toFixed(2) : 0);
    const over = (k, lim) => (P.length ? +((100 * P.filter((f) => (f.grip[k] ?? 0) > lim).length) / P.length).toFixed(1) : 0);
    const worst = P.reduce((b, f) => (f.grip.pen > (b?.grip.pen ?? -1) ? f : b), null);
    const sum = {
      cat, act, frames: fr.length, sampled: P.length,
      pen: mx(P.map((f) => f.grip.pen)), penOver2: over('pen', 2),
      finger: mx(P.map((f) => f.grip.finger)), hand: mx(P.map((f) => f.grip.handP)), body: mx(P.map((f) => f.grip.body)),
      worst: worst ? `${worst.grip.part}:${worst.grip.bone}@${worst.grip.ph || worst.clip} ${(worst.t / 1000).toFixed(2)} с` : '',
      jit: mx(vis.slice(3).map((f) => f.grip.jit)),
      jitAt: (() => {
        const f = vis.slice(3).reduce((b, x) => (x.grip.jit > (b?.grip.jit ?? -1) ? x : b), null);
        return f ? `${f.grip.ph || f.clip} ${(f.t / 1000).toFixed(2)} с` : '';
      })(),
    };
    sum.ok = sum.pen <= 2 && sum.jit <= 0.5;
    log(cat, act, JSON.stringify(sum));
    out.push({ ...sum, shots: shots.map((s) => ({ t: s.t, ph: s.ph, g: s.g })), ...(process.env.GRIP_DUMP ? { frames: fr.map((f) => ({ t: f.t, ...f.grip })) } : {}) });
    sum.tiles = await tiles(shots, sum);
    out[out.length - 1].tiles = sum.tiles;
  }
  await page.close();
  return out;
}

const TW = 240, TH = 240, LAB = 30;
async function tiles(shots, sum) {
  const esc = (x) => String(x ?? '').replace(/[<&>]/g, '');
  return Promise.all(
    shots.map(async (s) => {
      const box = s.box ?? { x0: 120, x1: 270, y0: 250, y1: 600 };
      const bh = Math.max(60, box.y1 - box.y0);
      const pts = [...s.pts, ...(s.pp ? [s.pp] : [])];
      const cx = pts.length ? pts.reduce((a, p) => a + p.x, 0) / pts.length : (box.x0 + box.x1) / 2;
      const cy = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : (box.y0 + box.y1) / 2;
      const w = Math.max(70, bh * (/skate/.test(sum.act) ? 0.75 : 0.42));
      const L = Math.max(0, Math.min(390 - w, cx - w / 2)), T = Math.max(0, Math.min(844 - w, cy - w / 2));
      const img = await sharp(s.buf).extract({ left: Math.round(L * 2), top: Math.round(T * 2), width: Math.round(w * 2), height: Math.round(w * 2) }).resize(TW, TH).toBuffer();
      const g = s.g;
      const txt = g ? `пр ${g.pen ?? '·'} мм${g.pen > 0 ? ` (${g.part})` : ''} · дрожь ${g.jit}` : 'предмета нет';
      const svg = Buffer.from(`<svg width="${TW}" height="${LAB}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="4" y="12" font-size="11" font-family="DejaVu Sans" fill="#fff">${(s.t / 1000).toFixed(2)} с · ${esc(String(s.ph ?? '').replace(/^\\w+:/, ''))}</text><text x="4" y="26" font-size="10" font-family="DejaVu Sans" fill="${g?.pen > 2 ? '#f88' : '#9cf'}">${esc(txt)}</text></svg>`);
      return sharp({ create: { width: TW, height: TH + LAB, channels: 3, background: '#111' } }).composite([{ input: img, top: 0, left: 0 }, { input: svg, top: TH, left: 0 }]).png().toBuffer();
    }),
  );
}

async function catSheet(cat, rows) {
  const HEAD = 26, RH = TH + LAB;
  const cols = Math.max(...rows.map((r) => r.tiles.length));
  const comp = [];
  rows.forEach((r, i) => {
    const y = i * (RH + HEAD);
    const t = `${cat} · ${r.act}: проникновение ${r.pen} мм (палец ${r.finger}, кисть ${r.hand}, тело ${r.body}; > 2 мм — ${r.penOver2} % кадров) · дрожь ${r.jit} мм · ${r.ok ? 'OK' : 'НЕ ОК'}`;
    comp.push({ input: Buffer.from(`<svg width="${cols * TW}" height="${HEAD}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${r.ok ? '#143' : '#511'}"/><text x="6" y="17" font-size="13" font-family="DejaVu Sans" fill="#fff">${t.replace(/[<&>]/g, '')}</text></svg>`), left: 0, top: y });
    r.tiles.forEach((b, j) => comp.push({ input: b, left: j * TW, top: y + HEAD }));
  });
  const f = path.join(OUTD, `props_grip_${cat}.jpg`);
  await sharp({ create: { width: cols * TW, height: rows.length * (RH + HEAD), channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 82 }).toFile(f);
  return f;
}

/** появление кота cat: страница с другим котом, в игре — выбор cat (как карточкой листа), кадры во весь рост */
async function appearSheet(browser, cat) {
  const from = cat === 'hooligan' ? 'kind' : 'hooligan';
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log(`  [${cat}] pageerror`, e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(reactionClock, { persona: from });
  await page.goto(`${URL0}?from=test&nocard=off&debug&cooldown=0${Q ? '&' + Q : ''}`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.__app?.director && window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 300000 });
  await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]'), { timeout: 120000 });
  await page.evaluate(() => window.__debugPanel?.open?.(false));
  await page.addStyleTag({ content: 'html.rxshot *{visibility:hidden!important} html.rxshot canvas{visibility:visible!important}' });
  await page.evaluate(() => window.__vt.manual());
  await page.evaluate(installProbe);
  await page.evaluate(gripProbe);
  await page.evaluate(() => document.querySelector('[data-a="wake"]').click());
  await page.evaluate(() => (window.__rx.begin('boot'), window.__rx.run(8000)));
  await page.evaluate(async () => {
    for (let i = 0; i < 40 && !(['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy && !window.__app.character.actState); i++) await window.__rx.run(window.__rx.t() + 500);
  });
  await page.evaluate(() => (window.__rx.catMM = window.__rx.calibrate().catMM));
  await page.evaluate((c) => {
    window.__rx.begin('appear_' + c);
    window.__rx.add({ op: 'js', at: 200, label: 'choose', code: `app.director.dispatch({ type: 'choose', persona: '${c}' })` });
  }, cat);
  // модель нового кота грузится по сети (реальное время): ждём её, держа виртуальное время у вспышки
  await page.evaluate(() => window.__rx.run(400));
  for (let i = 0; i < 100 && !(await page.evaluate((c) => window.__app.charFor === c, cat)); i++) {
    await new Promise((r) => setTimeout(r, 150));
    await page.evaluate(() => window.__rx.run(window.__rx.t() + 50));
  }
  const t0 = await page.evaluate(() => window.__rx.t());
  const shots = [];
  const N = 12, dur = 6600;
  for (let i = 0; i < N; i++) {
    const t = Math.round(t0 + 100 + (dur * i) / (N - 1));
    await page.evaluate((t) => window.__rx.run(t, true), t);
    const info = await page.evaluate(() => {
      const rx = window.__rx, f = rx.frames[rx.frames.length - 1], c = window.__app.character, st = c.actState;
      return { t: f?.t, ph: st ? `${st.id}:${st.phase}` : f?.clip, box: rx.catBox(), pen: f?.grip?.pen ?? null, p: window.__app.director.persona.id };
    });
    await page.evaluate(() => document.documentElement.classList.add('rxshot'));
    shots.push({ buf: await page.screenshot({ type: 'png' }), ...info });
    await page.evaluate(() => document.documentElement.classList.remove('rxshot'));
  }
  const data = await page.evaluate(() => window.__rx.end());
  const fr = data.frames.filter((f) => !f.mark && f.grip?.pen !== undefined);
  const pen = fr.length ? Math.max(...fr.map((f) => f.grip.pen)) : 0;
  await page.close();
  const S = 200, H = 300, LAB = 30, cols = 6;
  const tiles = await Promise.all(
    shots.map(async (s) => {
      const b = s.box ?? { x0: 120, x1: 270, y0: 250, y1: 600 };
      const bh = Math.max(60, b.y1 - b.y0);
      const ch = Math.min(844, Math.max(200, bh * 2.4)), cw = (ch * S) / H;
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 - bh * 0.6 + b.y1 + bh * 0.35) / 2;
      const L = Math.max(0, Math.min(390 - cw, cx - cw / 2)), T = Math.max(0, Math.min(844 - ch, cy - ch / 2));
      const img = await sharp(s.buf).extract({ left: Math.round(L * 2), top: Math.round(T * 2), width: Math.round(Math.min(cw, 390) * 2), height: Math.round(ch * 2) }).resize(S, H, { fit: 'cover' }).toBuffer();
      const svg = Buffer.from(`<svg width="${S}" height="${LAB}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="4" y="12" font-size="11" font-family="DejaVu Sans" fill="#fff">${((s.t - t0) / 1000).toFixed(2)} с · ${s.p}</text><text x="4" y="26" font-size="10" font-family="DejaVu Sans" fill="#9cf">${String(s.ph ?? '').replace(/[<&>]/g, '')}${s.pen != null ? ' · пр ' + s.pen : ''}</text></svg>`);
      return sharp({ create: { width: S, height: H + LAB, channels: 3, background: '#111' } }).composite([{ input: img, top: 0, left: 0 }, { input: svg, top: H, left: 0 }]).png().toBuffer();
    }),
  );
  const HEAD = 26;
  const comp = [{ input: Buffer.from(`<svg width="${cols * S}" height="${HEAD}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#223"/><text x="6" y="17" font-size="13" font-family="DejaVu Sans" fill="#fff">появление ${cat} (выбран листом вместо ${from}): вспышка → выход из карты → предмет · проникновение предмета макс. ${pen} мм</text></svg>`), left: 0, top: 0 }];
  tiles.forEach((b, i) => comp.push({ input: b, left: (i % cols) * S, top: HEAD + Math.floor(i / cols) * (H + LAB) }));
  const f = path.join(OUTD, `attrs_${cat}.jpg`);
  await sharp({ create: { width: cols * S, height: HEAD + Math.ceil(tiles.length / cols) * (H + LAB), channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 82 }).toFile(f);
  log('лист появления', f, `проникновение ${pen} мм`);
  return { cat, pen };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    protocolTimeout: 900000,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const all = [];
  if (APPEAR) {
    try {
      for (const cat of CATS) await appearSheet(browser, cat);
    } finally {
      await browser.close();
    }
    return;
  }
  try {
    for (const cat of CATS) {
      const rows = await runCat(browser, cat);
      all.push(...rows);
      if (rows.length) log('лист', await catSheet(cat, rows));
    }
  } finally {
    await browser.close();
  }
  const f = path.join(root, 'bench-out/props', `grip_${TAG}.json`);
  fs.writeFileSync(f, JSON.stringify(all.map(({ tiles: _t, ...r }) => r), null, 1));
  console.log('\nпредмет × кот: проникновение (мм, норма ≤ 2) · дрожь (мм, ≤ 0,5)');
  for (const r of all) console.log(`  ${r.ok ? '✓' : '✗'} ${r.cat.padEnd(9)} ${r.act.padEnd(16)} пр ${String(r.pen).padStart(5)} (палец ${r.finger}, кисть ${r.hand}, тело ${r.body}; >2 мм ${r.penOver2} %) · дрожь ${r.jit} (${r.jitAt}) · ${r.worst}`);
  log('готово', path.relative(root, f));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
