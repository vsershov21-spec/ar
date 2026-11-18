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
import type { CropIn } from '../../src/tracker/card/verifier';
import { focalFromFov } from '../../src/tracker/card/detector';
import { camMatrix, renderCardScene, sceneCorners, type SynthOptions } from './synthCard';

export interface SessionRequest {
  lock: boolean;
  hint: Pt[] | null;
  hintRadius?: number;
  reset?: boolean;
  rot?: number[] | null;
  lostMs?: number;
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
  /**
   * Кадр камеры в большем разрешении (×hiK): тогда кадр детектора — его уменьшение, а к кадрам до посадки
   * прикладывается фрагмент вокруг карты для проверки «Сбер» — как в CardTracker.cropRect.
   */
  hi?(t: number, i: number): Promise<Uint8ClampedArray> | Uint8ClampedArray;
  hiK?: number;
}

/** уменьшение кадра в k раз (среднее k × k) */
export function downsample(src: Uint8ClampedArray, w: number, h: number, k: number): Uint8ClampedArray {
  const W = Math.floor(w / k), H = Math.floor(h / k);
  const out = new Uint8ClampedArray(W * H * 4);
  const n = k * k;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * w + x * k + dx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
        }
      const o = (y * W + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  return out;
}

/** фрагмент кадра вокруг прошлой карты (копия логики CardTracker.cropRect: до 280 px на карту, ≤ 420 px по стороне) */
export function benchCrop(hi: Uint8ClampedArray, k: number, dw: number, dh: number, q: Pt[], full = 0): CropIn | null {
  let x0 = Math.min(...q.map((p) => p.x)), x1 = Math.max(...q.map((p) => p.x));
  let y0 = Math.min(...q.map((p) => p.y)), y1 = Math.max(...q.map((p) => p.y));
  const mx = full ? 0 : (x1 - x0) * 0.25 + 4, my = full ? 0 : (y1 - y0) * 0.25 + 4;
  x0 = Math.max(0, Math.floor(x0 - mx));
  y0 = Math.max(0, Math.floor(y0 - my));
  x1 = Math.min(dw, Math.ceil(x1 + mx));
  y1 = Math.min(dh, Math.ceil(y1 + my));
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const side = (i: number) => Math.hypot(q[i].x - q[(i + 1) % 4].x, q[i].y - q[(i + 1) % 4].y);
  const long = Math.max(side(0), side(1));
  let s = full ? Math.min(k, full / Math.max(w, h)) : Math.min(k, Math.max(1, 280 / Math.max(1, long)));
  if (!full) s = Math.min(s, 420 / Math.max(w, h));
  if (s < 1.3) return null;
  const cw = Math.round(w * s), ch = Math.round(h * s);
  // ресэмплинг из кадра ×k (билинейно)
  const W = dw * k, rgba = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(W - 1.001, Math.max(0, (x0 + ((x + 0.5) / cw) * w) * k - 0.5)), sy = Math.min(dh * k - 1.001, Math.max(0, (y0 + ((y + 0.5) / ch) * h) * k - 0.5));
      const xi = sx | 0, yi = sy | 0, fx = sx - xi, fy = sy - yi;
      const a = (yi * W + xi) * 4, b = a + 4, c = a + W * 4, d = c + 4;
      const o = (y * cw + x) * 4;
      for (let ch2 = 0; ch2 < 3; ch2++) rgba[o + ch2] = (hi[a + ch2] * (1 - fx) + hi[b + ch2] * fx) * (1 - fy) + (hi[c + ch2] * (1 - fx) + hi[d + ch2] * fx) * fy;
      rgba[o + 3] = 255;
    }
  return { img: { rgba, w: cw, h: ch }, x0, y0, w, h };
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
  /** остановиться через столько секунд после первой посадки */
  stopAfterLock?: number;
  /** время воркера по этапам (мс) — копится сюда */
  prof?: { frames: number; ms: number[] };
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
  /** с какой проверкой посадили: по знаку/дизайну (verified) или «по форме» после терпения */
  verified?: boolean;
  /** номер дизайна, узнанного по отпечатку (последний кадр проверки), −1 — нет */
  design?: number;
  /** доля кадров рендера (карта целиком в кадре, кот показан), где кот дальше 0,3 диагонали от карты — «сидит не там» */
  farFrac?: number;
  /** доля кадров рендера, когда карта целиком в кадре, а кота нет (после первой посадки) */
  hiddenFrac?: number;
  /** события «карта потеряна» */
  lostEvents?: number;
  /** среднее время этапов воркера на кадр, мс */
  stages?: Record<string, number>;
  /** время воркера до посадки (search) и после (locked): кадров, среднее, p95 */
  msBy?: Record<string, { n: number; mean: number; p95: number }>;
  /** время воркера на кадр, мс: среднее и p95 */
  workerMs?: number;
  workerP95?: number;
  /** до посадки: доля ответов воркера с картой рядом с настоящей (≤ 0,06 диагонали); доля кадров полного поиска, где
   *  карта — первый кандидат / есть среди кандидатов */
  preHit?: number;
  verN?: number;
  sberAt?: number;
  detTop?: number;
  detAny?: number;
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
  let prevQuad: Pt[] | null = null;
  let cropAt = -1e9;
  let nextDetect = true;
  let lastDesign = -1;
  const wms: number[] = [];
  let visTicks = 0, hiddenTicks = 0, farTicks = 0;
  const stg: Record<string, number> = {};
  let stgN = 0;
  const stgBy: Record<string, { n: number; ms: number[] }> = {};
  let verN = 0, sberAt = -1;
  let preN = 0, preHit = 0, detN = 0, detTop = 0, detAny = 0;
  const near = (q: Pt[] | null | undefined, gt: Pt[] | undefined) => !!q && !!gt && quadErr(q, gt) < 0.06 * Math.hypot(gt[0].x - gt[2].x, gt[0].y - gt[2].y);
  for (let t = 0; t < sc.duration; t += dt) {
    if (o.stopAfterLock !== undefined && firstLock >= 0 && t - firstLock > o.stopAfterLock) break;
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
      let rgba: Uint8ClampedArray | null;
      let crop: CropIn | null = null;
      if (sc.hi) {
        const k = sc.hiK ?? 2;
        const hi = await sc.hi(tc, ci);
        rgba = downsample(hi, sc.w * k, sc.h * k, k);
        // фрагмент под проверку — как в CardTracker: по прошлой карте, до посадки не чаще 80 мс, после — раз в секунду
        const anch = s.state === 'locked' || s.state === 'hold' || s.state === 'relocalize';
        const lostA = s.state === 'hold' || s.state === 'relocalize';
        const cropDue = lostA ? t * 1000 - cropAt >= 200 : anch ? t * 1000 - cropAt >= 1000 : t * 1000 - cropAt >= (nextDetect ? 40 : 300);
        if (sc.verify && lostA && cropDue) {
          // как CardTracker.cropRect при потере: весь кадр крупнее (до 600 px по длинной стороне)
          const full = [{ x: 0, y: 0 }, { x: sc.w, y: 0 }, { x: sc.w, y: sc.h }, { x: 0, y: sc.h }];
          crop = benchCrop(hi, k, sc.w, sc.h, full, 600);
          if (crop) cropAt = t * 1000;
        } else if (sc.verify && prevQuad && cropDue) {
          crop = benchCrop(hi, k, sc.w, sc.h, prevQuad);
          if (crop) cropAt = t * 1000;
        }
      } else rgba = await sc.frame(tc, ci);
      lastSent = ci;
      if (rgba) {
        const req = s.request(t, qNow);
        const out = pipe.process({ rgba, w: sc.w, h: sc.h, focal: K.f, lock: req.lock, hint: req.hint, hintRadius: req.hintRadius, reset: req.reset, rot: req.rot ?? null, lostMs: req.lostMs, verify: sc.verify, detectEvery: req.detectEvery, legacy: req.legacy, crop });
        if (out) {
          wms.push(out.ms);
          if (out.stages) {
            for (const [k, v] of Object.entries(out.stages)) stg[k] = (stg[k] ?? 0) + v;
            stgN++;
            // этапы по режиму кадра: до посадки (поиск + проверка) и после (ведение)
            const tag = s.tracking ? 'locked' : 'search';
            const b = (stgBy[tag] ??= { n: 0, ms: [] as number[] });
            b.n++;
            b.ms.push(out.ms);
          }
          if (o.prof) o.prof.frames++;
          nextDetect = out.detNext ?? true;
          prevQuad = out.quad ?? (s.state === 'locked' || s.state === 'hold' || s.state === 'relocalize' ? prevQuad : null);
          if (out.ver?.checked) lastDesign = out.ver.design ?? -1;
          if (firstLock < 0 && out.ver?.checked) verN++;
          if (sberAt < 0 && out.ver?.state === 'sber') sberAt = t;
          if (firstLock < 0 && sc.gt) {
            const gt = sc.gt(tc);
            preN++;
            if (near(out.quad, gt)) preHit++;
            if (pipe.det.ranDetect) {
              detN++;
              const cs = pipe.det.lastCandidates;
              if (near(cs[0]?.quad, gt)) detTop++;
              if (cs.some((c) => near(c.quad, gt))) detAny++;
            }
          }
        }
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
      if (gt && inFrame) {
        visTicks++;
        if (!dq) hiddenTicks++;
      }
      if (gt && dq && inFrame) {
        const e = quadErr(dq, gt);
        errs.push(e);
        if (e > 0.3 * Math.hypot(gt[0].x - gt[2].x, gt[0].y - gt[2].y)) farTicks++;
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
    verified: (s as { verified?: boolean }).verified,
    design: lastDesign,
    farFrac: errs.length ? farTicks / errs.length : NaN,
    hiddenFrac: visTicks ? hiddenTicks / visTicks : NaN,
    lostEvents: s.events.filter((e) => e.ev === 'lost').length,
    stages: stgN ? Object.fromEntries(Object.entries(stg).map(([k, v]) => [k, v / stgN])) : undefined,
    msBy: Object.fromEntries(Object.entries(stgBy).map(([k, v]) => [k, { n: v.n, mean: avg(v.ms), p95: [...v.ms].sort((a, b) => a - b)[Math.floor(v.ms.length * 0.95)] }])),
    workerMs: wms.length ? avg(wms) : NaN,
    workerP95: wms.length ? [...wms].sort((a, b) => a - b)[Math.floor(wms.length * 0.95)] : NaN,
    verN,
    sberAt,
    preHit: preN ? preHit / preN : NaN,
    detTop: detN ? detTop / detN : NaN,
    detAny: detN ? detAny / detN : NaN,
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
