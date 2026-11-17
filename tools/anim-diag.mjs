// Диагностика движений 3D-кота в браузере (headless): проигрывает все клипы тела каталога по очереди и меряет
//  - pop: пиковая угловая скорость костей тела в первые 0,35 с после смены клипа (рад/с) — «щелчок» позы;
//  - bind: доля костей, стоящих в bind-позе (клип не привязался к скелету);
//  - footMin/footMax: высота самой низкой ступни над картой (доли роста) за клип — провал/парение;
//  - spin: пиковая угловая скорость поворота кота на карте (рад/с).
// Плюс таблица подготовки клипов (animPrep). Запуск:
//   npx vite --port 4191 --strictPort &   node tools/anim-diag.mjs <tag> [persona] [query]
// query: напр. '&anim=raw' — как было. Итог: docs/look/anim_<tag>.json и кадры docs/look/anim_<tag>_<clip>.png (ANIM_SHOTS=1).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] || 'now';
const persona = process.argv[3] || 'hooligan';
const extra = process.argv[4] || '';
const port = Number(process.env.LOOK_PORT ?? 4191);
const holdMs = Number(process.env.ANIM_HOLD ?? 1600);
const only = process.env.ANIM_ONLY ? process.env.ANIM_ONLY.split(',') : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.warn('  pageerror', e.message));
await page.goto(`http://localhost:${port}/?debug${extra}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__app?.director && window.__debugPanel && window.__cat, { timeout: 60000 });
await page.evaluate(() => window.__debugPanel.open?.(false));
await page.evaluate(() => (document.querySelector('[data-a="wake"]') ?? [...document.querySelectorAll('button')].find((b) => /Разбудить/.test(b.textContent)))?.click());
await wait(800);
await page.evaluate(() => window.__debugPanel.fastForward());
await page.waitForFunction(() => window.__app.director.state.phase === 'play', { timeout: 30000 }).catch(() => {});
await page.evaluate((id) => window.__cat.persona(id), persona);
await page.waitForFunction(() => window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 90000 });
await wait(2500);

// время ведём сами: цикл приложения не трогает кота, шаги по 1/60 с (headless рендерит ~5 к/с)
await page.evaluate(() => {
  const app = window.__app;
  const d = app.director;
  d.queue?.clear?.();
  d.paused = true;
  document.querySelectorAll('.dbg, .debug-panel, #debug').forEach((e) => (e.style.display = 'none'));
  const c = app.character;
  const bones = [];
  c.object.traverse((o) => o.isBone && /(Hips|Spine\d?|Neck|Head|Shoulder|Arm|ForeArm|Hand|UpLeg|Leg|Foot)$/.test(o.name) && bones.push(o));
  const feet = bones.filter((b) => /(Left|Right)Foot$/.test(b.name));
  const V = c.object.position.constructor;
  const Q = c.object.quaternion.constructor;
  let skel = null;
  c.object.traverse((o) => o.isSkinnedMesh && !skel && (skel = o.skeleton));
  const cur = bones.map((b) => [b.quaternion.clone(), b.position.clone()]);
  skel?.pose();
  const bind = bones.map((b) => b.quaternion.clone());
  c.object.updateMatrixWorld(true);
  const footRest = Math.min(...feet.map((f) => c.object.worldToLocal(f.getWorldPosition(new V())).y));
  bones.forEach((b, i) => (b.quaternion.copy(cur[i][0]), b.position.copy(cur[i][1])));
  const prev = bones.map(() => new Q());
  let have = false;
  const p = new V();
  const orig = c.update.bind(c);
  c.update = () => {}; // цикл приложения больше не двигает кота
  const cam = app.tracker?.camera ?? app.camera;
  window.__step = (n, dt = 1 / 60) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      orig(dt, cam);
      c.object.updateMatrixWorld(true);
      let w = 0, nb = 0, wb = '';
      bones.forEach((b, i) => {
        const a = have ? b.quaternion.angleTo(prev[i]) / dt : 0;
        if (a > w) [w, wb] = [a, b.name];
        if (b.quaternion.angleTo(bind[i]) < 0.003) nb++;
        prev[i].copy(b.quaternion);
      });
      have = true;
      let fy = Infinity;
      for (const f of feet) fy = Math.min(fy, c.object.worldToLocal(f.getWorldPosition(p)).y - footRest);
      out.push({ w, wb, bind: nb / bones.length, fy, clip: c.clips.cur.id, at: c.anim?.t, idle: c.clips.idleMode, hits: c.collider?.hits });
    }
    return out;
  };
  window.__render = () => app.renderer.render(app.scene, cam);
});

const clips = await page.evaluate(() => [...window.__app.character.actions.keys()]);
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'content/animations.json'), 'utf8')).clips.filter((c) => c.layer === 'body' && clips.includes(c.id)).map((c) => c.id);
const list = only ?? catalog;
const res = [];
const shots = process.env.ANIM_SHOTS === '1';
fs.mkdirSync(path.join(root, 'docs/look'), { recursive: true });
// каждый клип стартует из покоя (idle 1 с) — как в жизни: реакция из покоя и возврат
for (const id of list) {
  await page.evaluate(() => (window.__app.character.play('idle'), window.__step(60)));
  const fr = await page.evaluate((id) => (window.__app.character.play(id), window.__step(Math.round(60 * 2.2))), id);
  if (shots) {
    await page.evaluate(() => window.__render());
    await page.screenshot({ path: path.join(root, `docs/look/anim_${tag}_${id}.png`) });
  }
  const early = fr.slice(0, 21);
  const r = {
    id,
    pop: +Math.max(...early.map((f) => f.w)).toFixed(1),
    popBone: early.reduce((a, f) => (f.w > a.w ? f : a), { w: 0 }).wb?.replace('mixamorig', ''),
    wMax: +Math.max(...fr.map((f) => f.w)).toFixed(1),
    bind: +Math.max(...fr.slice(20).map((f) => f.bind)).toFixed(2),
    footMin: +Math.min(...fr.map((f) => f.fy)).toFixed(3),
    footMax: +Math.max(...fr.map((f) => f.fy)).toFixed(3),
  };
  if (process.env.ANIM_FRAMES) r.frames = fr.slice(0, 40).map((f) => `${f.w.toFixed(1)}:${f.wb.replace('mixamorig', '')}:${f.clip}:${f.at?.toFixed(2)}:${f.hits}`);
  res.push(r);
  console.log(JSON.stringify(r));
}
// возврат в покой и поворот к зрителю: камера облетает кота (debug-трекер) — пиковая скорость поворота
const info = await page.evaluate(() => {
  const c = window.__app.character;
  const out = [];
  c.animInfo?.forEach?.((i) => out.push(i));
  return { prep: out, log: c.anim?.log ?? [] };
});
fs.writeFileSync(path.join(root, `docs/look/anim_${tag}.json`), JSON.stringify({ persona, extra, clips: res, ...info }, null, 1));
const bad = res.filter((r) => r.bind > 0.5 || r.footMin < -0.03 || r.footMin > 0.05);
console.log(`клипов ${res.length}; pop медиана ${median(res.map((r) => r.pop))}, макс ${Math.max(...res.map((r) => r.pop))}; bind-поза: ${res.filter((r) => r.bind > 0.5).map((r) => r.id).join(', ') || '—'}`);
console.log('проблемные по высоте/bind:', bad.map((r) => `${r.id}(${r.footMin}..${r.footMax}, bind ${r.bind})`).join('; ') || '—');
await browser.close();
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
