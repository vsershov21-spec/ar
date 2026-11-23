#!/usr/bin/env node
// Сквозной аудит анимаций (стенд scripts/qa/anim-audit, вырос из scripts/qa/reactions.mjs): каждое действие ребёнка ×
// каждый кот в ПИЛОТЕ (/mvp, ?hour=14) → замеры по кадрам (30 к/с виртуального времени) + доп. зонд audit-probe.js
// (время update/коллайдера, миксеры, предмет, дрожь) + idle-клипы и стресс-сценарии (st_*).
// Итог: bench-out/anim-audit/raw/<tag>.json (сырые замеры), bench-out/anim-audit/sheets/<cat>_<id>.png (листы),
// дальше — audit-report.mjs <tag> (summary_<tag>.json) и table.mjs <tag> [<tagДо>] (таблица действие × кот, до → после).
//
//   node scripts/qa/anim-audit/audit.mjs --tag after                 — сборка pilot + все коты (≈ 22 мин на кота, 2 ядра)
//   node scripts/qa/anim-audit/audit.mjs --no-build --tag p1 --cats glitter --only rest,sig_mirror --no-sheets
//   node scripts/qa/anim-audit/audit.mjs --no-build --tag perf4 --cpu 4 --no-sheets   — CDP-замедление ЦП ×4 (класс телефона)
//   node scripts/qa/anim-audit/audit.mjs --focus "hooligan/st_treat_cancel:800-1300:33" — кадры подряд вокруг рывка
//   node scripts/qa/anim-audit/audit.mjs --meshy /srv/ar-extra/models/anims/meshy     — клипы Meshy с сервера
//   --clips meshy --only 'clip_*' — каждый загруженный клип Meshy сам по себе (character.play), без сценария
//   --out DIR — куда класть raw/ и sheets/ (по умолчанию bench-out/anim-audit)
//   --trace "JS от app" — своё значение в каждый кадр (frame.tr), node spikes.cjs <tag> cat/id --all — кадры подряд
//
//   node scripts/qa/reactions.mjs                    — сборка pilot (VITE_EDITION=pilot) + прогон всех котов
//   node scripts/qa/reactions.mjs --no-build         — без пересборки (bench-out/reactions/dist уже есть)
//   node scripts/qa/reactions.mjs --tag before       — имя прогона (до/после): bench-out/reactions/<tag>.json
//   node scripts/qa/reactions.mjs --cats kind --only act_pet,zone_head --no-sheets
//   node scripts/qa/reactions.mjs --report before,after — только отчёт из двух сохранённых прогонов (до → после)
//   node scripts/qa/reactions.mjs --params collide=legacy — добавить параметры в адрес (коррекция рук как до 18.11;
//                                                         collide=axis — как до 19.11: кисть по осям, замер по поверхности)
//   node scripts/qa/reactions.mjs --params models=v1 --tag v1_after — прежние модели (?models=v1; по умолчанию с 20.11 — v2)
//   node scripts/qa/reactions.mjs --report v1_before,v1_after --also "v1_before,v1_after,v1_axis;v2_before,v2_after,v2_axis"
//                                                       — отчёт + разделы пар прогонов (проникновение и щелчки до → после)
//   node scripts/qa/reactions.mjs --meshy DIR — отдавать /models/anims/meshy/* из DIR (клипы Meshy локально; scripts/qa/meshy-check.mjs)
//
// Как устроено: Chrome headless (swiftshader), ?from=test&nocard=off&debug — кот на столе без камеры. Время в странице
// виртуальное (scripts/qa/reactions-clock.js): кадр приложения = ровно 1/30 с, таймеры режиссёра в той же шкале, рендер
// только для кадров листа. Касания — настоящие pointer-события на слое касаний (жесты → интерпретатор → режиссёр), кнопки —
// Director.action(id) (как каталог), система — dispatch (карта пропала/нашлась), дом и раскраска — их API.
// Замеры в странице — scripts/qa/reactions-probe.js; метрики и пороги — analyze() ниже.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { reactionClock } from '../reactions-clock.js';
import { installProbe } from '../reactions-probe.js';
import { extraProbe } from './audit-probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = path.resolve(root, arg('--out', 'bench-out/anim-audit'));
const OUT = path.join(BASE, 'raw');
const DIST = path.resolve(root, arg('--dist', 'bench-out/reactions/dist'));
const SHEETS = arg('--sheets', '') ? path.resolve(arg('--sheets')) : path.join(BASE, 'sheets');
const REPORT = path.join(BASE, 'REACTIONS_audit.md');
const PORT = Number(arg('--port', 4196));
const TAG = arg('--tag', 'now');
const CATS = arg('--cats', 'hooligan,kind,glitter').split(',');
const ONLY = arg('--only', '') ? arg('--only').split(',') : null;
const SHEET = !flag('--no-sheets');
/** --zoom: кадры листа крупно вокруг кота (×2 пикселей, кадр по габариту кота с запасом) — для поз и предметов */
const ZOOM = flag('--zoom');
const PARAMS_EXTRA = ['hour=14', arg('--params', '')].filter(Boolean).join('&');
const PERF = Number(arg('--cpu', 0));
/** --focus "cat/id:t0-t1[:step],..." — кадры листа подряд в окне (доказательство рывка/проникновения) */
const FOCUS = Object.fromEntries(arg('--focus', '').split(',').filter(Boolean).map((x) => { const [k, w, st] = x.split(':'); const [a, b] = w.split('-').map(Number); return [k, { a, b, st: Number(st || 33) }]; }));
const FOCUS_ON = Object.keys(FOCUS).length > 0;
/** --trace "JS-выражение от app" — значение в каждый кадр (frame.tr; spikes.cjs его печатает) */
const TRACE = arg('--trace', '');
/** --setup "JS от app" — выполнить перед сценариями (переключатели слоёв для сравнения: app.character.footPin.off = true …) */
const SETUP = arg('--setup', '');
const MESHY_DIR = arg('--meshy', '') ? path.resolve(arg('--meshy')) : '';
/** --clips a,b|meshy — сценарии clip_<id>: клип сам по себе (character.play), «meshy» — все загруженные клипы Meshy кота */
const CLIPS = arg('--clips', '');
/**
 * порог проникновения руки/ноги в тело или одежду после коррекции BodyCollider, мм на карте — больше = «плохо» (19.11:
 * кисть и предплечье у головы меряются по точкам поверхности лапы, цель ≤ 1 мм)
 */
const PEN_BAD_MM = 1;
const log = (...a) => console.log(`[rx ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// ───────────── сценарии (время — мс виртуальных часов от начала сценария) ─────────────
const SIG = { hooligan: ['skate', 'glass'], kind: ['cocoa', 'bubbles'], glitter: ['mirror', 'bubbles'] };
const LABEL = {
  awake: 'пробуждение (посадка)', zone_head: 'тап: голова', zone_cheek: 'тап: щёчка', zone_belly: 'тап: живот', zone_paw: 'тап: лапа', zone_tail: 'тап: хвост',
  stroke: 'поглаживание пальцем', tap_spam: 'частые тапы', act_pet: 'Погладить', act_scratch: 'Почесать', act_tickle: 'Щекотка', act_treat: 'Угостить',
  act_paw: 'Дай лапу', act_hug: 'Обнять', act_dance: 'Танец', act_flip: 'Сальто', sig_skate: 'Скейт', sig_glass: 'К стеклу', sig_cocoa: 'Какао',
  sig_bubbles: 'Пузыри / блёстки', sig_mirror: 'Зеркальце', riddle: 'Загадка', echo: 'Повторялка', glass_scratch: 'стекло: царапины (свайп)',
  glass_fog: 'стекло: запотело (долгое мимо кота)', doze_wake: 'дрёма → тап будит', card_lost_found: 'карта пропала → нашлась', paint: 'раскраска карты',
  home_enter: 'дом: вход (гостиная)', home_kitchen: 'дом: кухня', home_bedroom: 'дом: спальня', home_bed: 'дом: уложить в кровать', home_bed_wake: 'дом: разбудить в кровати',
  home_exit: 'дом: назад на карту', chaos: 'хаос (смешанные тапы)', switch: 'смена кота',
};
/** ожидаемая мимика (семейства пресетов face.json): совпадение — хоть одно за первые 1,2 с */
const FACE_OK = {
  zone_head: /happy|smug|wink|shy|purr/, zone_cheek: /squish|laugh|happy|surpr|pout/, zone_belly: /laugh|happy/, zone_paw: /surpr|happy|laugh/, zone_tail: /surpr|pout/,
  stroke: /shy|purr|happy|caring/, tap_spam: /dizzy|pout|annoy|surpr|laugh/, act_pet: /shy|purr|happy|caring/, act_scratch: /happy|smug|wink|shy|purr/, act_tickle: /laugh|happy/,
  act_treat: /happy|laugh|excited|smile_big/, act_paw: /surpr|happy|laugh/, act_hug: /shy|purr|happy|caring/, act_dance: /happy|laugh|excited/, act_flip: /happy|laugh|surpr|excited/,
  sig_skate: /happy|smug|laugh|excited/, sig_glass: /happy|smug|laugh|wink|surpr|squish|cheeky|shy/, sig_cocoa: /happy|purr|shy|caring/, sig_bubbles: /happy|laugh|surpr|wink|smug|cheeks_gum|excited/,
  sig_mirror: /happy|smug|wink|shy|proud/, doze_wake: /sleep|sleepy/, card_lost_found: /sad|surpr/, glass_scratch: /happy|smug|laugh|surpr|wink/, glass_fog: /happy|smug|laugh|surpr|wink|shy|squish|cheeky|excited/,
};
/** задержка по замыслу (мс): карта «мигнула» — кот молчит 1,5 с (CARD_LOST_SAY_MS); долгое нажатие — 600 мс; свайп — по отпусканию; «Разбудить» — старт камеры и сцены пробуждения */
const DESIGN_DELAY = { card_lost: 1500, long: 600, swipe: 300, wake: 400 };
/** клипы, которые законно держатся петлёй до конца записи */
const HOLD_OK = /^(sleep_loop|walk|purr_stroke|dance)/;
/** клипы в воздухе: «парение» лап не считаем */
const AIR = /jump|flip|celebrate|dance|appear|dive|tumble|cheer|skate|bed|sleep/;
/** лёжа (сон, кровать): лапы — не опора, их «скольжение» не считаем (переход стоя ↔ лёжа — отдельной пометкой) */
const LIE = /sleep|bed|lie_/;

function scenarios(cat, durs = {}) {
  const IDLES = [...new Set([...Object.keys(durs), ...(durs.__avail ?? [])])].filter((k) => /^idle_/.test(k) && (!/^idle_(hooligan|kind|glitter)_/.test(k) || k.startsWith('idle_' + cat)));
  const s = [
    { id: 'rest', dur: 6000, steps: [] },
    { id: 'rest_noalive', dur: 6000, steps: [{ op: 'js', at: 0, label: 'aliveOff', code: 'app.character.aliveOff = true' }], after: 'app.character.aliveOff = false' },
    { id: 'look_noalive', dur: 6000, steps: [{ op: 'js', at: 0, label: 'aliveOff', code: 'app.character.aliveOff = true' }, { op: 'js', at: 300, label: 'play', code: "app.character.play('idle_look_around')" }], after: 'app.character.aliveOff = false' },
    ...(durs.__clips ?? []).map((k) => ({ id: 'clip_' + k, dur: Math.round(Math.min(9000, Math.max(3500, (durs[k] ?? 2.5) * 1000 + 1500))), steps: [{ op: 'js', at: 300, label: 'play ' + k, code: `app.character.play('${k}')` }] })),
    ...IDLES.map((k) => ({ id: 'idleclip_' + k, dur: Math.round(Math.max(4000, (durs[k] ?? 3) * 1000 + 1500)), steps: [{ op: 'js', at: 300, label: 'play ' + k, code: `app.character.play('${k}')` }] })),
    { id: 'zone_head', dur: 4000, steps: [{ op: 'tap', at: 300, bone: 'Head', dy: -0.04 }] },
    { id: 'zone_cheek', dur: 4000, steps: [{ op: 'tap', at: 300, bone: 'Head', dx: 0.15, dy: 0.04 }] },
    { id: 'zone_belly', dur: 4000, steps: [{ op: 'tap', at: 300, bone: 'Spine' }] },
    { id: 'zone_paw', dur: 4000, steps: [{ op: 'tap', at: 300, bone: 'RightHand' }] },
    { id: 'zone_tail', dur: 4000, steps: [{ op: 'tap', at: 300, bone: 'Tail3' }] },
    { id: 'stroke', dur: 4500, steps: [{ op: 'stroke', at: 300, bone: 'Spine2', dur: 1800 }] },
    { id: 'tap_spam', dur: 4500, steps: [{ op: 'spam', at: 300, n: 8, every: 120, bones: ['Spine1', 'Head', 'Spine'] }] },
    ...['pet', 'scratch', 'tickle', 'treat', 'paw', 'hug', 'dance', 'flip'].map((id) => ({ id: `act_${id}`, dur: id === 'dance' ? 9500 : id === 'flip' ? 6500 : 5000, steps: [{ op: 'action', at: 300, id }] })),
    ...SIG[cat].map((id) => ({ id: `sig_${id}`, dur: id === 'skate' ? 7500 : 6500, steps: [{ op: 'action', at: 300, id }] })),
    { id: 'glass_scratch', dur: 4500, steps: [{ op: 'swipe', at: 300 }] },
    { id: 'glass_fog', dur: 3500, steps: [{ op: 'long', at: 300, dur: 900 }] },
    { id: 'doze_wake', dur: 7000, steps: [{ op: 'action', at: 300, id: 'sleep' }, { op: 'tap', at: 3800, bone: 'Head', dy: -0.04 }] },
    {
      id: 'card_lost_found', dur: 7500,
      steps: [
        { op: 'js', at: 300, label: 'card_lost', code: "app.director.dispatch({ type: 'card_lost' })" },
        { op: 'js', at: 3800, label: 'card_found', code: "app.director.dispatch({ type: 'card_found' })" },
      ],
    },
    { id: 'chaos', dur: 9000, steps: chaosSteps(cat) },
    { id: 'riddle', dur: 5500, steps: [{ op: 'action', at: 300, id: 'riddle' }] },
    { id: 'echo', dur: 5500, steps: [{ op: 'action', at: 300, id: 'echo' }] },
    { id: 'paint', dur: 9000, steps: [{ op: 'js', at: 300, label: 'paint.start', code: 'app.paint?.start(0)' }], after: 'app.paint?.finishNow?.("qa")' },
    { id: 'home_enter', dur: 6000, steps: [{ op: 'js', at: 300, label: 'home.enter', code: "app.home?.enter('button')" }], keep: true },
    { id: 'home_kitchen', dur: 4500, steps: [{ op: 'js', at: 300, label: 'home.go kitchen', code: "app.home?.go('kitchen')" }], keep: true },
    { id: 'home_bedroom', dur: 4500, steps: [{ op: 'js', at: 300, label: 'home.go bedroom', code: "app.home?.go('bedroom')" }], keep: true },
    { id: 'home_bed', dur: 8000, steps: [{ op: 'js', at: 300, label: 'home:sleep', code: "app.home?.act('home:sleep')" }], keep: true },
    { id: 'home_bed_wake', dur: 7000, steps: [{ op: 'js', at: 300, label: 'home:wake', code: "app.home?.act('home:wake')" }], keep: true },
    { id: 'home_exit', dur: 6000, steps: [{ op: 'js', at: 300, label: 'home.exit', code: 'app.home?.exit()' }], keep: true },
    // лицо не залипает (23.11): пресет реплики без срока; встряски подряд (телефон в руке) — спирали; действие вытеснено
    { id: 'st_face_hold', dur: 14000, steps: [{ op: 'js', at: 300, label: "setFace('annoyed')", code: "app.character.setFace('annoyed')" }] },
    { id: 'st_shake_spam', dur: 12000, steps: [300, 1300, 2300, 3300, 4300, 5300].map((at) => ({ op: 'js', at, label: 'shake', code: "app.director.interaction('shake')" })) },
    { id: 'st_face_cancel', dur: 8000, steps: [{ op: 'action', at: 300, id: SIG[cat][0] === 'skate' ? 'skate' : SIG[cat][0] }, { op: 'js', at: 700, label: "setFace('sleepy')", code: "app.character.setFace('sleepy')" }, { op: 'action', at: 1500, id: 'pet' }] },
    // скейт в гостиной (дом): доска на ковре, не проваливается (23.11)
    { id: 'st_home_skate', dur: 13000, steps: [{ op: 'js', at: 300, label: 'home.enter', code: "app.home?.enter('button')" }, { op: 'action', at: 4000, id: SIG[cat][0] }], after: 'app.home?.exit?.()' },
    { id: 'st_flip5', dur: 7000, steps: [0, 150, 300, 450, 600].map((d) => ({ op: 'action', at: 300 + d, id: 'flip' })) },
    { id: 'st_skate_dance', dur: 12000, steps: [{ op: 'action', at: 300, id: SIG[cat][0] }, { op: 'action', at: 900, id: 'dance' }] },
    { id: 'st_mix_fast', dur: 9000, steps: ['pet', 'dance', 'treat', SIG[cat][0], 'flip', 'hug', SIG[cat][1], 'tickle'].map((id, i) => ({ op: 'action', at: 300 + i * 220, id })) },
    { id: 'st_prop_cancel', dur: 6000, steps: [{ op: 'action', at: 300, id: SIG[cat][0] }, { op: 'action', at: 1300, id: 'pet' }] },
    { id: 'st_treat_cancel', dur: 6000, steps: [{ op: 'action', at: 300, id: 'treat' }, { op: 'action', at: 900, id: 'hug' }] },
    { id: 'st_sleep_btn', dur: 7000, steps: [{ op: 'action', at: 300, id: 'sleep' }, { op: 'action', at: 3000, id: 'dance' }] },
    { id: 'st_paint_btn', dur: 9000, steps: [{ op: 'js', at: 300, label: 'paint.start', code: 'app.paint?.start(0)' }, { op: 'action', at: 3000, id: 'flip' }], after: 'app.paint?.finishNow?.("qa")' },
    { id: 'st_bed_btn', dur: 12000, steps: [{ op: 'js', at: 300, label: 'home.enter', code: "app.home?.enter('button')" }, { op: 'js', at: 3300, label: 'home.go bedroom', code: "app.home?.go('bedroom')" }, { op: 'js', at: 5500, label: 'home:sleep', code: "app.home?.act('home:sleep')" }, { op: 'action', at: 9500, id: 'dance' }], after: 'app.home?.exit?.()' },
    {
      id: 'st_switch_mid', dur: 11000,
      steps: [
        { op: 'js', at: 100, label: 'cd reset', code: 'app.switchCooldown && (app.switchCooldown.last = -Infinity)' },
        { op: 'action', at: 300, id: SIG[cat][0] },
        { op: 'action', at: 1200, id: 'other' },
        { op: 'js', at: 2000, label: 'да', code: "app.director.text('да')" },
        { op: 'js', at: 4500, label: 'shake', code: "app.director.interaction('shake')" },
      ],
    },
    {
      id: 'switch', dur: 11000,
      steps: [
        { op: 'js', at: 100, label: 'cd reset', code: 'app.switchCooldown && (app.switchCooldown.last = -Infinity)' },
        { op: 'action', at: 300, id: 'other' },
        { op: 'js', at: 2300, label: 'да', code: "app.director.text('да')" },
        { op: 'js', at: 5200, label: 'shake', code: "app.director.interaction('shake')" },
      ],
    },
  ];
  return ONLY ? s.filter((x) => ONLY.some((o) => (o.endsWith('*') ? x.id.startsWith(o.slice(0, -1)) : o === x.id))) : s;
}

/** хаос: детерминированная смесь тапов по зонам, поглаживаний, кнопок пилота — ~3 события в секунду */
function chaosSteps(cat) {
  let seed = 7 + cat.length;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bones = ['Head', 'Spine', 'Spine1', 'RightHand', 'LeftHand', 'Tail3'];
  const acts = ['pet', 'scratch', 'tickle', 'treat', 'paw', 'hug', 'dance', 'flip', ...SIG[cat]];
  const out = [];
  for (let t = 300; t < 8000; t += 180 + rnd() * 260) {
    const k = rnd();
    if (k < 0.55) out.push({ op: 'tap', at: Math.round(t), bone: bones[Math.floor(rnd() * bones.length)] });
    else if (k < 0.7) {
      out.push({ op: 'stroke', at: Math.round(t), bone: 'Spine2', dur: 700 });
      t += 700;
    } else out.push({ op: 'action', at: Math.round(t), id: acts[Math.floor(rnd() * acts.length)] });
  }
  return out;
}

// ───────────── сборка и сервер ─────────────
function build() {
  log('сборка pilot → bench-out/reactions/dist');
  const r = spawnSync('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_EDITION: 'pilot' } });
  if (r.status) throw new Error('vite build упал');
}
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ktx2': 'image/ktx2', '.mp4': 'video/mp4' };
function serve() {
  return http
    .createServer((q, r) => {
      let p = decodeURIComponent(q.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      // клипы Meshy из локальной папки (--meshy DIR): /models/anims/meshy/<файл> → DIR/<файл>
      const mm = MESHY_DIR && p.match(/^\/models\/anims\/meshy\/([\w.-]+)$/);
      const f = mm ? path.join(MESHY_DIR, mm[1]) : path.join(DIST, path.normalize(p));
      if ((!mm && !f.startsWith(DIST)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        r.statusCode = 404;
        return r.end();
      }
      r.setHeader('content-type', TYPES[path.extname(f)] ?? 'application/octet-stream');
      fs.createReadStream(f).pipe(r);
    })
    .listen(PORT);
}

// ───────────── прогон одного кота ─────────────
async function runCat(browser, cat) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: ZOOM ? 2 : 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log(`  [${cat}] pageerror`, e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(reactionClock, { persona: cat });
  await page.goto(`http://localhost:${PORT}/?from=test&nocard=off&debug${PARAMS_EXTRA ? '&' + PARAMS_EXTRA : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__app?.director && window.__app.character?.kind === 'glb' && window.__app.character.mixer, { timeout: 120000 });
  await page.waitForFunction(() => !!document.querySelector('[data-a="wake"]'), { timeout: 60000 });
  await page.evaluate(() => window.__debugPanel?.open?.(false));
  // клипы Meshy из --meshy: дождаться загрузки (грузятся после кота) и записать состояния
  let meshy = null;
  if (MESHY_DIR) {
    let prev = -1, still = 0;
    for (let i = 0; i < 120 && still < 4; i++) {
      await sleep(500);
      const n = await page.evaluate(() => window.__meshyStatus?.size ?? 0);
      still = n > 0 && n === prev ? still + 1 : 0;
      prev = n;
    }
    meshy = await page.evaluate(() => [...(window.__meshyStatus?.values() ?? [])]);
    const k = (s) => meshy.filter((m) => m.state === s).length;
    log(`  [${cat}] Meshy: загружено ${k('loaded')}, нет ${k('missing')}, отвергнуто ${k('rejected')}`);
    for (const m of meshy) if (m.state === 'rejected') log(`    ✗ ${m.id}: ${m.reason}`);
  }
  // остальные движения (пакет «остальное», GlbCharacter.loadDeferred — после посадки) — до замеров и списка клипов:
  // иначе клип из него сыграл бы опорой; в сборке без пакетов — сразу
  await page.evaluate(async () => {
    const c = window.__app.character;
    if (c?.deferredPending && c.loadDeferred) await c.loadDeferred();
  });
  // кадры листа — только 3D и эффекты (интерфейс прячется на время снимка)
  await page.addStyleTag({ content: 'html.rxshot *{visibility:hidden!important} html.rxshot canvas{visibility:visible!important}' });
  // ручное время: дальше кадр = 1/30 с
  await page.evaluate(() => window.__vt.manual());
  if (PERF) {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PERF });
    log(`[${cat}] CPU ×${PERF}`);
  }
  const cal = await page.evaluate(installProbe);
  await page.evaluate(extraProbe);
  if (TRACE) await page.evaluate((x) => (window.__rxTraceFn = new Function('app', `return (${x})`)), TRACE);
  const durs = await page.evaluate(() => Object.fromEntries([...window.__app.character.clips.realDuration]));
  const avail = await page.evaluate(() => { const c = window.__app.character; return [...new Set([...(c.actions?.keys?.() ?? []), ...(c.aliased?.keys?.() ?? [])])]; });
  log(`[${cat}] клипов: ${avail.length}; idle: ${avail.filter((k) => /^idle/.test(k)).join(',')}`);
  durs.__avail = avail;
  durs.__clips = CLIPS === 'meshy' ? (meshy ?? []).filter((m) => m.state === 'loaded').map((m) => m.id) : CLIPS ? CLIPS.split(',') : [];
  log(`[${cat}] калибровка`, JSON.stringify(cal));
  const results = [];
  const want = (id) => !ONLY || ONLY.includes(id);

  // пробуждение: от кнопки «Разбудить» до свободной игры
  if (want('awake')) {
    await page.evaluate(() => {
      window.__rx.begin('awake');
      window.__rx.add({ op: 'js', at: 100, label: 'wake', code: "document.querySelector('[data-a=\"wake\"]').click()" });
    });
    results.push(await record(page, cat, { id: 'awake', dur: 9000 }));
  } else {
    await page.evaluate(() => document.querySelector('[data-a="wake"]').click());
    await page.evaluate(() => (window.__rx.begin('boot'), window.__rx.run(8000)));
  }
  // до свободной игры (приветствие договорено)
  await page.evaluate(async () => {
    for (let i = 0; i < 40 && !(['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy); i++) await window.__rx.run(window.__rx.t() + 500);
  });
  await page.evaluate(() => window.__rx.calibrate());
  if (SETUP) await page.evaluate((x) => new Function('app', x)(window.__app), SETUP);
  for (const sc of scenarios(cat, durs)) {
    await settle(page, sc);
    await page.evaluate((s) => {
      window.__rx.begin(s.id);
      for (const st of s.steps) window.__rx.add(st);
    }, sc);
    const r = await record(page, cat, sc);
    if (sc.after) await page.evaluate((code) => new Function('app', code)(window.__app), sc.after).catch(() => {});
    results.push(r);
    const a = analyze(r, durs, [...catalogCuts()]);
    log(`[${cat}] ${sc.id}: ${a.verdict} lat ${a.lat ?? '—'} мс, pop ${a.pop}, slide ${a.slide} мм, ${a.notes.join('; ')}`);
  }
  await page.close();
  return { cat, cal, durs, results, meshy };
}

/** спокойная стойка перед сценарием: диалог закрыт, очередь пуста, кот в покое на карте */
async function settle(page, sc) {
  await page.evaluate(async (keepHome) => {
    const app = window.__app, d = app.director, rx = window.__rx;
    rx.begin('settle');
    if (d.state.dialog) d.dispatch({ type: 'intent', intent: { type: 'stop', text: 'стоп', button: true } });
    if (!keepHome && app.home?.active) app.home.exit();
    d.queue.clear?.();
    app.voice?.stop?.();
    if (!keepHome || !app.home?.catInBed) {
      for (let i = 0; i < 14; i++) {
        await rx.run(rx.t() + 250);
        if (!d.queue.busy && app.character.clips.idleMode && !app.stage.walking && !app.home?.moving) break;
      }
      if (!app.character.clips.idleMode && !app.home?.catInBed) app.character.play('idle');
    }
    await rx.run(rx.t() + 1200);
  }, !!sc.keep);
}

/** кадры сценария + кадры листа (12 равномерно) */
async function record(page, cat, sc) {
  const FW = FOCUS[`${cat}/${sc.id}`];
  const N = FW ? Math.min(12, Math.floor((FW.b - FW.a) / FW.st) + 1) : SHEET ? 12 : 0;
  const shots = [];
  for (let i = 1; i <= N; i++) {
    const t = FW ? FW.a + (i - 1) * FW.st : Math.round((sc.dur * i) / (N + 1));
    await page.evaluate((t) => window.__rx.run(t, true), t);
    const info = await page.evaluate(() => {
      const rx = window.__rx, f = rx.frames[rx.frames.length - 1];
      return { box: rx.catBox(), t: f?.t, clip: f?.clip, emo: f?.emo ?? f?.preset, m: `ω ${f?.w} ${f?.wb ?? ''} · ${f?.penMM > 0.5 ? 'пр ' + f.penMM + ' ' + f.penPair : ''}${f?.act ? ' · ' + f.act : ''}` };
    });
    await page.evaluate(() => document.documentElement.classList.add('rxshot'));
    const buf = await page.screenshot({ type: 'png' });
    await page.evaluate(() => document.documentElement.classList.remove('rxshot'));
    shots.push({ buf, ...info });
  }
  await page.evaluate((t) => window.__rx.run(t), sc.dur);
  const data = await page.evaluate(() => window.__rx.end());
  if (shots.length) await sheet(cat, sc.id + (FW ? '_focus' : ''), shots);
  return { id: sc.id, dur: sc.dur, ...data };
}

async function sheet(cat, id, shots) {
  fs.mkdirSync(SHEETS, { recursive: true });
  const S = 160, H = 272, cols = 6, rows = Math.ceil(shots.length / cols), lab = 34;
  const tiles = await Promise.all(
    shots.map(async (s, i) => {
      let ex = { left: 0, top: 60, width: 390, height: 664 };
      if (ZOOM) {
        // кадр вокруг кота: высота — рост кота × 1,7, пропорция плитки; ×2 пикселей
        const b = s.box ?? { x0: 120, x1: 270, y0: 250, y1: 600 };
        const ch = Math.max(160, (b.y1 - b.y0) * 2.4), cw = (ch * S) / H;
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2 - (b.y1 - b.y0) * 0.12;
        const L = Math.max(0, Math.min(390 - cw, cx - cw / 2)), T = Math.max(0, Math.min(844 - ch, cy - ch / 2));
        ex = { left: Math.round(L * 2), top: Math.round(T * 2), width: Math.round(Math.min(cw, 390) * 2), height: Math.round(Math.min(ch, 844) * 2) };
      }
      const img = await sharp(s.buf).extract(ex).resize(S, H, { fit: 'cover' }).toBuffer();
      const esc = (x) => String(x ?? '').replace(/[<&>]/g, '');
      const svg = Buffer.from(`<svg width="${S}" height="${lab}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="4" y="14" font-size="12" font-family="DejaVu Sans" fill="#fff">${(s.t / 1000).toFixed(2)} с · ${esc(s.clip)}</text><text x="4" y="29" font-size="11" font-family="DejaVu Sans" fill="#9cf">${esc(s.m && FOCUS_ON ? s.m : s.emo || 'лицо: —')}</text></svg>`);
      return { input: await sharp({ create: { width: S, height: H + lab, channels: 3, background: '#111' } }).composite([{ input: img, top: 0, left: 0 }, { input: svg, top: H, left: 0 }]).png().toBuffer(), left: (i % cols) * S, top: Math.floor(i / cols) * (H + lab) };
    }),
  );
  await sharp({ create: { width: cols * S, height: rows * (H + lab), channels: 3, background: '#000' } }).composite(tiles).png({ palette: true, quality: 70, compressionLevel: 9 }).toFile(path.join(SHEETS, `${cat}_${id}.png`));
}

// ───────────── метрики ─────────────
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
let INV = null;
function inventory() {
  if (INV) return INV;
  INV = {};
  const f = path.join(root, 'docs/animations/INVENTORY.md');
  if (!fs.existsSync(f)) return INV;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\| `([a-z0-9_]+)` \| P\d \|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\| \*\*([^*]+)\*\*/);
    if (m) INV[m[1]] = m[2];
  }
  return INV;
}

const segs0 = (fr) => {
  const out = [];
  for (const f of fr) if (!out.length || out[out.length - 1].clip !== f.clip) out.push({ clip: f.clip, t: f.t });
  return out;
};
let CUTS = null;
function catalogCuts() {
  if (CUTS) return CUTS;
  const j = JSON.parse(fs.readFileSync(path.join(root, 'content/animations.json'), 'utf8'));
  return (CUTS = new Set(j.clips.filter((c) => c.cut).map((c) => c.id)));
}

export function analyze(r, durs = {}, cuts = null) {
  const fr = r.frames.filter((f) => !f.mark);
  const marks = r.frames.filter((f) => f.mark);
  const notes = [];
  const m0 = marks[0]?.t ?? 0;
  const after = fr.filter((f) => f.t >= m0);
  // задержка: первый заметный отклик тела (≥ 0,12 рад на ключевой кости от позы в момент события), лица (≥ 0,25), эффекта
  const lats = [];
  for (let i = 0; i < marks.length; i++) {
    const t0 = marks[i].t, t1 = marks[i + 1]?.t ?? Infinity;
    if (/^tap/.test(marks[i].mark) && marks[i + 1] && /^tap/.test(marks[i + 1].mark) && t1 - t0 < 400) continue; // серия тапов — по первому
    const win = fr.filter((f) => f.t > t0 && f.t <= Math.min(t1, t0 + 2500));
    // тело: кадр, где играет клип реакции (не покой) и поза ушла ≥ 0,08 рад от позы в момент его включения
    // (движение покоя — не реакция); лицо — вес мимики ≥ 0,25 от лица в момент события; эффект — fx.play
    const body = win.find((f) => !f.idle && f.Dsw >= 0.08 && (f.t > t0 + 1))?.t;
    const face = win.find((f) => f.F >= 0.25)?.t;
    const fx = r.fx.find((x) => x.t >= t0 && x.t <= Math.min(t1, t0 + 2500))?.t;
    const ev = (r.events ?? []).find((e) => e.t >= t0 && e.t <= Math.min(t1, t0 + 2500))?.t;
    const first = Math.min(body ?? Infinity, face ?? Infinity, fx ?? Infinity);
    lats.push({ mark: marks[i].mark, input: ev !== undefined ? ev - t0 : null, body: body !== undefined ? body - t0 : null, face: face !== undefined ? face - t0 : null, fx: fx !== undefined ? fx - t0 : null, first: Number.isFinite(first) ? first - t0 : null });
  }
  const firstL = lats[0] ?? { first: null, body: null };
  // задержка по замыслу (карта мигнула, долгое нажатие) вычитается из оценки, в отчёте — как есть
  const dd = (l) => Object.entries(DESIGN_DELAY).find(([k]) => l.mark.startsWith(k))?.[1] ?? 0;
  const lat = lats.length ? (lats.some((l) => l.first === null) ? null : Math.max(...lats.map((l) => l.first))) : null;
  const latJ = lats.length && lat !== null ? Math.max(...lats.map((l) => Math.max(0, l.first - dd(l)))) : null;
  const latBody = lats.length && lats.every((l) => l.body !== null) ? Math.max(...lats.map((l) => l.body)) : null;
  const latIn = lats.length && lats.every((l) => l.input !== null) ? Math.max(...lats.map((l) => l.input)) : null;
  // щелчки на стыках клипов: пик угловой скорости в 0,3 с после смены клипа
  let pop = 0, popAt = '', hipPop = 0;
  after.forEach((f, i) => {
    if (!f.sw) return;
    const w = after.slice(i, i + 10);
    for (const g of w) {
      if (g.w > pop) [pop, popAt] = [g.w, `${g.wb}@${f.clip}`];
      hipPop = Math.max(hipPop, g.wHip);
    }
  });
  const wAll = pct(after.map((f) => f.w), 0.99);
  // лапы
  // скольжение: лапа стоит (≤ 4 мм над опорой, по высоте почти не движется) — насколько она уехала от точки, где встала
  // (макс. по лапам и опорам, мм); дрожание на месте не копится. Ходьба — отдельно.
  const drift = (walk) => {
    let worst = 0;
    const plant = [];
    for (const f of after) {
      if (!f.fp || !f.fh) continue;
      for (let k = 0; k < f.fh.length; k++) {
        const x = f.fp[2 * k], y = f.fp[2 * k + 1], h = f.fh[k];
        const pl = plant[k];
        const down = h < 4 && (!pl || Math.abs(h - pl.h) < 3) && !!f.walk === walk && f.vis && !f.glass && !LIE.test(f.clip);
        if (!down) { plant[k] = null; continue; }
        if (!pl) { plant[k] = { x, y, h }; continue; }
        pl.h = h;
        worst = Math.max(worst, Math.hypot(x - pl.x, y - pl.y));
      }
    }
    return worst;
  };
  const slideIn = drift(false);
  const slideWalk = drift(true);
  const low = after.filter((f) => f.vis && !f.glass && f.fh?.length && !LIE.test(f.clip)).map((f) => Math.min(...f.fh));
  const sink = low.length ? Math.min(...low) : 0;
  const calm = after.filter((f) => f.vis && !f.glass && f.fh?.length && !AIR.test(f.clip));
  const floatP = calm.length > 10 ? median(calm.map((f) => Math.min(...f.fh))) : 0;
  const pen = Math.max(0, ...after.map((f) => f.pen));
  // проникновение, мм (BodyCollider.measurePairs после коррекции): самая глубокая пара за сценарий
  let penMM = 0, penPair = '';
  for (const f of after) if ((f.penMM ?? 0) > penMM) [penMM, penPair] = [f.penMM, `${f.penPair}@${f.clip}`];
  // переход стоя ↔ лёжа за время инерциального смешивания (нет клипа «лечь»/«встать»)
  const lieTrans = segs0(after).some((s, i, a) => i > 0 && LIE.test(s.clip) !== LIE.test(a[i - 1].clip) && !/bed/.test(s.clip + a[i - 1].clip));
  const bind = Math.max(0, ...after.map((f) => f.bind));
  // клипы реакции (не покой)
  const segs = [];
  for (const f of after) {
    const last = segs[segs.length - 1];
    if (!last || last.clip !== f.clip || f.sw) segs.push({ clip: f.clip, t0: f.t, t1: f.t, idle: f.idle, proc: f.proc, alias: f.alias });
    else last.t1 = f.t;
  }
  const react = segs.filter((s) => !s.idle && !/^talk/.test(s.clip));
  const inv = inventory();
  const cutIds = cuts ? new Set(cuts) : new Set();
  const stub = [...new Set(react.filter((s) => s.proc || /заглушка/.test(inv[s.clip] ?? '')).map((s) => s.clip))];
  // «переделать» из инвентаризации — кроме клипов, уже смонтированных по каталогу (cut: длина была главной бедой)
  const redo = [...new Set(react.filter((s) => /переделать/.test(inv[s.clip] ?? '') && !cutIds.has(s.clip)).map((s) => s.clip))];
  // обрывы: реакцию сменил другой клип (или покой) раньше 55% её длины без нового действия ребёнка
  const cut = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i], n = segs[i + 1];
    // опоры кровати (fallback) сцена ведёт цепочкой по своим таймерам — это не обрыв
    if (s.idle || /^talk|^walk/.test(s.clip) || n.clip === s.clip || s.proc) continue;
    const d = durs[s.clip];
    const len = s.t1 - s.t0 + 33;
    const userBetween = marks.some((m) => m.t > s.t0 + 30 && m.t <= n.t0 + 1);
    if (d && len < d * 1000 * 0.55 && !userBetween && !HOLD_OK.test(s.clip)) cut.push(`${s.clip}→${n.clip} на ${(len / 1000).toFixed(1)}/${d.toFixed(1)} с`);
  }
  // драка клипов: реакцию за ≤ 250 мс сменил другой клип реакции без нового действия ребёнка (два вызова play подряд)
  const fight = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    if (a.idle || b.idle || a.clip === b.clip || /^(talk|walk)/.test(a.clip) || a.proc) continue;
    if (b.t0 - a.t0 <= 250 && !marks.some((m) => m.t > a.t0 - 34 && m.t <= b.t0 + 1)) fight.push(`${a.clip}+${b.clip}`);
  }
  // возврат в покой
  const lastF = after[after.length - 1];
  const lastReact = react[react.length - 1];
  const backIdle = lastF?.idle || (lastReact && HOLD_OK.test(lastReact.clip));
  const idleAt = (() => {
    if (!lastReact) return null;
    const f = after.find((x) => x.t > lastReact.t1 && x.idle);
    return f ? f.t - m0 : null;
  })();
  // мимика
  const emos = [...new Set(after.filter((f) => f.t - m0 <= 1500).map((f) => f.emo || f.preset).filter((x) => x && x !== 'neutral'))];
  const faceRe = FACE_OK[r.id];
  const faceOk = !faceRe || emos.some((e) => faceRe.test(e));
  const eyesClosed = r.id === 'doze_wake' ? Math.max(0, ...after.filter((f) => f.t > m0 + 1000 && f.t < (marks[1]?.t ?? Infinity)).map((f) => f.blink)) : null;
  const switchesPerS = after.filter((f) => f.sw).length / Math.max(1, (after.length / 30));
  // вердикт
  let verdict = 'ok';
  const bad = (n) => ((verdict = 'bad'), notes.push(n));
  const tol = (n) => (verdict === 'ok' && (verdict = 'tol'), notes.push(n));
  if (r.errors?.length) bad(`ошибки JS: ${r.errors.length}`);
  if (bind > 0.5) bad(`T-поза (bind ${bind})`);
  if (lat === null && r.id !== 'chaos') bad('нет видимой реакции');
  else if (latJ > 300) bad(`реакция через ${lat} мс`);
  else if (latJ > 150) tol(`реакция через ${lat} мс`);
  else if (latJ !== lat) notes.push(`${lat} мс — по замыслу (${lats.map((l) => l.mark.split(' ')[0]).join(', ')})`);
  if (latBody === null && !/^(card_lost_found|glass_fog|glass_scratch|home_|riddle|echo|paint|chaos)/.test(r.id)) tol('тело не отвечает (только лицо/эффект)');
  if (pop > 15) bad(`щелчок ${pop.toFixed(1)} рад/с (${popAt})`);
  else if (pop > 10.5) tol(`щелчок ${pop.toFixed(1)} рад/с (${popAt})`);
  if (slideIn > 15) bad(`лапы едут ${slideIn.toFixed(0)} мм`);
  else if (slideIn > 5) tol(`лапы едут ${slideIn.toFixed(0)} мм`);
  // пробуждение: кот по замыслу поднимается из-под карты (сцена awake) — «провал» лап там не ошибка
  if (!/^(home_bed|awake)/.test(r.id)) {
    if (sink < -5) bad(`провал лап ${sink.toFixed(1)} мм`);
    else if (sink < -2.5) tol(`провал лап ${sink.toFixed(1)} мм`);
    if (floatP > 4) tol(`парит ${floatP.toFixed(1)} мм`);
  }
  if (penMM > PEN_BAD_MM) bad(`проникновение ${penMM.toFixed(1)} мм (${penPair})`);
  else if (pen > 0.12 && after[0]?.penMM === undefined) tol(`рука в теле ${(pen * 100).toFixed(0)}%`);
  if (lieTrans) tol('лечь/встать — переход смешиванием (нужен клип fall_asleep / wake_up)');
  if (fight.length) bad(`клипы дерутся: ${[...new Set(fight)].slice(0, 2).join(', ')}`);
  if (cut.length && r.id !== 'chaos' && r.id !== 'tap_spam') tol(`обрыв: ${cut.slice(0, 2).join(', ')}`);
  if (!backIdle && !/^(home_bed$|doze|switch|chaos|riddle|echo|paint)/.test(r.id)) bad(`не вернулся в покой (${lastF?.clip})`);
  if (stub.length) tol(`заглушка: ${stub.join(', ')}`);
  if (redo.length) tol(`клип «переделать»: ${redo.join(', ')}`);
  if (!faceOk) tol(`лицо не то: ${emos.join('/') || 'нейтральное'}`);
  if (eyesClosed !== null && eyesClosed < 0.7) tol(`спит с открытыми глазами (веки ${eyesClosed})`);
  if (r.id === 'chaos' && switchesPerS > 4) tol(`дёргается: ${switchesPerS.toFixed(1)} смен клипа/с`);
  return {
    id: r.id, verdict, notes, lat, latBody, latIn, lats, pop: +pop.toFixed(1), popAt, hipPop: +hipPop.toFixed(1), w99: +wAll.toFixed(1),
    slide: +slideIn.toFixed(1), slideWalk: +slideWalk.toFixed(1), sink: +sink.toFixed(1), float: +floatP.toFixed(1), pen: +pen.toFixed(3), penMM: +penMM.toFixed(1), penPair, penPairs: r.penPairs ?? {}, bind,
    clips: [...new Set(react.map((s) => s.clip))], stub, redo, cut, fight: [...new Set(fight)], idleAt, emos, faceOk, switchesPerS: +switchesPerS.toFixed(1),
    errors: r.errors?.length ?? 0,
  };
}

// ───────────── отчёт ─────────────
const V = { ok: 'ok', tol: 'терпимо', bad: '**плохо**' };
function alsoSection(runs) {
  const [b, a, x] = runs; // до, после, (до коррекции по поверхности: ?collide=axis — тот же замер, коррекция по осям)
  const L = ['', `## Вторая пара прогонов: \`${b.tag}\` → \`${a.tag}\`${x ? ` (и \`${x.tag}\`)` : ''} — проникновение и щелчки`, ''];
  L.push(`«до» — \`${b.tag}\` (${b.at})${x ? `, «оси»: \`${x.tag}\` (${x.at}) — новая сборка с ?collide=axis: коррекция по осям, как до 19.11, а замер — по точкам поверхности (что было видно)` : ''}, «после» — \`${a.tag}\` (${a.at}). В ячейке: проникновение мм (самая глубокая пара) · щелчок рад/с.`);
  L.push('');
  const cats = a.cats.map((c) => c.cat);
  const ids = [...new Set(a.cats.flatMap((c) => c.results.map((r) => r.id)))];
  const A = (run, cat, id) => {
    const c = run?.cats.find((q) => q.cat === cat);
    const r = c?.results.find((q) => q.id === id);
    return r ? analyze(r, c.durs, run.cuts) : null;
  };
  L.push(`| действие | ${cats.map((c) => `${c}: до${x ? ' · оси' : ''} → после`).join(' | ')} |`);
  L.push(`|---|${cats.map(() => '---').join('|')}|`);
  const worst = { b: 0, x: 0, a: 0, popB: 0, popA: 0, newPops: [] };
  for (const id of ids) {
    const cells = cats.map((cat) => {
      const pa = A(a, cat, id), pb = A(b, cat, id), px = x ? A(x, cat, id) : null;
      if (!pa) return '—';
      worst.a = Math.max(worst.a, pa.penMM);
      worst.popA = Math.max(worst.popA, pa.pop);
      if (pb) {
        worst.b = Math.max(worst.b, pb.penMM);
        worst.popB = Math.max(worst.popB, pb.pop);
        if (pa.pop > 15 && pb.pop <= 15) worst.newPops.push(`${cat} ${id} ${pa.pop}`);
      }
      if (px) worst.x = Math.max(worst.x, px.penMM);
      const mark = pa.penMM > PEN_BAD_MM ? '**' : '';
      return `${pb ? pb.penMM : '—'}${px ? ` · ${px.penMM}` : ''} → ${mark}${pa.penMM}${mark}${pa.penMM > 0.5 ? ` (${pa.penPair})` : ''} · щ ${pb ? pb.pop : '—'} → ${pa.pop}`;
    });
    L.push(`| ${LABEL[id] ?? id} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push(`Максимум: проникновение ${worst.b}${x ? ` · ${worst.x}` : ''} → **${worst.a} мм**; щелчок ${worst.popB} → ${worst.popA} рад/с; новых щелчков > 15 рад/с: ${worst.newPops.length ? worst.newPops.join(', ') : 'нет'}.`);
  L.push('');
  return L;
}

/**
 * Руки у головы крупно (tools/hands-probe.mjs → bench-out/hands): 8 клипов «лапы к лицу/ушам/шее» подряд 30 к/с, клип как
 * есть / «до» (кисть по осям, прокси как были) / «после»; сетка против сетки — scripts/models/penetration.py --pose-json
 * (bench-out/hands/tri_<v>_<кот>.md); время коррекции на кадр.
 */
function handsSection() {
  const dir = path.join(root, 'bench-out/hands');
  const f = path.join(dir, 'summary.json');
  if (!fs.existsSync(f)) return [];
  const S = JSON.parse(fs.readFileSync(f, 'utf8'));
  const L = ['', '## Руки у головы и одежды крупно (`tools/hands-probe.mjs`): до → после', ''];
  L.push('8 клипов, где лапы у лица/ушей/шеи/наушников, подряд 30 к/с (как в приложении: сглаживание и тёплый старт), каждый кот и обе модели. Замер — по точкам поверхности руки (мм на карте): **как есть** — клип без коррекции, **до** — коррекция 18.11–19.11 (кисть по осям; прокси v1 — из меша, v2 — json), **после** — точки поверхности + контакт (прокси v1 — `public/models/<кот>_v1_colliders.json`). В ячейке: максимум за клип мм (доля кадров > 1 мм). Листы худших кадров — [docs/qa/hands/](hands/) (`<v>_<кот>_<клип>.png`: клип как есть | до | после, анфас и профиль).');
  L.push('');
  const models = [...new Set(S.map((x) => x.v))];
  const cats = [...new Set(S.map((x) => x.cat))];
  const clips = [...new Set(S.map((x) => x.clip))];
  const cell = (x) => (x ? `${x.raw} / ${x.before} (${Math.round(x.over1Before * 100)} %) → **${x.after}** (${Math.round(x.over1After * 100)} %)` : '—');
  for (const v of models) {
    L.push(`### ${v === 'v1' ? 'v1 (?models=v1)' : v === 'v2h' ? 'геометрия v2 (?models=v2h)' : 'v2 (по умолчанию)'} — как есть / до → после, мм`);
    L.push('');
    L.push(`| клип | ${cats.join(' | ')} |`);
    L.push(`|---|${cats.map(() => '---').join('|')}|`);
    for (const c of clips) L.push(`| ${c} | ${cats.map((cat) => cell(S.find((x) => x.v === v && x.cat === cat && x.clip === c))).join(' | ')} |`);
    const all = S.filter((x) => x.v === v);
    const mx = (k) => Math.max(...all.map((x) => x[k]));
    const share = (k) => (all.reduce((a, x) => a + x[k] * x.frames, 0) / all.reduce((a, x) => a + x.frames, 0)) * 100;
    L.push('');
    L.push(`Итого ${v}: максимум ${mx('raw')} / ${mx('before')} → **${mx('after')} мм**; кадров > 1 мм: до ${share('over1Before').toFixed(0)} % → после **${share('over1After').toFixed(1)} %**.`);
    // сетка против сетки (penetration.py)
    const tri = cats.map((cat) => {
      const t = path.join(dir, `tri_${v}_${cat}.md`);
      const m = fs.existsSync(t) && fs.readFileSync(t, 'utf8').match(/до \*\*(\d+)\*\*, после \*\*(\d+)\*\*/);
      return m ? `${cat} ${m[1]} → ${m[2]}` : null;
    }).filter(Boolean);
    if (tri.length) L.push(`Сетка против сетки (пары треугольников рука ↔ голова/уши/наушники/кепка/капюшон/шарф/бант, 12 кадров на клип, \`scripts/models/penetration.py --pose-json\`): ${tri.join('; ')}.`);
    const perf = cats.map((cat) => {
      const read = (n) => (fs.existsSync(path.join(dir, n)) ? JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).perf : null);
      const p1 = read(`${v}_${cat}.json`), p4 = read(`${v}_${cat}_x4.json`);
      return p1 ? `${cat} ${p1.oldMs} → ${p1.newMs} мс (покой ${p1.idleMs})${p4 ? `, ЦП ×4: ${p4.oldMs} → ${p4.newMs} (покой ${p4.idleMs})` : ''}` : null;
    }).filter(Boolean);
    if (perf.length) L.push(`Время коррекции на кадр (headless Chrome, среднее по этим клипам — руки у головы почти весь клип; «ЦП ×4» — CDP-замедление, класс телефона): ${perf.join('; ')}.`);
    L.push('');
  }
  return L;
}

function renderReport(runs, also = null) {
  const [cur, prev] = runs; // runs[0] — последний прогон, runs[1] — «до» (если есть)
  const cats = cur.cats.map((c) => c.cat);
  const ids = [...new Set(cur.cats.flatMap((c) => c.results.map((r) => r.id)))];
  const A = (run, cat, id) => {
    const c = run?.cats.find((x) => x.cat === cat);
    const r = c?.results.find((x) => x.id === id);
    return r ? analyze(r, c.durs, run.cuts) : null;
  };
  const count = (run) => {
    const n = { ok: 0, tol: 0, bad: 0 };
    for (const c of run.cats) for (const r of c.results) n[analyze(r, c.durs, run.cuts).verdict]++;
    return n;
  };
  const L = [];
  L.push('# Реакции кота в пилоте (/mvp): аудит');
  L.push('');
  L.push(`Прогон \`${cur.tag}\` от ${cur.at}${prev ? `, сравнение с \`${prev.tag}\` от ${prev.at}` : ''}. Стенд — \`node scripts/qa/reactions.mjs\` (сборка VITE_EDITION=pilot, \`?from=test&nocard=off&debug\`, headless Chrome, виртуальное время 30 к/с: кадр = 1/30 с, таймеры режиссёра в той же шкале). Контактные листы — [docs/qa/reactions/](reactions/) (\`<кот>_<действие>.png\`, 12 кадров на сценарий: время, клип, эмоция).`);
  L.push('');
  const n = count(cur);
  L.push(`**Итого: ok ${n.ok}, терпимо ${n.tol}, плохо ${n.bad}** (из ${n.ok + n.tol + n.bad})${prev ? (() => { const p = count(prev); return ` — было: ok ${p.ok}, терпимо ${p.tol}, плохо ${p.bad}`; })() : ''}.`);
  L.push('');
  L.push('Что меряем (на каждом кадре 30 к/с):');
  L.push('- **отклик, мс** — от касания/кнопки до первого видимого ответа: тело (ключевая кость повернулась ≥ 0,12 рад от позы в момент события), лицо (вес мимики ≥ 0,25) или эффект; в скобках — тело. Цель ≤ 150 мс.');
  L.push('- **щелчок, рад/с** — пик угловой скорости костей тела в 0,3 с после смены клипа (стык смешивания). ≤ 10,5 ok (инерциальный переход AnimBlender рассчитан на пик ≈ 10 рад/с: быстрая реакция без «телепорта»), ≤ 15 терпимо.');
  L.push('- **лапы, мм** — скольжение опорной лапы по плоскости опоры (лапа ниже 4 мм над опорой два кадра подряд), в масштабе кота на карте (рост кота ≈ 0,9 карты ≈ 77 мм); провал — самая низкая лапа ниже опоры; парение — медиана самой низкой лапы в спокойных клипах.');
  L.push(`- **проникновение, мм** — самая глубокая точка руки или голени/колена внутри прокси тела и одежды (торс, шея, голова, кепка/наушники/шарф/бант/юбка, уши, бёдра/голени другой ноги) после коррекции BodyCollider, мм на карте; > ${PEN_BAD_MM} мм — «плохо». Кисть и предплечье у головы и одежды на ней — по точкам поверхности лапы (16 + 10 на руку, со скином, как видно), о торс/бёдра и плечо/локоть — по точкам на осях костей.`);
  L.push('- **заглушка** — клип играет опорой/псевдонимом (docs/animations/INVENTORY.md: «заглушка»), **обрыв** — реакцию сменили раньше 55 % её длины без нового действия, **драка** — два разных клипа реакции за 400 мс без нового действия, **покой** — кот вернулся в idle к концу записи.');
  L.push('- **лицо** — эмоция/пресет в первые 1,5 с против ожидаемого семейства (FACE_OK в стенде).');
  L.push('');
  L.push('## Сводка: действие × кот');
  L.push('');
  L.push(`| действие | ${cats.map((c) => c).join(' | ')} |`);
  L.push(`|---|${cats.map(() => '---').join('|')}|`);
  for (const id of ids) {
    const cells = cats.map((cat) => {
      const a = A(cur, cat, id);
      if (!a) return '—';
      const b = prev ? A(prev, cat, id) : null;
      const was = b && b.verdict !== a.verdict ? ` (было ${V[b.verdict].replace(/\*/g, '')})` : '';
      return `${V[a.verdict]}${was} · ${a.lat ?? '—'}${a.latBody !== null && a.latBody !== a.lat ? ` (${a.latBody})` : ''} мс · щ ${a.pop} · л ${a.slide}`;
    });
    L.push(`| ${LABEL[id] ?? id} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('В ячейке: вердикт · отклик (тело) · щелчок рад/с · скольжение лап мм.');
  L.push('');
  // проникновение рук/ног в тело и одежду (после коррекции BodyCollider), мм: до → после
  if (cur.cats.some((c) => c.results.some((r) => r.frames?.some((f) => f.penMM !== undefined)))) {
    L.push(`## Проникновение (руки/ноги сквозь тело и одежду), мм — порог «плохо» > ${PEN_BAD_MM} мм`);
    L.push('');
    L.push(`Глубина самой глубокой пары «часть тела : прокси» за сценарий после коррекции (BodyCollider.measurePairs: кисть/предплечье у головы — точки поверхности, прочее — точки на осях; прокси: торс, шея, голова, одежда, уши, бёдра/голени)${prev ? `; «было» — прогон \`${prev.tag}\`` : ''}.`);
    L.push('');
    L.push(`| действие | ${cats.join(' | ')} |`);
    L.push(`|---|${cats.map(() => '---').join('|')}|`);
    for (const id of ids) {
      const cells = cats.map((cat) => {
        const a = A(cur, cat, id);
        if (!a) return '—';
        const b = prev ? A(prev, cat, id) : null;
        const mark = a.penMM > PEN_BAD_MM ? '**' : '';
        return `${mark}${a.penMM}${mark}${b && b.penMM !== undefined ? ` (было ${b.penMM})` : ''}${a.penMM > 0.5 ? ` · ${a.penPair}` : ''}`;
      });
      L.push(`| ${LABEL[id] ?? id} | ${cells.join(' | ')} |`);
    }
    L.push('');
  }
  for (const cat of cats) {
    L.push(`## ${cat}: подробно`);
    L.push('');
    L.push('| действие | вердикт | отклик, мс (тело) | щелчок | бедро | лапы мм | провал / парит мм | проникн., мм | клипы | лицо | покой, с | замечания |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const id of ids) {
      const a = A(cur, cat, id);
      if (!a) continue;
      const b = prev ? A(prev, cat, id) : null;
      const arrow = (x, y) => (b && y !== undefined && y !== null && x !== y ? `${x} (было ${y})` : `${x ?? '—'}`);
      L.push(`| ${LABEL[id] ?? id} | ${V[a.verdict]}${b ? ` (было ${V[b.verdict].replace(/\*/g, '')})` : ''} | ${arrow(a.lat, b?.lat)} (${a.latBody ?? '—'}) | ${arrow(a.pop, b?.pop)} | ${a.hipPop} | ${arrow(a.slide, b?.slide)} | ${a.sink} / ${a.float} | ${a.penMM !== undefined ? arrow(a.penMM, b?.penMM) : `${(a.pen * 100).toFixed(0)}%`} | ${a.clips.join(', ') || '—'} | ${a.emos.slice(0, 3).join(', ') || '—'} | ${a.idleAt !== null ? (a.idleAt / 1000).toFixed(1) : '—'} | ${a.notes.join('; ') || '—'} |`);
    }
    L.push('');
  }
  // вторая пара прогонов (--also before,after[,axis]): другие модели (?models=v1) — проникновение и щелчки до → после
  for (const g of also ?? []) L.push(...alsoSection(g));
  L.push(...handsSection());
  // что исправлено и какие клипы нужны от Meshy — ручной раздел (docs/animations/REACTIONS_FIXES.md)
  const notes = path.join(root, 'docs/animations/REACTIONS_FIXES.md');
  if (fs.existsSync(notes)) L.push('', fs.readFileSync(notes, 'utf8').trim());
  return L.join('\n') + '\n';
}

// ───────────── main ─────────────
async function main() {
  if (flag('--report')) {
    const tags = arg('--report').split(',');
    const runs = tags.reverse().map((t) => JSON.parse(fs.readFileSync(path.join(OUT, `${t}.json`), 'utf8')));
    // --also "a,b[,c];d,e[,f]" — несколько пар прогонов
    const also = arg('--also', '') ? arg('--also').split(';').map((g) => g.split(',').map((t) => JSON.parse(fs.readFileSync(path.join(OUT, `${t}.json`), 'utf8')))) : null;
    fs.writeFileSync(REPORT, renderReport(runs, also));
    log(`отчёт: ${path.relative(root, REPORT)}`);
    return;
  }
  if (!flag('--no-build')) build();
  const srv = serve();
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    protocolTimeout: 600000,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const run = { tag: TAG, at: new Date().toISOString().slice(0, 16).replace('T', ' '), cuts: [...catalogCuts()], cats: [] };
  try {
    for (const cat of CATS) {
      const t0 = Date.now();
      run.cats.push(await runCat(browser, cat));
      log(`[${cat}] готово за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
    }
  } finally {
    await browser.close();
    srv.close();
  }
  // --merge: дописать/заменить сценарии в уже сохранённом прогоне (перепрогон части сценариев)
  const file = path.join(OUT, `${TAG}.json`);
  if (flag('--merge') && fs.existsSync(file)) {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const c of run.cats) {
      const oc = old.cats.find((x) => x.cat === c.cat);
      if (!oc) old.cats.push(c);
      else for (const r of c.results) {
        const i = oc.results.findIndex((x) => x.id === r.id);
        if (i >= 0) oc.results[i] = r;
        else oc.results.push(r);
      }
    }
    Object.assign(run, old);
  }
  fs.writeFileSync(file, JSON.stringify(run));
  const prevTag = arg('--vs', null);
  const runs = [run];
  if (prevTag && fs.existsSync(path.join(OUT, `${prevTag}.json`))) runs.push(JSON.parse(fs.readFileSync(path.join(OUT, `${prevTag}.json`), 'utf8')));
  if (!ONLY) fs.writeFileSync(REPORT, renderReport(runs));
  log(`готово: ${path.relative(root, file)}${ONLY ? '' : ', ' + path.relative(root, REPORT)}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => (console.error(e), process.exit(1)));
