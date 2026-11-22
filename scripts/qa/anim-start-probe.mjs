#!/usr/bin/env node
// Какие клипы играет кот в первые минуты (первая встреча: пробуждение, знакомство, касания) — основа стартового
// пакета движений (scripts/build/anim-pack.mjs START). Пилот /mvp из <dist>, кот на столе без камеры (?nocard=off),
// новая память (первая встреча). Каждый кадр — id текущего клипа и аддитивных слоёв, плюс имя клипа GLB за ним.
//   node scripts/qa/anim-start-probe.mjs <dist> [hooligan,kind,glitter] [--secs 70]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const DIST = path.resolve(argv[0] ?? 'dist');
const CATS = (argv[1] && !argv[1].startsWith('--') ? argv[1] : 'hooligan,kind,glitter').split(',');
const SECS = Number(argv.includes('--secs') ? argv[argv.indexOf('--secs') + 1] : 70);
const PUB = path.join(root, 'public');
const CACHE = process.env.AR_MODEL_CACHE || path.join(root, '.cache/model-opt');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
const file = (b, p) => { const f = path.join(b, p); return f.startsWith(b) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null; };
const optCached = (p) => {
  const m = /\/opt\/[^/]+\.([0-9a-f]{10})\.glb$/.exec(p);
  if (!m || !fs.existsSync(CACHE)) return null;
  const n = fs.readdirSync(CACHE).find((x) => x.startsWith(m[1]));
  return n ? path.join(CACHE, n) : null;
};
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/api/')) return void (res.writeHead(204), res.end());
  let f = file(DIST, p) || file(PUB, p) || optCached(p);
  if (!f && p.startsWith('/mvp') && (!path.extname(p) || p.endsWith('/'))) f = file(DIST, '/mvp/index.html');
  if (!f) return void (res.writeHead(404), res.end());
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 240000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU', '--mute-audio'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const all = {};
for (const cat of CATS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    const seen = (window.__clipsSeen = {});
    const t0 = performance.now();
    const tick = () => {
      const ch = window.__app?.character;
      const cs = ch?.clips;
      if (cs) {
        const ids = [cs.cur?.id, ...(cs.additive ?? []).map((a) => a.id)].filter(Boolean);
        for (const id of ids) {
          if (seen[id]) continue;
          const a = ch.actions?.get?.(id);
          seen[id] = { t: +((performance.now() - t0) / 1000).toFixed(1), glb: a ? a.getClip().name : null, src: ch.clipSource?.(id) ?? null };
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`${base}/mvp/?from=test&nocard=off&cat=${cat}&progress=0&mic=ptt&noanalytics&meshy=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__app?.director, { timeout: 120000 });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  const t0 = Date.now();
  // касания по зонам кота (голова, щека, живот, лапа, хвост), глажка — как ребёнок в первые минуты
  const zones = ['Head', 'Spine', 'RightHand', 'Tail3', 'Head', 'Spine2'];
  let z = 0;
  while (Date.now() - t0 < SECS * 1000) {
    await wait(5000);
    const ph = await page.evaluate(() => window.__app.director.state.phase).catch(() => '');
    if (ph !== 'play' && ph !== 'free') continue;
    const bone = zones[z++ % zones.length];
    const pt = await page.evaluate((b) => {
      const ch = window.__app.character; const o = ch?.bones?.get(b) ?? ch?.model?.getObjectByName('mixamorig' + b) ?? ch?.model?.getObjectByName(b);
      if (!o) return null;
      const v = o.getWorldPosition(new o.position.constructor()); const cam = window.__app.tracker.camera; v.project(cam);
      const r = window.__app.root.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    }, bone).catch(() => null);
    if (pt) await page.touchscreen.tap(pt.x, pt.y);
  }
  all[cat] = await page.evaluate(() => window.__clipsSeen);
  // догрузка остальных движений после посадки (GlbCharacter.loadDeferred): пришла ли, сколько клипов зарегистрировано
  const st = await page.evaluate(() => ({ pending: !!window.__app.character.deferredPending, actions: window.__app.character.actions.size }));
  console.log(`${cat}: остальные движения ${st.pending ? 'ещё грузятся' : 'догружены'}, id клипов: ${st.actions}`);
  console.log(cat, JSON.stringify(all[cat]));
  await page.close();
}
fs.mkdirSync(path.join(root, 'bench-out'), { recursive: true });
fs.writeFileSync(path.join(root, 'bench-out/anim-start-probe.json'), JSON.stringify(all, null, 1));
await browser.close();
srv.close();
