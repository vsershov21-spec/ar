/**
 * Офлайн-стенд трекера карты: синтетические сцены (движение, блик, рука, быстрые повороты — с «гироскопом»)
 * и записи с iPhone (кадры через ffmpeg). Эмулирует главный поток: камера 30 к/с с задержкой, воркер с задержкой
 * (кадр шлём, когда воркер свободен), рендер 60 к/с. Сессия (старая или новая логика) решает, где кот.
 *
 * Метрики (кадр детектора 320 px по длинной стороне):
 *  - jitter — дрожание в покое: RMS отклонения углов кота от их среднего, px (камера неподвижна);
 *  - err / p90 — «отлипание»: расстояние углов кота от настоящих углов карты в момент показа, px (среднее, 90-й перцентиль);
 *  - locked — доля кадров рендера после первой посадки, когда карта ведётся (LOCKED);
 *  - falseLoss — сколько раз «карта потеряна» (уход из ведения), хотя карта целиком в кадре;
 *  - tLock — время до посадки, с.
 * Для записей с iPhone истинных углов нет: jitterIdx — RMS второй разности углов кота между кадрами камеры (px),
 * плюс locked, число потерь и пересадок.
 */
import * as THREE from 'three';
import { spawn } from 'node:child_process';
import { CARD_ASPECT, type Intrinsics, type Pt } from '../../src/tracker/card/geometry';
import { CardPipeline, type PipelineOut } from '../../src/tracker/card/pipeline';
import { focalFromFov } from '../../src/tracker/card/detector';
import { camMatrix, renderCardScene, sceneCorners, type SynthOptions } from './synthCard';

export interface SessionRequest {
  lock: boolean;
  hint: Pt[] | null;
  hintRadius?: number;
  reset?: boolean;
  rot?: number[] | null;
  detectEvery?: number;
  /** прежний воркер: без ключевого кадра и гироскопа */
  legacy?: boolean;
}

export interface BenchSession {
  readonly name: string;
  state: string;
  /** карта ведётся (LOCKED) */
  tracking: boolean;
  events: { t: number; ev: string }[];
  request(t: number, q: THREE.Quaternion | null): SessionRequest;
  onResult(r: PipelineOut, cap: { t: number; q: THREE.Quaternion | null }, K: Intrinsics, ctx: { angSpeed: number; now: number; q: THREE.Quaternion | null }): void;
  frame(t: number, dt: number, qNow: THREE.Quaternion | null): void;
  /** поза якоря в системе камеры (null — кота нет) */
  display(): THREE.Matrix4 | null;
}

export interface Scenario {
  name: string;
  duration: number;
  verify: boolean;
  w: number;
  h: number;
  /** кадр камеры, показывающий мир в момент t */
  frame(t: number, i: number): Promise<Uint8ClampedArray | null> | Uint8ClampedArray | null;
  /** истинные углы карты в момент t (синтетика) */
  gt?(t: number): Pt[];
  /** поворот камеры в момент t (гироскоп); нет — гироскопа нет */
  rot?(t: number): [number, number, number];
  /** окно покоя для дрожания, с */
  still?: [number, number];
  focal: number;
}

const q3 = (a: [number, number, number]) => new THREE.Quaternion().setFromRotationMatrix(m4(camMatrix(a)));
function m4(R: number[]) {
  return new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
}

/** синтетическая сцена: базовые параметры + изменения во времени */
export function synthScenario(name: string, duration: number, base: SynthOptions, at: (t: number) => Partial<SynthOptions>, extra: Partial<Scenario> = {}): Scenario {
  const w = base.w ?? 320, h = base.h ?? 240;
  const opts = (t: number): SynthOptions => ({ tableOnPlane: true, noise: 2.5, blur: 1, seed: 3, ...base, ...at(t) });
  return {
    name,
    duration,
    verify: false,
    w,
    h,
    focal: focalFromFov(w, h, base.hfov ?? 63),
    frame: (t, i) => renderCardScene({ ...opts(t), noiseSeed: i + 1 }).rgba,
    gt: (t) => sceneCorners(opts(t)),
    rot: base.camRot || at(0).camRot ? (t) => (opts(t).camRot ?? [0, 0, 0]) : undefined,
    ...extra,
  };
}

/** кадры записи (ffmpeg → RGBA, длинная сторона 320 px, 15 к/с) */
export async function videoScenario(name: string, file: string, from: number, duration: number): Promise<Scenario> {
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [vw, vh] = probe.toString().trim().split(',').map(Number);
  const k = 320 / Math.max(vw, vh);
  const w = Math.round((vw * k) / 2) * 2, h = Math.round((vh * k) / 2) * 2;
  const raw = await run('ffmpeg', ['-v', 'error', '-ss', String(from), '-t', String(duration), '-i', file, '-vf', `fps=30,scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const n = Math.floor(raw.length / (w * h * 4));
  return {
    name,
    duration: n / 30,
    verify: true,
    w,
    h,
    focal: focalFromFov(w, h),
    frame: (_t, i) => (i < n ? new Uint8ClampedArray(raw.buffer, raw.byteOffset + i * w * h * 4, w * h * 4).slice() : null),
  };
}

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res(Buffer.concat(chunks)) : rej(new Error(cmd + ' ' + code))));
  });
}

export interface BenchOpts {
  /** задержка камеры (кадр показывает мир camLat назад), с */
  camLat?: number;
  /** время обработки кадра в воркере, с */
  workerLat?: number;
  /** шум гироскопа, градусы */
  gyroNoise?: number;
}

export interface BenchResult {
  scenario: string;
  session: string;
  tLock: number;
  locked: number;
  falseLoss: number;
  losses: number;
  reanchors: number;
  jitter: number;
  err: number;
  p90: number;
  jitterIdx: number;
  frames: number;
  states: Record<string, number>;
}

/** углы модели карты, спроецированные позой якоря (кадр детектора) */
export function anchorQuad(m: THREE.Matrix4, K: Intrinsics): Pt[] | null {
  const e = m.elements;
  const hw = 0.5, hh = 0.5 / CARD_ASPECT;
  const out: Pt[] = [];
  for (const [X, Y] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
    const x = e[0] * X + e[4] * Y + e[12], y = e[1] * X + e[5] * Y + e[13], z = e[2] * X + e[6] * Y + e[14];
    if (z > -1e-3) return null;
    // эталон synthCard: центры пикселей — целые (−0,5)
    out.push({ x: K.cx + (K.f * x) / -z - 0.5, y: K.cy - (K.f * y) / -z - 0.5 });
  }
  return out;
}

function bestAlign(a: Pt[], b: Pt[]): Pt[] {
  let best = 0, bv = Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += Math.hypot(a[(j + k) % 4].x - b[j].x, a[(j + k) % 4].y - b[j].y);
    if (s < bv) (bv = s), (best = k);
  }
  return [0, 1, 2, 3].map((j) => a[(j + best) % 4]);
}

function quadErr(a: Pt[], b: Pt[]): number {
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += Math.hypot(a[(j + k) % 4].x - b[j].x, a[(j + k) % 4].y - b[j].y);
    best = Math.min(best, s / 4);
  }
  return best;
}

export async function runBench(sc: Scenario, mk: () => BenchSession, o: BenchOpts = {}): Promise<BenchResult> {
  const camLat = o.camLat ?? 0.033, workerLat = o.workerLat ?? 0.045;
  const s = mk();
  const pipe = new CardPipeline();
  const K: Intrinsics = { f: sc.focal, cx: sc.w / 2, cy: sc.h / 2 };
  const dt = 1 / 60;
  let rnd = 99;
  const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * (o.gyroNoise ?? 0.15);
  const qAt = (t: number) => (sc.rot ? q3(sc.rot(t).map((x) => x + noise()) as [number, number, number]) : null);
  let busyUntil = -1, lastSent = -1;
  let pending: { due: number; out: PipelineOut | null; capT: number } | null = null;
  let qPrevSent: THREE.Quaternion | null = null;
  let firstLock = -1;
  let lockedTicks = 0, ticks = 0, falseLoss = 0, losses = 0;
  let wasTracking = false;
  const errs: number[] = [];
  const stillPts: Pt[][] = [];
  const camQuads: Pt[][] = [];
  const states: Record<string, number> = {};
  let lastCamDisp = -1;
  for (let t = 0; t < sc.duration; t += dt) {
    const qNow = qAt(t);
    // ответ воркера
    if (pending && t >= pending.due) {
      if (pending.out) s.onResult(pending.out, { t: pending.capT, q: null }, K, { angSpeed: angSpeed(sc, t), now: t * 1000, q: qNow });
      pending = null;
    }
    // новый кадр камеры → воркер
    const ci = Math.floor((t - camLat) * 30);
    if (!pending && t >= busyUntil && ci > lastSent && ci >= 0) {
      const tc = ci / 30;
      const rgba = await sc.frame(tc, ci);
      lastSent = ci;
      if (rgba) {
        const req = s.request(t, qNow);
        const out = pipe.process({ rgba, w: sc.w, h: sc.h, focal: K.f, lock: req.lock, hint: req.hint, hintRadius: req.hintRadius, reset: req.reset, rot: req.rot ?? null, verify: sc.verify, detectEvery: req.detectEvery, legacy: req.legacy });
        pending = { due: t + workerLat, out, capT: t };
        busyUntil = t + workerLat;
        qPrevSent = qNow;
      }
    }
    void qPrevSent;
    s.frame(t, dt, qNow);
    states[s.state] = (states[s.state] ?? 0) + 1;
    if (s.tracking && firstLock < 0) firstLock = t;
    if (firstLock >= 0) {
      ticks++;
      if (s.tracking) lockedTicks++;
      const gt = sc.gt?.(t);
      const inFrame = gt ? gt.every((p) => p.x > 2 && p.y > 2 && p.x < sc.w - 3 && p.y < sc.h - 3) : true;
      if (wasTracking && !s.tracking) {
        losses++;
        if (gt && inFrame) falseLoss++;
      }
      const m = s.display();
      const dq = m ? anchorQuad(m, K) : null;
      if (gt && dq && inFrame) {
        const e = quadErr(dq, gt);
        errs.push(e);
        // дрожание относительно карты: отклонение углов кота от настоящих (без постоянного смещения)
        if (sc.still && t >= sc.still[0] && t <= sc.still[1]) stillPts.push(bestAlign(dq, gt).map((p, k) => ({ x: p.x - gt[k].x, y: p.y - gt[k].y })));
      }
      // для записей: углы кота на кадрах камеры (30 к/с)
      const cf = Math.floor(t * 30);
      if (cf !== lastCamDisp) {
        lastCamDisp = cf;
        camQuads.push(dq && s.tracking ? dq : []);
      }
    }
    wasTracking = s.tracking;
  }
  errs.sort((a, b) => a - b);
  // дрожание в покое: RMS отклонения от среднего
  let jitter = NaN;
  if (stillPts.length > 5) {
    const mean = [0, 1, 2, 3].map((k) => ({ x: avg(stillPts.map((q) => q[k].x)), y: avg(stillPts.map((q) => q[k].y)) }));
    jitter = Math.sqrt(avg(stillPts.flatMap((q) => q.map((p, k) => (p.x - mean[k].x) ** 2 + (p.y - mean[k].y) ** 2))));
  }
  // индекс дрожания: вторая разность по кадрам камеры (сопоставляем углы по ближайшему повороту нумерации)
  const d2: number[] = [];
  for (let i = 1; i + 1 < camQuads.length; i++) {
    const a = camQuads[i - 1], b = camQuads[i], c = camQuads[i + 1];
    if (a.length !== 4 || b.length !== 4 || c.length !== 4) continue;
    for (let k = 0; k < 4; k++) d2.push(((a[k].x + c[k].x) / 2 - b[k].x) ** 2 + ((a[k].y + c[k].y) / 2 - b[k].y) ** 2);
  }
  return {
    scenario: sc.name,
    session: s.name,
    tLock: firstLock,
    locked: ticks ? lockedTicks / ticks : 0,
    falseLoss,
    losses,
    reanchors: s.events.filter((e) => e.ev === 'reanchor').length,
    jitter,
    err: errs.length ? avg(errs) : NaN,
    p90: errs.length ? errs[Math.floor(errs.length * 0.9)] : NaN,
    jitterIdx: d2.length ? Math.sqrt(avg(d2)) : NaN,
    frames: ticks,
    states,
  };
}

function angSpeed(sc: Scenario, t: number) {
  if (!sc.rot) return NaN;
  const a = q3(sc.rot(t)), b = q3(sc.rot(t - 0.05));
  return a.angleTo(b) / 0.05;
}

const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);

/** набор синтетических сцен стенда */
export function synthScenarios(): Scenario[] {
  const base: SynthOptions = { w: 320, h: 240, tilt: 35, yaw: 8, dist: 2.4, bg: 'wood', card: { rgb: [33, 160, 56], design: 'doodle' } };
  const ease = (t: number, a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));
  return [
    // 1. телефон неподвижен — дрожание в покое
    // (лёгкий тремор руки ~0,2° на 7–11 Гц — как у телефона в руке ребёнка)
    synthScenario('покой', 4, base, (t) => ({ camRot: [0.15 * Math.sin(t * 47) + 0.1 * Math.sin(t * 71), 0.2 * Math.sin(t * 53 + 1), 0] }), { still: [2, 4] }),
    // 2. рука качает телефон: поворот ±7° с частотой ~1 Гц (до ~45°/с) — «отлипание»
    synthScenario('покачивание', 5, base, (t) => ({ camRot: t < 1.5 ? [0, 0, 0] : [4 * Math.sin((t - 1.5) * 6.5), 7 * Math.sin((t - 1.5) * 5.2), 0] })),
    // 3. быстрый поворот: 12° за 0,2 с и обратно (≈ 60°/с)
    synthScenario('быстрый поворот', 5, base, (t) => {
      const k = ease(t, 2, 2.2) - ease(t, 3.2, 3.4);
      return { camRot: [0, 12 * k, 3 * k] };
    }),
    // 4. рука закрывает часть карты (кот сидит, ребёнок тянется к карте)
    synthScenario('рука на карте', 5, base, (t) => ({ fingerAt: t > 1.8 && t < 3.8 ? { x: 0.5 + 0.1 * Math.sin(t * 3), y: 0.5, r: 0.07 } : undefined, camRot: [0, 2 * Math.sin(t * 2), 0] })),
    // 5. блик на карте + медленное движение телефона
    synthScenario('блик', 5, { ...base, glare: true }, (t) => ({ camRot: [1.5 * Math.sin(t * 2.2), 3 * Math.sin(t * 1.7), 0] })),
    // 6. увели камеру с карты (карта уходит за край) и вернули
    synthScenario('увод и возврат', 6, base, (t) => {
      const k = ease(t, 1.8, 2.6) - ease(t, 3.6, 4.4);
      return { camRot: [0, -32 * k, 0] };
    }),
  ];
}
