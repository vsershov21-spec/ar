#!/usr/bin/env node
// Стенд кровати (дом → спальня → «Уложить спать» → сон → «Разбудить»): пилотная сборка, все три кота, клипы Meshy
// из локальной папки. Кадры — вид камеры пилота и сверху (свет поднят, чтобы видеть позу), метрики — в системе МАТРАСА
// (не кота): ось тела к длинной оси кровати, наклон спины, голова на подушке, тело на матрасе (проникновение / зазор по
// вершинам кожи), свисает ли с матраса, накрыто ли одеялом и не торчит ли сквозь него.
//
//   VITE_EDITION=pilot npx vite build --outDir /tmp/bedstand/dist      — сборка (или --build)
//   node scripts/qa/bed-stand.mjs --dist /tmp/bedstand/dist --meshy DIR --tag after [--cats kind] [--morning] [--hour 23] [--bed-glb FILE]
//
// DIR — папка с клипами Meshy (*.glb): ветка server-out, out/latest/meshy (git archive origin/server-out out/latest/meshy).
// Выход: docs/qa/bed/<tag>_<кот>.png (лист: верх — камера пилота, низ — сверху; подписи — метрики кадра),
//        docs/qa/bed/<tag>.json (метрики по кадрам), сводка в консоль.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { reactionClock } from './reactions-clock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const DIST = path.resolve(arg('--dist', path.join(root, 'bench-out/bed/dist')));
const MESHY = arg('--meshy', '') ? path.resolve(arg('--meshy')) : '';
const TAG = arg('--tag', 'now');
const CATS = arg('--cats', 'hooligan,kind,glitter').split(',');
const OUT = path.join(root, 'docs/qa/bed');
const PORT = Number(arg('--port', 4197));
const PARAMS = arg('--params', '');
// --bed-glb FILE: отдавать FILE как /models/props/bed.glb (GLB-кровать прода: ветка server-out, out/latest/props/bed.glb);
// без флага — 404, сцена строит процедурную кровать. --hour N — час суток сцены (ночь у продакта ≈ 23), по умолчанию 14.
const BED_GLB = arg('--bed-glb', '') ? path.resolve(arg('--bed-glb')) : '';
const HOUR = Number(arg('--hour', 14));
// --quick: только ключевые кадры (лёг, укрыт, спит 5 с, на месте) — для перегруженной машины
const QUICK = flag('--quick');
const QUICK_SHOTS = ['лёг', 'укрыт', 'спит 5 с', 'на месте'];
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const log = (...a) => console.log(`[bed ${new Date().toISOString().slice(11, 19)}]`, ...a);
fs.mkdirSync(OUT, { recursive: true });

if (flag('--build')) {
  const r = spawnSync('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_EDITION: 'pilot' } });
  if (r.status) throw new Error('vite build упал');
}

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ktx2': 'image/ktx2', '.mp4': 'video/mp4' };
const server = http
  .createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const mm = MESHY && p.match(/^\/models\/anims\/meshy\/([\w.-]+)$/);
    const bg = BED_GLB && /^\/models\/props\/bed\.glb$/.test(p);
    const f = bg ? BED_GLB : mm ? path.join(MESHY, mm[1]) : path.join(DIST, path.normalize(p));
    if (bg) {
      r.setHeader('content-type', TYPES['.glb']);
      return fs.createReadStream(f).pipe(r);
    }
    if ((!mm && !f.startsWith(DIST)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      r.statusCode = 404;
      return r.end();
    }
    r.setHeader('content-type', TYPES[path.extname(f)] ?? 'application/octet-stream');
    fs.createReadStream(f).pipe(r);
  })
  .listen(PORT);

/** матрас: BedProp.mattress, в сборках до него — из точки сна (процедурная кровать: spot = центр + (0,1; 0; 0,04)) */
const BED_GEOM = `(bed) => bed.mattress ?? { x0: bed.spot.x - 0.1, z0: bed.spot.z - 0.04, top: 0.428, length: 1.32, width: 0.95,
  pillow: { x: bed.spot.x - 0.1 + 0.41, z: bed.spot.z - 0.04, top: 0.57, length: 0.36, width: 0.646 } }`;

/** замер в странице: всё в координатах комнаты (кровать — BedProp.mattress) */
function probe() {
  const app = window.__app;
  const THREE = { Vector3: app.scene.position.constructor, Matrix4: app.scene.matrixWorld.constructor };
  const room = app.home.room, bed = room.bed;
  const M = bedGeom(bed);
  app.scene.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(room.group.matrixWorld).invert();
  const ch = app.character;
  const bw = (n) => {
    const v = new THREE.Vector3();
    return ch.boneWorld(n, v) ? v.applyMatrix4(inv) : null;
  };
  const hips = bw('Hips'), neck = bw('Neck'), head = bw('Head'), la = bw('LeftArm'), ra = bw('RightArm');
  if (!hips || !neck || !head) return null;
  const r2d = 180 / Math.PI;
  const dx = neck.x - hips.x, dz = neck.z - hips.z, dy = neck.y - hips.y;
  const axisYaw = Math.atan2(-dz, dx) * r2d;
  const pitch = Math.atan2(dy, Math.hypot(dx, dz)) * r2d;
  // крен: плечевая ось от вертикали (на боку ≈ 0°, на спине/животе ≈ 90°)
  const sh = la && ra ? new THREE.Vector3().subVectors(la, ra).normalize() : null;
  const roll = sh ? Math.acos(Math.min(1, Math.abs(sh.y))) * r2d : null;
  // вершины кожи (каждая k-я): голова — по доминирующей кости
  const tv = new THREE.Vector3();
  const body = [], headV = [], skirt = [], trunk = [];
  ch.object.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible || /shell|fur/i.test(o.name) || /shell|fur/i.test(o.material?.name ?? '')) return;
    const pos = o.geometry.getAttribute('position'), si = o.geometry.getAttribute('skinIndex'), sw = o.geometry.getAttribute('skinWeight');
    const bones = o.skeleton.bones;
    const step = Math.max(1, Math.floor(pos.count / 700));
    const isSkirt = /skirt|tutu|юбк/i.test(o.name) || /skirt|tutu/i.test(o.material?.name ?? '');
    for (let i = 0; i < pos.count; i += step) {
      o.getVertexPosition(i, tv);
      const w = tv.clone().applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      let best = 0, bi = 0;
      for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > best) (best = sw.getComponent(i, k)), (bi = si.getComponent(i, k));
      let hd = false, arm = false;
      for (let x = bones[bi]; x; x = x.parent) {
        if (/Head$/.test(x.name)) hd = true;
        if (/(Left|Right)Shoulder$/.test(x.name)) arm = true;
      }
      if (hd) headV.push(w);
      else body.push(w);
      if (!hd && !arm) trunk.push(w);
      if (isSkirt) skirt.push(w);
    }
  });
  const inX = (v) => v.x > M.x0 - M.length / 2 && v.x < M.x0 + M.length / 2, inZ = (v) => v.z > M.z0 - M.width / 2 && v.z < M.z0 + M.width / 2;
  const onM = body.filter((v) => inX(v) && inZ(v));
  const minY = Math.min(...body.map((v) => v.y));
  const below = onM.filter((v) => v.y < M.top - 0.01).length;
  const off = body.filter((v) => !(inX(v) && inZ(v))).length;
  const P = M.pillow;
  const headC = headV.length ? headV.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / headV.length) : head;
  const headMinY = Math.min(...headV.map((v) => v.y));
  const onPillow = Math.abs(headC.x - P.x) < P.length / 2 + 0.04 && Math.abs(headC.z - P.z) < P.width / 2 + 0.04;
  // одеяло: вершины ткани над вершинами туловища и ног (лапы — поверх одеяла по замыслу; ближайшая вершина ткани по xz
  // в 4 см, допуск 1 см) — накрыто / тело сквозь ткань
  const bl = bed.group.getObjectByName('bed-blanket');
  let covered = 0, poke = 0, cand = 0;
  if (bl && bl.visible && bed.cover > 0.5) {
    bl.updateMatrixWorld(true);
    const bp = bl.geometry.getAttribute('position'), B = [];
    for (let i = 0; i < bp.count; i++) B.push(new THREE.Vector3().fromBufferAttribute(bp, i).applyMatrix4(bl.matrixWorld).applyMatrix4(inv));
    for (let i = 0; i < trunk.length; i += 2) {
      const v = trunk[i];
      if (!(inX(v) && inZ(v))) continue;
      let best = null, bd = 0.04 * 0.04;
      for (const b of B) {
        const d = (b.x - v.x) ** 2 + (b.z - v.z) ** 2;
        if (d < bd) (bd = d), (best = b);
      }
      cand++;
      if (!best) continue;
      if (best.y >= v.y - 0.01) covered++;
      else poke++;
    }
  }
  const mm = (x) => Math.round(x * 1000);
  return {
    state: app.home.bed?.state, step: app.home.bed?.m?.step?.id ?? null, clip: ch.currentClip ?? null,
    axisYaw: +axisYaw.toFixed(1), pitch: +pitch.toFixed(1), roll: roll === null ? null : +roll.toFixed(0),
    lowMM: mm(minY - M.top), belowPct: onM.length ? Math.round((below / onM.length) * 100) : 0, offPct: Math.round((off / body.length) * 100),
    headDX: mm(headC.x - P.x), headDZ: mm(headC.z - P.z), headOverPillow: mm(head.y - P.top), onPillow,
    box: (() => { const cam = app.home.camera, pts = []; for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 1.1]) { const v = new THREE.Vector3(M.x0 + sx * (M.length / 2 + 0.15), y, M.z0 + sz * M.width / 2).applyMatrix4(room.group.matrixWorld).project(cam); pts.push(v); } const xs = pts.map((v) => (v.x + 1) * 195), ys = pts.map((v) => (1 - v.y) * 422); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; })(),
    hipsDZ: mm((hips.z + neck.z) / 2 - M.z0),
    cover: cand ? Math.round((covered / cand) * 100) : null, poke: cand ? Math.round((poke / cand) * 100) : null,
    skirtLow: skirt.length ? mm(Math.min(...skirt.map((v) => v.y)) - M.top) : null,
    n: body.length, al: app.home.bed?.alDbg ? { ...app.home.bed.alDbg } : null,
  };
}

/** вид сверху: своя камера над кроватью, свет на время кадра — полный */
function renderTop() {
  const app = window.__app, room = app.home.room, M = bedGeom(room.bed);
  const cam = app.home.camera.clone();
  cam.fov = 32;
  cam.zoom = 1;
  cam.aspect = 390 / 844;
  cam.clearViewOffset();
  cam.updateProjectionMatrix();
  const c = new app.scene.position.constructor(M.x0, M.top, M.z0).applyMatrix4(room.group.matrixWorld);
  const sc = room.group.matrixWorld.getMaxScaleOnAxis();
  cam.position.set(c.x, c.y + 3.8 * sc, c.z + 0.001);
  cam.up.set(1, 0, 0); // изголовье (+X) — вверх кадра
  cam.lookAt(c);
  const ex = app.renderer.toneMappingExposure;
  app.renderer.toneMappingExposure = ex * 3;
  app.renderer.render(app.scene, cam);
  app.renderer.toneMappingExposure = ex;
}

const PLAN = [
  // [мс от «Уложить спать», подпись]
  [600, 'подходит'], [1700, 'залезает'], [2300, 'на матрасе'], [2700, 'ложится'], [3100, 'ложится'], [3500, 'лёг'],
  [3900, 'укрывается'], [4400, 'укрыт'], [6000, 'спит'], [9000, 'спит 5 с'],
];
const WAKE = [[150, 'одеяло'], [700, 'тянется'], [1500, 'садится'], [2200, 'спрыгивает'], [3200, 'отходит'], [4400, 'на месте']];

async function runCat(browser, cat, morning) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: Number(arg('--dpr', 1)), isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log(`  [${cat}] pageerror`, e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(reactionClock, { persona: cat });
  const q = `from=test&nocard=off&debug&flow=home&zone=bedroom&hour=${HOUR}${morning ? '&bed=morning' : ''}${PARAMS ? '&' + PARAMS : ''}`;
  await page.goto(`http://localhost:${PORT}/?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__app?.director && window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 120000 });
  await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]'), { timeout: 60000 });
  await page.evaluate(() => window.__debugPanel?.open?.(false));
  await page.evaluate(() => document.querySelector('[data-a="wake"]').click());
  await page.waitForFunction(() => window.__app.home?.phase === 'home' && window.__app.home.zone === 'bedroom' && !window.__app.home.moving && window.__app.home.room?.bed, { timeout: 120000, polling: 500 });
  if (MESHY) {
    let prev = -1, still = 0;
    for (let i = 0; i < 120 && still < 4; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const n = await page.evaluate(() => window.__meshyStatus?.size ?? 0);
      still = n > 0 && n === prev ? still + 1 : 0;
      prev = n;
    }
    const ms = await page.evaluate(() => [...(window.__meshyStatus?.values() ?? [])].filter((m) => /bed|lie_|sleep|turn_over|wake_stretch/.test(m.id)).map((m) => `${m.id}:${m.state}`));
    log(`  [${cat}] Meshy кровать: ${ms.join(', ')}`);
  }
  await page.evaluate(() => window.__vt.manual());
  await page.evaluate(`window.bedGeom = ${BED_GEOM}`);
  await page.evaluate(() => window.__vt.step(45));
  await page.addStyleTag({ content: 'html.bedshot *{visibility:hidden!important} html.bedshot canvas{visibility:visible!important}' });
  const shots = [];
  const shoot = async (label) => {
    const m = await page.evaluate(probe);
    await page.evaluate(() => document.documentElement.classList.add('bedshot'));
    // кадр камеры пилота (последний отрисованный) и вид сверху
    await page.evaluate(() => window.__vt.step(1));
    const cam = await page.screenshot({ type: 'png' });
    await page.evaluate(renderTop);
    const top = await page.screenshot({ type: 'png' });
    await page.evaluate(() => document.documentElement.classList.remove('bedshot'));
    shots.push({ label, m, cam, top });
    // --raw DIR: кадр камеры пилота целиком (крупно посмотреть ткань)
    if (arg('--raw', '')) {
      fs.mkdirSync(arg('--raw'), { recursive: true });
      fs.writeFileSync(path.join(arg('--raw'), `${TAG}_${cat}_${shots.length}_${label.replace(/\s+/g, '_')}.png`), cam);
    }
  };
  let t = 0;
  const until = async (ms) => {
    const n = Math.max(0, Math.round((ms - t) / (1000 / 30)));
    if (n) await page.evaluate((n) => window.__vt.step(n), n);
    t = ms;
  };
  if (!morning) {
    await page.evaluate(() => window.__app.home.act('home:sleep'));
    for (const [ms, label] of PLAN) {
      if (QUICK && !QUICK_SHOTS.includes(label)) continue;
      await until(ms);
      await shoot(label);
    }
    // ворочается: два тапа во сне (turn_over_sleep)
    if (!QUICK) {
    await page.evaluate(() => window.__app.home.onTouch('tap_body'));
    await until(9300);
    await page.evaluate(() => window.__app.home.onTouch('tap_body'));
    await until(10000);
    await shoot('ворочается');
    await until(11500);
    await shoot('после');
    }
  } else {
    await until(1500);
    await shoot('утро: спит');
  }
  // сон 3 тапа нет — будим чипом
  await page.evaluate(() => window.__app.home.act('home:wake'));
  t = 0;
  for (const [ms, label] of WAKE) {
    if (QUICK && !QUICK_SHOTS.includes(label)) continue;
    await until(ms);
    await shoot(label);
  }
  await page.close();
  return shots;
}

async function sheet(cat, shots) {
  const W = 250, HC = 175, HT = 346, lab = 74, COLS = 8;
  // камера пилота: кадр вокруг кровати (проекция углов матраса и высоты кота, +10 %), вид сверху — центр экрана
  const crop = (buf, top, b) => {
    if (top) return sharp(buf).extract({ left: 0, top: 150, width: 390, height: 540 }).resize(W, HT).toBuffer();
    const [x0, y0, x1, y1] = b ?? [0, 300, 390, 560];
    const w = Math.min(390, (x1 - x0) * 1.1), h = Math.min(844, w * (HC / W));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const ex = { left: Math.round(Math.max(0, Math.min(390 - w, cx - w / 2))), top: Math.round(Math.max(0, Math.min(844 - h, cy - h / 2))), width: Math.round(w), height: Math.round(h) };
    return sharp(buf).extract(ex).resize(W, HC).toBuffer();
  };
  const esc = (x) => String(x ?? '').replace(/[<&>]/g, '');
  const tiles = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i], m = s.m ?? {};
    const a = await crop(s.cam, false, m.box), b = await crop(s.top, true);
    const l1 = `${s.label} · ${m.step ?? m.state ?? ''} · ${m.clip ?? ''}`;
    const l2 = `ось ${m.axisYaw}° спина ${m.pitch}° крен ${m.roll}°`;
    const l3 = `низ ${m.lowMM} мм, в матр. ${m.belowPct}% свис ${m.offPct}%`;
    const l4 = `голова Δx${m.headDX} Δz${m.headDZ} над под. ${m.headOverPillow} ${m.onPillow ? '✓' : '✗'}`;
    const l5 = `одеяло ${m.cover ?? '—'}% сквозь ${m.poke ?? '—'}%${m.skirtLow !== null && m.skirtLow !== undefined ? ` юбка ${m.skirtLow}` : ''}`;
    const svg = Buffer.from(`<svg width="${W}" height="${lab}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/>${[l1, l2, l3, l4, l5].map((l, k) => `<text x="3" y="${13 + k * 14}" font-size="${k ? 9.5 : 11}" font-family="DejaVu Sans" fill="${k ? '#9cf' : '#fff'}">${esc(l)}</text>`).join('')}</svg>`);
    const R = HC + HT + lab, col = i % COLS, row0 = Math.floor(i / COLS) * R;
    tiles.push({ input: a, left: col * W, top: row0 }, { input: b, left: col * W, top: row0 + HC }, { input: svg, left: col * W, top: row0 + HC + HT });
  }
  const file = path.join(OUT, `${TAG}_${cat}.png`);
  await sharp({ create: { width: W * Math.min(COLS, shots.length), height: (HC + HT + lab) * Math.ceil(shots.length / COLS), channels: 3, background: '#111' } }).composite(tiles).png({ palette: true, quality: 85, effort: 8 }).toFile(file);
  return file;
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 30 * 60000, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const all = {};
try {
  for (const cat of CATS) {
    const shots = await runCat(browser, cat, flag('--morning'));
    all[cat] = shots.map((s) => ({ label: s.label, ...s.m }));
    const f = await sheet(cat, shots);
    log(`[${cat}] лист ${path.relative(root, f)}`);
    for (const s of shots) log(`  ${s.label.padEnd(12)} ${JSON.stringify(s.m)}`);
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(all, null, 1));
