#!/usr/bin/env node
// E2E пилота /mvp (docs/qa/E2E.md): `npm run e2e:pilot`
//   сборка pilot (AR_EDITIONS=pilot scripts/build/editions.mjs → dist/mvp) + fake-voice (тишина вместо mp3, строгий
//   режим «только озвученные реплики» как на сайте) → свой http-сервер с моком /api/progress → headless Chrome как iPhone
//   (390×844), фейковая камера с синтетической картой → сценарии scripts/qa/e2e/tests.mjs по очереди.
// Провал сценария — снимок bench-out/e2e/<сценарий>.png и строка в bench-out/e2e/report.json.
//
//   npm run e2e:pilot                       — сборка + все сценарии (~15–25 мин)
//   npm run e2e:pilot -- --no-build         — без сборки (dist/mvp уже есть)
//   npm run e2e:pilot -- --only 01,03       — только сценарии с такими префиксами / подстроками имени
//   npm run e2e:pilot -- --headful          — с окном
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, launch, allowed } from './lib.mjs';
import { TESTS } from './tests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT = path.join(root, 'bench-out/e2e');
const DIST = path.join(root, 'dist');
const MEDIA = path.join(root, 'bench-out/qa/media');
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── медиа: синтетическая карта на столе (как QA-стенд), тишина комнаты для микрофона ──
if (!fs.existsSync(path.join(MEDIA, 'still.y4m'))) {
  log('медиа: видео карты (scripts/bench/gen_card_video.py)');
  fs.mkdirSync(MEDIA, { recursive: true });
  const r = spawnSync('python3', [path.join(root, 'scripts/bench/gen_card_video.py'), MEDIA], { stdio: 'inherit' });
  if (r.status) throw new Error('gen_card_video.py упал');
  fs.rmSync(path.join(MEDIA, 'move.y4m'), { force: true });
}
const room = path.join(MEDIA, 'room.wav');
if (!fs.existsSync(room)) {
  const sr = 48000, n = sr * 10, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let s = 1;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    b.writeInt16LE(Math.round(((s / 2147483647) * 2 - 1) * 33), 44 + i * 2);
  }
  fs.writeFileSync(room, b);
}

// ── сборка ──
if (!flag('--no-build')) {
  log('сборка: pilot → dist/mvp');
  const r = spawnSync('node', [path.join(root, 'scripts/build/editions.mjs')], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, AR_EDITIONS: 'pilot' } });
  if (r.status) throw new Error('сборка pilot упала');
}
if (!fs.existsSync(path.join(DIST, 'mvp/index.html'))) throw new Error('нет dist/mvp/index.html — запусти без --no-build');
// озвучка: тишина длиной как реплика (scripts/scenario/fake-voice.mjs) — dist/voice/el
const fv = spawnSync('node', [path.join(root, 'scripts/scenario/fake-voice.mjs'), DIST, '1'], { cwd: root, stdio: 'ignore' });
if (fv.status) throw new Error('fake-voice упал');

const server = await startServer({ dist: DIST, pub: path.join(root, 'public'), cache: process.env.AR_MODEL_CACHE || path.join(root, '.cache/model-opt') });
log(`сервер ${server.base}`);
const browser = await launch({ media: path.join(MEDIA, 'still.y4m'), room, headful: flag('--headful') });

const only = arg('--only', '').split(',').filter(Boolean);
const tests = TESTS.filter((t) => !only.length || only.some((o) => t.name.startsWith(o) || t.name.includes(o)));
const results = [];
const allErrors = [];
for (const t of tests) {
  const t0 = Date.now();
  const phones = [];
  const ctx = {
    browser, server, out: OUT, log: (...a) => log(`  ${t.name}:`, ...a),
    track: (P) => (phones.push(P), P),
    notes: [],
    note(s) {
      this.notes.push(s);
      log(`  ${t.name}: ⓘ ${s}`);
    },
  };
  log(`▶ ${t.name}`);
  let err = null;
  try {
    await Promise.race([t.fn(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error(`таймаут сценария ${t.timeout ?? 600} с`)), (t.timeout ?? 600) * 1000))]);
  } catch (e) {
    err = e;
  }
  // ошибки страницы (сценарий 10): 0 console.error / pageerror / unhandledrejection, кроме белого списка
  const pageErrs = [];
  for (const P of phones) {
    const qa = await P.ev(() => window.__qaErr ?? []).catch(() => []);
    for (const e of qa) P.errors.push({ kind: e.kind, text: `${e.msg} ${e.src ?? ''}`.trim(), at: Date.now() });
    for (const e of P.errors) {
      const a = allowed(e.text, t.allow ?? []);
      allErrors.push({ test: t.name, ...e, allowed: a?.why ?? null });
      if (!a) pageErrs.push(e);
    }
  }
  const uniq = [...new Map(pageErrs.map((e) => [e.kind + e.text, e])).values()];
  if (!err && uniq.length) err = new Error(`ошибки страницы (${uniq.length}): ${uniq.slice(0, 4).map((e) => `[${e.kind}] ${e.text.slice(0, 200)}`).join(' | ')}`);
  if (err) {
    for (const [i, P] of phones.entries()) await P.shot(path.join(OUT, `${t.name}${phones.length > 1 ? '_' + i : ''}.png`)).catch(() => undefined);
    for (const [i, P] of phones.entries()) {
      const l = await P.log().catch(() => []);
      fs.writeFileSync(path.join(OUT, `${t.name}${phones.length > 1 ? '_' + i : ''}.log.txt`), l.join('\n'));
    }
  }
  for (const P of phones) await P.close();
  const r = { name: t.name, title: t.title, ok: !err, sec: Math.round((Date.now() - t0) / 1000), error: err ? String(err.message || err) : null, notes: ctx.notes, errors: uniq.map((e) => `[${e.kind}] ${e.text}`) };
  results.push(r);
  log(`${r.ok ? '✓' : '✗'} ${t.name} (${r.sec} с)${r.error ? ' — ' + r.error : ''}`);
}
await browser.close();
await server.close();

// 404: ассеты, которых нет на стенде, но есть на сервере; остальное — провал прогона
//   модель Vosk (public/models/vosk-ru-small*, .gitignore) и клипы Meshy (/models/anims/meshy — кладёт attach-extra с
//   сервера сборки) — вне репозитория; props/bed.glb — необязательная модель кровати (home/room.ts пробует её, нет —
//   процедурная кровать; 404 и на проде)
const NOT_IN_REPO = /\/models\/(vosk-ru-small[^/]*\/|anims\/meshy\/|props\/bed\.glb$)/;
const miss = [...new Set(server.requests.filter((r) => r.status === 404).map((r) => r.path.split('?')[0]))];
const bad404 = miss.filter((p) => !NOT_IN_REPO.test(p));
if (!only.length || bad404.length) results.push({ name: '10_no_404', title: 'нет 404 (кроме ассетов вне репозитория: Vosk, Meshy; необязательной bed.glb)', ok: !bad404.length, sec: 0, error: bad404.length ? `404: ${bad404.slice(0, 8).join(', ')}` : null, notes: [], errors: [] });

const pass = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, results, errors: allErrors }, null, 2));
console.log(`\nE2E пилота: ${pass}/${results.length} зелёных`);
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(34)} ${String(r.sec).padStart(4)} с  ${r.title}${r.error ? '\n      ' + r.error : ''}`);
if (miss.length) console.log(`\n404 (${miss.length}): ${miss.slice(0, 10).join(', ')}`);
const allowedN = allErrors.filter((e) => e.allowed).length;
if (allowedN) console.log(`\n(белый список: ${allowedN} сообщений — ${[...new Set(allErrors.filter((e) => e.allowed).map((e) => e.allowed))].join('; ')})`);
process.exit(pass === results.length ? 0 : 1);
