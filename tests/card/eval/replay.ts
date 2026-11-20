/**
 * Оценка трекера карты по записям (docs/qa/CARD_MATRIX.md, `npm run card:eval`): клип кадр за кадром проходит через
 * НАСТОЯЩИЙ конвейер — воркер (CardPipeline) и ядро главного потока (CardSession) — с эмуляцией телефона:
 *   - кадр камеры появляется на экране в момент frameTime(i) (на экране — именно он, его же берёт трекер);
 *   - в воркер уходит последний показанный кадр, когда воркер свободен; время воркера = мс этого ноутбука × phoneK
 *     (iPhone в 2–3 раза медленнее Node на ноутбуке), не меньше minWorkerMs;
 *   - ориентация телефона — из записи (гироскоп из сайдкара ?rec) или синтетики; на кадр — как в CardTracker
 *     (history.at(кадр − camLatMs));
 *   - рендер 60 к/с: поза кота — CardSession.frame с той ориентацией, что передаёт CardTracker.
 * Эталон углов карты на каждом кадре — разметка (gt) или «оракул»: тот же конвейер без задержки на КАЖДОМ кадре,
 * сглаженный без запаздывания (по соседним кадрам). С оракулом метрика — «насколько кот отстаёт / плавает
 * относительно того, что трекер видит в этом кадре» (ошибки, общие обоим, не видны); с разметкой — абсолютная.
 *
 * Чистая логика без fs/ffmpeg — её же гоняют тесты (tests/card/eval.test.ts) на синтетике с истинными углами.
 */
import * as THREE from 'three';
import { CardPipeline, type PipelineOut } from '../../../src/tracker/card/pipeline';
import * as sessionMod from '../../../src/tracker/card/session';
import { CardSession, OrientationHistory } from '../../../src/tracker/card/session';
import { CARD_ASPECT, applyH, homography, invert3, labelCard, poseFromQuad, projectPoint, quadDiag, type Pt, type Quad } from '../../../src/tracker/card/geometry';
import type { CropIn } from '../../../src/tracker/card/verifier';
import { benchCrop, downsample } from '../../helpers/cardBench';

/** ширина карты ID-1, мм */
export const CARD_MM = 85.6;

export interface FrameReader {
  /** кадр i в разрешении ×hiK (номера — по возрастанию; пропущенные читаются и отбрасываются); null — кадров больше нет */
  get(i: number): Promise<Uint8ClampedArray | null> | Uint8ClampedArray | null;
  close?(): void;
}

export interface EvalClip {
  name: string;
  /** кадр детектора (длинная сторона 320, как CardTracker) */
  w: number;
  h: number;
  /** кадр источника = (w·hiK) × (h·hiK); из него — кадр детектора и фрагмент под проверку «Сбер» */
  hiK: number;
  /** число кадров */
  n: number;
  /** момент, с которого кадр i на экране (и его можно взять в воркер), с */
  frameTime: (i: number) => number;
  frames: () => FrameReader;
  /** фокус в px кадра детектора — с него начинает сессия (как сохранённый/по умолчанию в CardTracker) */
  focal: number;
  /** проверка «карта Сбера» (false — ?anycard) */
  verify?: boolean;
  /** в кадре нет карты Сбера: любая посадка — ложная */
  negative?: boolean;
  /** истинные углы карты на кадре i (px детектора, TL TR BR BL) — разметка или синтетика */
  gt?: (i: number) => Quad | null;
  /** отсчёты гироскопа: время (с, та же шкала, что frameTime) и ориентация камеры в мире (x, y, z, w) */
  gyro?: { t: number; q: [number, number, number, number] }[];
  /** карта целиком вошла в кадр (с) — от него «время до посадки»; нет — по эталону */
  enterAt?: number;
  /** истинный фокус (px детектора, синтетика): тогда считается и ошибка «головы» кота — точки в 6 см над картой */
  trueFocal?: number;
}

export interface ReplayOpts {
  /** мс ноутбука → мс телефона */
  phoneK?: number;
  /** время воркера на кадр, мс, постоянное (детерминированный прогон тестов); нет — мс этого компьютера × phoneK */
  workerMs?: number;
  minWorkerMs?: number;
  /** задержка камеры, с которой начинает трекер (CardTracker.camLatMs / ?camlat) */
  camLatMs?: number;
  /** задержка задана (?camlat=N): без самооценки */
  fixedLat?: boolean;
  /** оракул (эталон без разметки) — посчитанный заранее: oracleQuads(clip) */
  oracle?: ((Quad | null)[] & { firstSeen?: number }) | null;
  /** что показывать: ориентация для кадра рендера — 'auto' (как CardTracker этой версии), 'now' или 'frame' */
  display?: 'auto' | 'now' | 'frame';
  /** вызывается на каждом ответе воркера (диагностика) */
  onResult?: (i: number, out: PipelineOut, s: CardSession) => void;
  /** вызывается на каждом кадре рендера с позой кота (диагностика) */
  onRender?: (t: number, frame: number, shown: Quad | null, ref: Quad | null, s: CardSession) => void;
}

export interface ClipMetrics {
  clip: string;
  negative: boolean;
  frames: number;
  duration: number;
  ref: 'gt' | 'oracle' | 'none';
  /** время до первой посадки от входа карты в кадр, с (NaN — не сел) */
  timeToLand: number;
  landings: number;
  /** посадки на негативе или «не туда» (дальше 0,3 диагонали от эталона) */
  falseLandings: number;
  /** уходов из ведения (LOCKED → HOLD) при карте целиком в кадре */
  losses: number;
  /** кот скрыт или «не там» (дальше 0,3 диагонали) при карте в кадре — эпизоды и время восстановления, с */
  visibleLosses: number;
  recovery: number[];
  /** после повторной посадки кот оказался не на карте (дальше 0,3 диагонали) — «пересадка не туда» */
  wrongPlace: number;
  reanchors: number;
  lostEvents: number;
  /** доля кадров рендера после первой посадки, когда карта ведётся (LOCKED) */
  lockedFrac: number;
  /** ошибка положения кота относительно эталона: мм на плоскости карты (среднее углов), p50 / p90 / max */
  errMm: { p50: number; p90: number; max: number; mean: number };
  /** то же в px кадра детектора */
  errPx: { p50: number; p90: number; mean: number };
  /** дрожание: RMS высокочастотной части ошибки (минус скользящее среднее ±5 кадров), мм и px */
  jitterMm: number;
  jitterPx: number;
  /** масштаб кота относительно карты (корень площади показанного четырёхугольника на плоскости карты), % от 1: p90 |·|, среднее со знаком */
  scaleErr: { p90: number; mean: number; max: number };
  /** доля кадров рендера (кот показан, карта в кадре), где кот в пределах ±5 мм */
  within5mm: number;
  /** «голова» кота (точка в 0,7 ширины карты над центром): ошибка на экране, мм в её плоскости (нужен trueFocal), p50 / p90 */
  headMm: { p50: number; p90: number };
  /** время воркера на кадр (мс этого компьютера): среднее, p50, p95; до и после посадки */
  cpu: { mean: number; p50: number; p95: number; preLand: number; postLand: number; stages: Record<string, number> };
  /** частота ответов воркера в эмуляции, Гц */
  workerHz: number;
  /** фокус в конце (самокалибровка), px детектора */
  focalEnd: number;
  /** задержка камеры в конце (самооценка), мс */
  camLatEnd: number;
  /**
   * «Кот вверх ногами»: доля кадров рендера с котом, где нормаль карты (ось роста кота) на экране смотрит вниз
   * (y нормали в системе камеры < −0,25 — телефон над столом так не держат; это зеркальное решение позы),
   * и число переворотов нормали (> 60° между соседними кадрами рендера).
   */
  upsideFrac: number;
  normalFlips: number;
  states: Record<string, number>;
  log: string[];
}

const quat = (q: [number, number, number, number]) => new THREE.Quaternion(q[0], q[1], q[2], q[3]);

/** CardTracker этой версии показывает кота с ориентацией на момент съёмки показанного кадра (session.ts DISPLAY_AT_FRAME) */
function displayMode(o: ReplayOpts): 'now' | 'frame' {
  if (o.display && o.display !== 'auto') return o.display;
  return (sessionMod as { DISPLAY_AT_FRAME?: boolean }).DISPLAY_AT_FRAME ? 'frame' : 'now';
}

/** гироскоп клипа как поток: отсчёты с t ≤ now — в историю */
class GyroFeed {
  private i = 0;
  readonly hist = new OrientationHistory();
  last: THREE.Quaternion | null = null;
  private speed = 0;
  private lastT = 0;
  constructor(private s: EvalClip['gyro']) {}
  advance(now: number) {
    const s = this.s;
    if (!s) return;
    while (this.i < s.length && s[this.i].t <= now) {
      const g = s[this.i++];
      const q = quat(g.q);
      if (this.last && g.t > this.lastT) {
        const dt = Math.max(0.012, g.t - this.lastT);
        this.speed += (this.last.angleTo(q) / dt - this.speed) * 0.3;
      }
      this.last = q;
      this.lastT = g.t;
      this.hist.push(g.t * 1000, q);
    }
  }
  /** как OrientationHold.angularSpeed */
  get angularSpeed() {
    return this.last ? this.speed : NaN;
  }
  at(tSec: number) {
    return this.s ? this.hist.at(tSec * 1000) : null;
  }
}

/** кадр, показанный на экране в момент t (последний с frameTime ≤ t), −1 — ещё нет */
function shownFrame(clip: EvalClip, t: number, from: number): number {
  let i = from;
  while (i + 1 < clip.n && clip.frameTime(i + 1) <= t) i++;
  return clip.frameTime(Math.max(0, i)) <= t ? i : -1;
}

/** фрагмент под проверку — копия логики CardTracker.cropRect */
class CropPolicy {
  at = -1e9;
  pick(clip: EvalClip, hi: Uint8ClampedArray, s: CardSession, prevQuad: Quad | null, nextDetect: boolean, nowMs: number): CropIn | null {
    if (clip.verify === false || clip.hiK < 1.3) return null;
    const st = s.state;
    if (st === 'hold' || st === 'relocalize') {
      if (nowMs - this.at < 200) return null;
      const full = [{ x: 0, y: 0 }, { x: clip.w, y: 0 }, { x: clip.w, y: clip.h }, { x: 0, y: clip.h }];
      const c = benchCrop(hi, clip.hiK, clip.w, clip.h, full, 600);
      if (c) this.at = nowMs;
      return c;
    }
    if (!prevQuad) return null;
    const locked = s.fsm.anchored;
    if (!locked && !nextDetect && nowMs - this.at < 300) return null;
    if (nowMs - this.at < (locked ? 1000 : 40)) return null;
    const c = benchCrop(hi, clip.hiK, clip.w, clip.h, prevQuad);
    if (c) this.at = nowMs;
    return c;
  }
}

type AnySession = CardSession & {
  display?: (dt: number, shownAt: number, q: THREE.Quaternion | null) => THREE.Matrix4 | null;
  history?: OrientationHistory | null;
  camLatMs?: number;
  latFixed?: boolean;
};
/** ответ воркера в сессию: новая версия знает момент показа кадра (shownAt), прежняя — нет */
function feed(s: AnySession, out: PipelineOut, capQ: THREE.Quaternion | null, now: number, ang: number, shownAt: number) {
  return (s.onResult as (...a: unknown[]) => ReturnType<CardSession['onResult']>)(out, capQ, now, ang, shownAt);
}
/** задержка камеры, которую сейчас считает сессия (прежняя версия — постоянная CardTracker.camLatMs) */
const latOf = (s: AnySession, def: number) => (typeof s.camLatMs === 'number' ? s.camLatMs : def);

function sendFrame(pipe: CardPipeline, clip: EvalClip, s: CardSession, hi: Uint8ClampedArray, req: ReturnType<CardSession['request']>, crop: CropIn | null, reset: boolean) {
  const rgba = clip.hiK === 1 ? hi : downsample(hi, clip.w * clip.hiK, clip.h * clip.hiK, clip.hiK);
  return pipe.process({ rgba, w: clip.w, h: clip.h, focal: s.K.f, lock: req.lock, hint: req.hint, hintRadius: req.hintRadius, rot: req.rot, lostMs: req.lostMs, verify: clip.verify !== false, crop, reset });
}

/**
 * Оракул: тот же конвейер на каждом кадре без задержки; углы ведомой карты по кадрам, сглаженные по соседям
 * (±2 кадра, без запаздывания). null — карту не ведёт.
 */
export async function oracleQuads(clip: EvalClip, camLatMs = 33): Promise<(Quad | null)[] & { firstSeen?: number; quads?: Quad[] }> {
  const pipe = new CardPipeline();
  const s: AnySession = new CardSession(clip.verify !== false);
  s.K = { f: clip.focal, cx: clip.w / 2, cy: clip.h / 2 };
  s.w = clip.w;
  s.h = clip.h;
  const gyro = new GyroFeed(clip.gyro);
  if (clip.gyro && 'history' in s) s.history = gyro.hist;
  if ('camLatMs' in s) s.camLatMs = camLatMs;
  const reader = clip.frames();
  const crop = new CropPolicy();
  const raw: (Quad | null)[] = [];
  let firstSeen = -1;
  const seenQuads: Quad[] = [];
  let prevQuad: Quad | null = null;
  let nextDetect = true;
  let reset = false;
  for (let i = 0; i < clip.n; i++) {
    const t = clip.frameTime(i);
    gyro.advance(t);
    const hi = await reader.get(i);
    if (!hi) break;
    const capQ = gyro.at(t - latOf(s, camLatMs) / 1000);
    const req = s.request(t * 1000, capQ);
    const out = sendFrame(pipe, clip, s, hi, req, crop.pick(clip, hi, s, prevQuad, nextDetect, t * 1000), reset);
    reset = false;
    if (!out) {
      raw.push(null);
      continue;
    }
    const st = feed(s, out, capQ, t * 1000, gyro.angularSpeed, t * 1000);
    reset = !!st.reset;
    nextDetect = out.detNext ?? true;
    prevQuad = st.quad ?? (s.fsm.anchored ? prevQuad : null);
    if (firstSeen < 0 && st.quad && (s.state === 'candidate' || s.state === 'locked')) firstSeen = i;
    if (st.quad && (out.mode === 'detect' || out.mode === 'key') && i % 3 === 0) seenQuads.push(st.quad);
    raw.push(s.state === 'locked' && st.quad && st.pose ? st.quad : null);
  }
  reader.close?.();
  // сглаживание по соседям: среднее углов ±2 кадра (только если все соседи есть и не скачут)
  const res = raw.map((q, i) => {
    if (!q) return null;
    const nb: Quad[] = [];
    for (let k = -2; k <= 2; k++) {
      const r = raw[i + k];
      if (r && cornerDist(r, q) < 0.05 * quadDiag(q)) nb.push(r);
    }
    if (nb.length < 3) return q;
    return q.map((_, c) => ({ x: avg(nb.map((r) => r[c].x)), y: avg(nb.map((r) => r[c].y)) })) as Quad;
  }) as (Quad | null)[] & { firstSeen?: number; quads?: Quad[] };
  // карта появилась в кадре (кандидат) — от этого момента «время до посадки»; точные четырёхугольники — для фокуса
  res.firstSeen = firstSeen >= 0 ? clip.frameTime(firstSeen) : undefined;
  res.quads = seenQuads;
  return res;
}

/** углы модели карты, спроецированные позой якоря (px кадра детектора) */
export function anchorQuadOf(m: THREE.Matrix4, K: { f: number; cx: number; cy: number }): Quad | null {
  const e = m.elements;
  const hw = 0.5, hh = 0.5 / CARD_ASPECT;
  const out: Pt[] = [];
  for (const [X, Y] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
    const x = e[0] * X + e[4] * Y + e[12], y = e[1] * X + e[5] * Y + e[13], z = e[2] * X + e[6] * Y + e[14];
    if (z > -1e-3) return null;
    out.push({ x: K.cx + (K.f * x) / -z, y: K.cy - (K.f * y) / -z });
  }
  return out as Quad;
}

/** показанный четырёхугольник в осях эталонного (нумерация углов — ближайший циклический сдвиг) */
function align(a: Quad, ref: Quad): Quad {
  let best = 0, bv = Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let j = 0; j < 4; j++) s += Math.hypot(a[(j + k) % 4].x - ref[j].x, a[(j + k) % 4].y - ref[j].y);
    if (s < bv) (bv = s), (best = k);
  }
  return [0, 1, 2, 3].map((j) => a[(j + best) % 4]) as Quad;
}

function cornerDist(a: Quad, b: Quad) {
  return avg([0, 1, 2, 3].map((k) => Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y)));
}

/**
 * Ошибка показанного четырёхугольника относительно эталона НА ПЛОСКОСТИ КАРТЫ: углы показанного переводятся в
 * координаты карты обратной гомографией эталона (единица — ширина карты) → мм; масштаб — корень площади.
 */
export function planeError(shown: Quad, ref: Quad): { mm: number; px: number; scale: number; vec: number[] } | null {
  const model = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 / CARD_ASPECT }, { x: 0, y: 1 / CARD_ASPECT }];
  const H = homography(model, ref);
  const Hi = H && invert3(H);
  if (!Hi) return null;
  const a = align(shown, ref);
  const p = a.map((q) => applyH(Hi, q));
  if (p.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) return null;
  const mm = avg(p.map((q, k) => Math.hypot(q.x - model[k].x, q.y - model[k].y))) * CARD_MM;
  const px = cornerDist(a, ref);
  let area = 0;
  for (let k = 0; k < 4; k++) area += p[k].x * p[(k + 1) % 4].y - p[(k + 1) % 4].x * p[k].y;
  const scale = Math.sqrt(Math.abs(area / 2) / (1 / CARD_ASPECT)) - 1;
  return { mm, px, scale, vec: p.flatMap((q, k) => [(q.x - model[k].x) * CARD_MM, (q.y - model[k].y) * CARD_MM]) };
}

/** точка над картой (кот стоит вдоль нормали +Z якоря): показанная против истинной (поза эталона при истинном фокусе), мм */
export function headError(m: THREE.Matrix4, K: { f: number; cx: number; cy: number }, ref: Quad, Kt: { f: number; cx: number; cy: number }, H = 0.7): number | null {
  const e = m.elements;
  const x = e[8] * H + e[12], y = e[9] * H + e[13], z = e[10] * H + e[14];
  if (z > -1e-3) return null;
  const shown = { x: K.cx + (K.f * x) / -z, y: K.cy - (K.f * y) / -z };
  const pose = poseFromQuad(labelCard(ref, Kt), Kt);
  if (!pose) return null;
  const pt = projectPoint(pose.R, pose.t, 0, 0, H, Kt);
  if (!pt) return null;
  const zt = -(pose.R[8] * H + pose.t[2]);
  return (Math.hypot(shown.x - pt.x, shown.y - pt.y) * zt * CARD_MM) / Kt.f;
}

const inFrame = (q: Quad, w: number, h: number) => q.every((p) => p.x > 1 && p.y > 1 && p.x < w - 2 && p.y < h - 2);

export async function replayClip(clip: EvalClip, o: ReplayOpts = {}): Promise<ClipMetrics> {
  const phoneK = o.phoneK ?? 2.5, minW = (o.minWorkerMs ?? 20) / 1000, camLat = (o.camLatMs ?? 33) / 1000;
  const disp = displayMode(o);
  const pipe = new CardPipeline();
  const s: AnySession = new CardSession(clip.verify !== false);
  s.K = { f: clip.focal, cx: clip.w / 2, cy: clip.h / 2 };
  s.w = clip.w;
  s.h = clip.h;
  const gyro = new GyroFeed(clip.gyro);
  if (clip.gyro && 'history' in s) s.history = gyro.hist;
  if ('camLatMs' in s) {
    s.camLatMs = o.camLatMs ?? 33;
    s.latFixed = !!o.fixedLat;
  }
  const reader = clip.frames();
  const crop = new CropPolicy();
  const refOf = (i: number): Quad | null => (i < 0 ? null : clip.gt ? clip.gt(i) : o.oracle ? o.oracle[i] ?? null : null);
  const refKind: ClipMetrics['ref'] = clip.gt ? 'gt' : o.oracle ? 'oracle' : 'none';
  const t0 = clip.frameTime(0), tEnd = clip.frameTime(clip.n - 1) + 1 / 30;
  const dt = 1 / 60;
  let pending: { due: number; out: PipelineOut | null; capQ: THREE.Quaternion | null; i: number; shownAt: number } | null = null;
  let lastSent = -1, shown = -1;
  let prevQuad: Quad | null = null, nextDetect = true, reset = false;
  let firstLock = NaN, landings = 0, falseLandings = 0, losses = 0, visibleLosses = 0, wrongPlace = 0, reanchors = 0, lostEvents = 0;
  let lockedTicks = 0, ticks = 0, replies = 0;
  let wasLocked = false, wasAnchored = false;
  let badSince = NaN; // кот скрыт/не там при карте в кадре
  let checkLandAt = NaN, checkLandKind: 'first' | 're' = 'first';
  const recovery: number[] = [];
  const errMm: number[] = [], errPx: number[] = [], scales: number[] = [], headMm: number[] = [];
  const perFrame: { f: number; vec: number[]; px: Pt[] }[] = [];
  let lastPerFrame = -1;
  const cpu: number[] = [], cpuPre: number[] = [], cpuPost: number[] = [];
  const stg: Record<string, number> = {};
  const states: Record<string, number> = {};
  let firstRef = NaN;
  let catTicks = 0, upsideTicks = 0, normalFlips = 0;
  let lastN: THREE.Vector3 | null = null;
  for (let t = t0; t < tEnd; t += dt) {
    gyro.advance(t);
    // ответ воркера
    if (pending && t >= pending.due) {
      const p = pending;
      pending = null;
      if (p.out) {
        replies++;
        const before = s.state;
        const st = feed(s, p.out, p.capQ, t * 1000, gyro.angularSpeed, p.shownAt);
        o.onResult?.(p.i, p.out, s);
        reset = !!st.reset;
        if (st.reset) reanchors++;
        nextDetect = p.out.detNext ?? true;
        prevQuad = st.quad ?? (s.fsm.anchored ? prevQuad : null);
        if (st.lost) lostEvents++;
        if (s.state === 'locked' && before !== 'locked') {
          if (st.found || before === 'relocalize') {
            if (st.found) landings++;
            checkLandAt = t + 0.4;
            checkLandKind = Number.isNaN(firstLock) ? 'first' : 're';
            if (Number.isNaN(firstLock)) firstLock = t;
            if (clip.negative && st.found) falseLandings++;
          }
        }
      }
    }
    // новый показанный кадр → воркер, если он свободен
    shown = shownFrame(clip, t, Math.max(0, shown));
    if (!pending && shown > lastSent && shown >= 0) {
      const hi = await reader.get(shown);
      lastSent = shown;
      if (hi) {
        // момент съёмки кадра: когда он появился (rVFC) минус задержка камеры — так же считает CardTracker
        const shownAt = clip.frameTime(shown);
        const capQ = gyro.at(shownAt - latOf(s, camLat * 1000) / 1000);
        const req = s.request(t * 1000, capQ);
        const out = sendFrame(pipe, clip, s, hi, req, crop.pick(clip, hi, s, prevQuad, nextDetect, t * 1000), reset);
        reset = false;
        if (out) {
          cpu.push(out.ms);
          (s.fsm.anchored ? cpuPost : cpuPre).push(out.ms);
          if (out.stages) for (const [k, v] of Object.entries(out.stages)) stg[k] = (stg[k] ?? 0) + v;
        }
        pending = { due: t + (o.workerMs !== undefined ? o.workerMs / 1000 : Math.max(minW, ((out?.ms ?? 0) * phoneK) / 1000)), out, capQ, i: shown, shownAt: shownAt * 1000 };
      }
    }
    // кадр рендера
    s.tick(t * 1000);
    // на экране — кадр shown, снятый в frameTime(shown) − camLat: кот — в позе на этот момент (как CardTracker)
    const shownAt = shown >= 0 ? clip.frameTime(shown) : t;
    const m = disp === 'frame' && s.display ? s.display(dt, shownAt * 1000, gyro.last) : s.frame(dt, gyro.last);
    const shownQ = m ? anchorQuadOf(m, s.K) : null;
    if (m) {
      const e = m.elements;
      const n = new THREE.Vector3(e[8], e[9], e[10]).normalize();
      catTicks++;
      if (n.y < -0.25) upsideTicks++;
      if (lastN && lastN.dot(n) < 0.5) normalFlips++;
      lastN = n;
    } else lastN = null;
    const ref = refOf(shown);
    states[s.state] = (states[s.state] ?? 0) + 1;
    if (ref && Number.isNaN(firstRef) && inFrame(ref, clip.w, clip.h)) firstRef = t;
    o.onRender?.(t, shown, shownQ, ref, s);
    const anchored = s.fsm.anchored;
    if (!Number.isNaN(firstLock)) {
      ticks++;
      if (s.state === 'locked') lockedTicks++;
      const refIn = !!ref && inFrame(ref, clip.w, clip.h);
      if (wasLocked && s.state !== 'locked' && refIn) losses++;
      let far = false;
      if (shownQ && ref) {
        const e = planeError(shownQ, ref);
        far = !e || cornerDist(align(shownQ, ref), ref) > 0.3 * quadDiag(ref);
        if (e && refIn && !far) {
          errMm.push(e.mm);
          errPx.push(e.px);
          scales.push(e.scale);
          if (clip.trueFocal && m) {
            const h = headError(m, s.K, ref, { f: clip.trueFocal, cx: clip.w / 2, cy: clip.h / 2 });
            if (h !== null) headMm.push(h);
          }
          if (shown !== lastPerFrame) {
            lastPerFrame = shown;
            perFrame.push({ f: shown, vec: e.vec, px: align(shownQ, ref).map((p, k) => ({ x: p.x - ref[k].x, y: p.y - ref[k].y })) });
          }
        }
      }
      // проверка посадки через 0,4 с: кот на карте?
      if (!Number.isNaN(checkLandAt) && t >= checkLandAt) {
        checkLandAt = NaN;
        // с оракулом «нет эталона» — не довод (оракул мог ещё не сесть): только «кот далеко от карты»
        if (!clip.negative && refKind !== 'none' && shownQ && (ref ? far : refKind === 'gt')) {
          if (checkLandKind === 'first') falseLandings++;
          else wrongPlace++;
        }
      }
      // видимая потеря: карта в кадре, а кот скрыт или не там
      const bad = refIn && (!shownQ || far);
      if (bad && Number.isNaN(badSince)) badSince = t;
      if (!bad && !Number.isNaN(badSince)) {
        if (t - badSince > 0.25) {
          visibleLosses++;
          recovery.push(t - badSince);
        }
        badSince = NaN;
      }
    }
    if (clip.negative && anchored && !wasAnchored && Number.isNaN(firstLock)) firstLock = t;
    wasLocked = s.state === 'locked';
    wasAnchored = anchored;
  }
  reader.close?.();
  if (!Number.isNaN(badSince) && tEnd - badSince > 0.25) {
    visibleLosses++;
    recovery.push(tEnd - badSince);
  }
  // дрожание: ошибка минус скользящее среднее ±5 кадров (по кадрам камеры)
  const jit: number[] = [], jitPx: number[] = [];
  for (let i = 0; i < perFrame.length; i++) {
    const nb = perFrame.filter((p) => Math.abs(p.f - perFrame[i].f) <= 5);
    if (nb.length < 7) continue;
    for (let c = 0; c < 8; c++) jit.push((perFrame[i].vec[c] - avg(nb.map((p) => p.vec[c]))) ** 2);
    for (let c = 0; c < 4; c++) jitPx.push((perFrame[i].px[c].x - avg(nb.map((p) => p.px[c].x))) ** 2 + (perFrame[i].px[c].y - avg(nb.map((p) => p.px[c].y))) ** 2);
  }
  const enter = clip.enterAt ?? o.oracle?.firstSeen ?? (Number.isNaN(firstRef) ? t0 : firstRef);
  const sc = scales.map(Math.abs);
  const ss = Object.fromEntries(Object.entries(stg).map(([k, v]) => [k, v / Math.max(1, cpu.length)]));
  return {
    clip: clip.name,
    negative: !!clip.negative,
    frames: clip.n,
    duration: tEnd - t0,
    ref: refKind,
    timeToLand: clip.negative || Number.isNaN(firstLock) ? NaN : Math.max(0, firstLock - enter),
    landings,
    falseLandings,
    losses,
    visibleLosses,
    recovery,
    wrongPlace,
    reanchors,
    lostEvents,
    lockedFrac: ticks ? lockedTicks / ticks : 0,
    errMm: { p50: pct(errMm, 0.5), p90: pct(errMm, 0.9), max: pct(errMm, 1), mean: avg(errMm) },
    errPx: { p50: pct(errPx, 0.5), p90: pct(errPx, 0.9), mean: avg(errPx) },
    jitterMm: jit.length ? Math.sqrt(avg(jit) * 2) : NaN,
    jitterPx: jitPx.length ? Math.sqrt(avg(jitPx)) : NaN,
    scaleErr: { p90: pct(sc, 0.9) * 100, mean: avg(scales) * 100, max: pct(sc, 1) * 100 },
    headMm: { p50: pct(headMm, 0.5), p90: pct(headMm, 0.9) },
    within5mm: errMm.length ? errMm.filter((e) => e <= 5).length / errMm.length : NaN,
    cpu: { mean: avg(cpu), p50: pct(cpu, 0.5), p95: pct(cpu, 0.95), preLand: avg(cpuPre), postLand: avg(cpuPost), stages: ss },
    workerHz: replies / Math.max(1e-3, tEnd - t0),
    focalEnd: s.K.f,
    camLatEnd: latOf(s, camLat * 1000),
    upsideFrac: catTicks ? upsideTicks / catTicks : 0,
    normalFlips,
    states: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v / 60])),
    log: s.log.slice(-20),
  };
}

export const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
export function pct(v: number[], p: number): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
