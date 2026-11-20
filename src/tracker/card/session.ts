/**
 * Ядро трекера карты на главном потоке — без DOM (его же гоняет офлайн-стенд tests/card/bench.test.ts):
 *
 *   ответ воркера → поза карты на момент СЪЁМКИ кадра → в «мир гироскопа» (W = Q_съёмки · M) → фильтр в мире
 *   → на каждом кадре рендера: M_показ = Q_сейчасᵀ · W.
 *
 * Зачем так (Google «Instant Motion Tracking», MediaPipe; gyro-prediction в мобильном AR):
 *  - задержка воркера и камеры (60–100 мс) больше не видна: поворот телефона с момента съёмки досчитывает
 *    гироскоп — кот не «отлипает» от карты при движении телефона;
 *  - в мире карта неподвижна, поэтому фильтр может сглаживать сильно (нет дрожания в покое) и при этом не
 *    запаздывает на поворотах телефона (их несёт гироскоп, а не фильтр);
 *  - HOLD (карты не видно) — тот же путь без новых измерений: никаких «заморозок» и скачков на переходах.
 * Гироскоп сам себя проверяет: если его поворот не совпадает с видимым поворотом карты (не та ось, нет
 * разрешения, глючный датчик), компенсация выключается и фильтр работает в системе камеры, как раньше.
 *
 * Машина состояний (поиск → кандидат → посадка → удержание → поиск рядом → потеря) — ./fsm.ts.
 */
import * as THREE from 'three';
import { CARD_ASPECT, labelCard, mirrorPose, poseFromQuad, poseNormal, quadDiag, type Intrinsics, type Pose, type Pt, type Quad } from './geometry';
import { CardFsm, type Kind, type TrackState } from './fsm';
import type { PipelineOut } from './pipeline';
import { ACCEPT_OTHER_BANKS } from '../../config';

/**
 * Кот рисуется в позе на момент съёмки ПОКАЗАННОГО кадра камеры (CardTracker: ориентация телефона и время
 * «сейчас − camLatMs»), а не на «сейчас»: фон — это кадр, снятый camLat назад, и кот, досчитанный гироскопом до
 * «сейчас», убегал вперёд фона на каждом повороте (docs/CARD_DETECTION.md, 18.11 вечер). Флаг читает стенд
 * tests/card/eval/replay.ts, чтобы показывать так же, как приложение этой версии.
 */
export const DISPLAY_AT_FRAME = true;

/**
 * Положение карты в «мире гироскопа» — фильтр Калмана с постоянной скоростью (6 состояний: p, v).
 * Карта на столе неподвижна, но камера в руке ребёнка СДВИГАЕТСЯ (наклон телефона над картой — это облёт по дуге
 * 25–30 см, приближение — сдвиг вдоль взгляда): в мире гироскопа положение карты относительно камеры едет со
 * скоростью сдвига телефона. Прежний OneEuro (0,6 Гц) запаздывал на 150–250 мс, плюс задержка воркера —
 * кот «плыл» на 2–3 см при наклоне и менял масштаб при приближении. Теперь скорость оценивается, а поза
 * досчитывается до момента показа. Шум измерения — анизотропный: вдоль луча (глубина по размеру карты) в
 * z/(ширина карты в px) раз больше, чем поперёк, — глубина сглаживается сильнее, положение на экране — почти нет.
 */
export class PosKalman {
  /** p (3), v (3) */
  readonly x = new Float64Array(6);
  /** ковариация 6 × 6 построчно */
  readonly P = new Float64Array(36);
  /** время состояния, с */
  t = 0;
  ok = false;
  /** спектральная плотность ускорения (ширин карты² / с³) */
  constructor(public q = 10) {}

  reset(p: THREE.Vector3, t: number, R: number[]) {
    this.x.fill(0);
    this.x[0] = p.x;
    this.x[1] = p.y;
    this.x[2] = p.z;
    this.P.fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.P[i * 6 + j] = R[i * 3 + j];
    // скорость неизвестна: до ~0,25 м/с (≈ 3 ширины карты в секунду)
    for (let i = 3; i < 6; i++) this.P[i * 6 + i] = 4;
    this.t = t;
    this.ok = true;
  }

  /** прогноз до момента t (с) */
  predict(t: number) {
    const dt = Math.max(0, Math.min(0.5, t - this.t));
    this.t = Math.max(this.t, t);
    if (!dt) return;
    const x = this.x, P = this.P, q = this.q;
    for (let i = 0; i < 3; i++) x[i] += x[i + 3] * dt;
    // P = F P Fᵀ + Q, F = [I dt·I; 0 I]
    const n = new Float64Array(36);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) {
        let v = P[i * 6 + j];
        if (i < 3) v += dt * P[(i + 3) * 6 + j];
        if (j < 3) v += dt * P[i * 6 + j + 3];
        if (i < 3 && j < 3) v += dt * dt * P[(i + 3) * 6 + j + 3];
        n[i * 6 + j] = v;
      }
    const d3 = (dt * dt * dt) / 3, d2 = (dt * dt) / 2;
    for (let k = 0; k < 3; k++) {
      n[k * 6 + k] += q * d3;
      n[k * 6 + k + 3] += q * d2;
      n[(k + 3) * 6 + k] += q * d2;
      n[(k + 3) * 6 + k + 3] += q * dt;
    }
    P.set(n);
  }

  /** измерение положения z (3) с ковариацией R (3 × 3); возвращает квадрат расстояния Махаланобиса невязки */
  update(z: THREE.Vector3, R: number[], t: number): number {
    this.predict(t);
    const x = this.x, P = this.P;
    const y = [z.x - x[0], z.y - x[1], z.z - x[2]];
    const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] = P[i * 6 + j] + R[i * 3 + j];
    const Si = inv3(S);
    if (!Si) return Infinity;
    let d2 = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) d2 += y[i] * Si[i * 3 + j] * y[j];
    // K = P Hᵀ S⁻¹ (6 × 3), H = [I 0]
    const Kg = new Float64Array(18);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) Kg[i * 3 + j] = P[i * 6] * Si[j] + P[i * 6 + 1] * Si[3 + j] + P[i * 6 + 2] * Si[6 + j];
    for (let i = 0; i < 6; i++) x[i] += Kg[i * 3] * y[0] + Kg[i * 3 + 1] * y[1] + Kg[i * 3 + 2] * y[2];
    // P = (I − K H) P
    const n = new Float64Array(36);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) n[i * 6 + j] = P[i * 6 + j] - (Kg[i * 3] * P[j] + Kg[i * 3 + 1] * P[6 + j] + Kg[i * 3 + 2] * P[12 + j]);
    P.set(n);
    return d2;
  }

  /**
   * Положение на момент t без изменения состояния. Вперёд от последнего измерения — не дальше horizon (с), с
   * насыщением: удержание без измерений не «улетает» по скорости.
   */
  at(t: number, out: THREE.Vector3, horizon = 0.2): THREE.Vector3 {
    let dt = t - this.t;
    if (dt > 0) dt = horizon * (1 - Math.exp(-dt / horizon));
    else dt = Math.max(dt, -0.1);
    return out.set(this.x[0] + this.x[3] * dt, this.x[1] + this.x[4] * dt, this.x[2] + this.x[5] * dt);
  }

  get speed() {
    return Math.hypot(this.x[3], this.x[4], this.x[5]);
  }
}

/**
 * Задержка камеры по самой карте: карта на столе неподвижна в мире, значит при верной задержке L поворот карты в
 * мире W = Q(показ − L) · R_карты_в_камере между кадрами минимален. Перебор L = 0…160 мс, сумма квадратов углов
 * между соседними W по кадрам, где телефон заметно поворачивался (> 1°); минимум — оценка. На записях 18.11 и
 * синтетике с задержкой 80 мс при «зашитых» 33 мс кот на каждом повороте убегал на 1–2 см (стенд card:eval).
 */
export class LatencyEstimator {
  static readonly STEP = 8;
  static readonly N = 21;
  private S = new Float64Array(LatencyEstimator.N);
  samples = 0;
  private prev: { R: THREE.Quaternion; T: number } | null = null;
  estimate: number | null = null;

  /** R — поворот карты в системе камеры (кадр, показанный в момент T, мс), hist — ориентация телефона по времени */
  add(R: THREE.Quaternion, T: number, hist: OrientationHistory) {
    const prev = this.prev;
    this.prev = { R: R.clone(), T };
    if (!prev || T - prev.T > 250 || T <= prev.T) return;
    const a = hist.at(T), b = hist.at(prev.T);
    if (!a || !b || a.angleTo(b) < 0.012) return;
    const wa = new THREE.Quaternion(), wb = new THREE.Quaternion();
    for (let k = 0; k < LatencyEstimator.N; k++) {
      const L = k * LatencyEstimator.STEP;
      const qa = hist.at(T - L), qb = hist.at(prev.T - L);
      if (!qa || !qb) return;
      wa.copy(qa).multiply(R);
      wb.copy(qb).multiply(prev.R);
      const e = wa.angleTo(wb);
      this.S[k] = this.S[k] * 0.98 + Math.min(e, 0.1) ** 2;
    }
    this.samples++;
    if (this.samples < 4) return;
    let k = 0;
    for (let i = 1; i < LatencyEstimator.N; i++) if (this.S[i] < this.S[k]) k = i;
    // уточнение параболой по соседям; минимум на краю перебора — не верим (за пределами 0…160 мс)
    if (k === 0 || k === LatencyEstimator.N - 1) return;
    const y0 = this.S[k - 1], y1 = this.S[k], y2 = this.S[k + 1];
    const den = y0 - 2 * y1 + y2;
    const dk = den > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    // минимум должен быть выраженным: края заметно хуже
    // (по 4–14 кадрам движения — только очень выраженный: при встряске неверная задержка срывает ведение раньше)
    if (Math.min(this.S[0], this.S[LatencyEstimator.N - 1]) < (this.samples < 15 ? 4 : 1.3) * y1) return;
    this.estimate = (k + dk) * LatencyEstimator.STEP;
  }
}

/**
 * Фокус по набору четырёхугольников карты: при верном фокусе карта (прямоугольник 85,60 × 53,98) ложится в позу
 * без ошибки, при неверном — ошибка перепроецирования растёт с наклоном. Минимум суммарной ошибки по фокусу
 * (сетка + парабола) устойчивее, чем фокус по одному кадру (focalFromQuad): у почти фронтальных кадров ошибка
 * от фокуса не зависит и в минимум не вмешивается.
 */
export function focalFromQuads(quads: Quad[], cx: number, cy: number, fMin: number, fMax: number): { f: number; cost: (f: number) => number } | null {
  if (quads.length < 6) return null;
  const cost = (f: number) => {
    let s = 0;
    for (const q of quads) {
      const p = poseFromQuad(q, { f, cx, cy }, CARD_ASPECT);
      const e = p ? p.err / quadDiag(q) : 0.05;
      s += Math.min(e, 0.05);
    }
    return s / quads.length;
  };
  const N = 28;
  const lf = (i: number) => fMin * Math.pow(fMax / fMin, i / (N - 1));
  const c = Array.from({ length: N }, (_, i) => cost(lf(i)));
  let k = 0;
  for (let i = 1; i < N; i++) if (c[i] < c[k]) k = i;
  if (k === 0 || k === N - 1) return null;
  // золотое сечение между соседями
  let a = lf(k - 1), b = lf(k + 1);
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = cost(x1), f2 = cost(x2);
  for (let it = 0; it < 14; it++) {
    if (f1 < f2) (b = x2), (x2 = x1), (f2 = f1), (x1 = b - g * (b - a)), (f1 = cost(x1));
    else (a = x1), (x1 = x2), (f1 = f2), (x2 = a + g * (b - a)), (f2 = cost(x2));
  }
  return { f: (a + b) / 2, cost };
}

function inv3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-30) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export interface Orientation {
  /** ориентация камеры в мире (как three DeviceOrientationControls) */
  q: THREE.Quaternion;
}

export interface SessionStep {
  /** события для приложения */
  found?: boolean;
  lost?: boolean;
  /** кандидат/карта в этом кадре (px кадра детектора, нумерация TL TR BR BL) и поза на момент съёмки */
  quad?: Quad | null;
  pose?: Pose | null;
  kind?: Kind;
  /** пересадка: воркер надо сбросить */
  reset?: boolean;
}

const S = new THREE.Matrix4().makeScale(1, -1, -1);
/** поворот позы больше этого (рад) с одного кадра не принимаем — нужны 3 согласных измерения подряд */
const ROT_JUMP = 0.52;
/** без гироскопа: переворот нормали карты больше этого (рад) — тоже только по 3 согласным измерениям */
const NORMAL_JUMP = 0.6;
/** зеркальную позу (mirrorPose) ищем только у карты мельче этого (диагональ в px кадра трекера 320 px) */
const MIRROR_MAX_DIAG = 90;
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();

export class CardSession {
  readonly fsm: CardFsm;
  K: Intrinsics = { f: 300, cx: 160, cy: 90 };
  w = 320;
  h = 180;
  /** фильтр позы в мире: положение — Калман с постоянной скоростью (PosKalman), поворот — сглаживание */
  readonly kf = new PosKalman();
  private wPos = new THREE.Vector3();
  private wQuat = new THREE.Quaternion();
  private hasW = false;
  /** невязок подряд дальше порога (выброс или карта действительно «прыгнула» — тогда фильтр с нуля) */
  private outliers = 0;
  /** поворот, который показываем (догоняет фильтр за ~25 мс — без ступенек 15 Гц); положение — прогноз фильтра */
  private shownPos = new THREE.Vector3();
  private shownQuat = new THREE.Quaternion();
  private shownOk = false;
  readonly anchor = new THREE.Matrix4();
  /** нумерация углов: держим ориентацию кота и после короткой потери */
  private prevQuad: Quad | null = null;
  private orientRef: Quad | null = null;
  private orientAt = -1e9;
  /** гироскоп: ориентация на момент съёмки прошлого кадра, его проверка */
  private lastCapQ: THREE.Quaternion | null = null;
  private lastMeasR: THREE.Quaternion | null = null;
  private lastMeasCapQ: THREE.Quaternion | null = null;
  gyroScore = 0;
  gyroSamples = 0;
  /** гироскоп признан годным для компенсации (по умолчанию — да, пока не доказано обратное) */
  get gyroOk() {
    return this.gyroOn;
  }
  /**
   * Решение «гироскоп годен» — с гистерезисом (выкл. ниже −0,3, вкл. снова выше +0,05) и с переводом фильтра между
   * «миром гироскопа» и системой камеры при каждом переключении. Раньше решение пересчитывалось на каждом кадре
   * (оценка у −0,3 при встряске гуляла туда-сюда), а положение в фильтре оставалось в прежней системе: кот через кадр
   * прыгал между двумя местами — на записи экрана это «два Хулигана» (запись 20.11, 13:05:20).
   */
  private gyroOn = true;
  private gyroWanted() {
    if (this.gyroSamples < 8) return true;
    return this.gyroOn ? this.gyroScore > -0.3 : this.gyroScore > 0.05;
  }
  /** перевести состояние фильтра: в мир (toWorld) или в систему камеры, Q — ориентация телефона на момент кадра */
  private rebase(Q: THREE.Quaternion, toWorld: boolean) {
    const q = toWorld ? Q.clone() : Q.clone().invert();
    const m = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).elements;
    // m — по столбцам (three); R[i][j] = m[j*3+i]
    const R = (i: number, j: number) => m[j * 3 + i];
    const x = this.kf.x;
    for (const o of [0, 3]) {
      const v = [x[o], x[o + 1], x[o + 2]];
      for (let i = 0; i < 3; i++) x[o + i] = R(i, 0) * v[0] + R(i, 1) * v[1] + R(i, 2) * v[2];
    }
    // P' = B P Bᵀ, B = diag(R, R)
    const P = this.kf.P, T = new Float64Array(36), N = new Float64Array(36);
    const B = (i: number, j: number) => (Math.floor(i / 3) === Math.floor(j / 3) ? R(i % 3, j % 3) : 0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      let v = 0;
      for (let k = 0; k < 6; k++) v += B(i, k) * P[k * 6 + j];
      T[i * 6 + j] = v;
    }
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      let v = 0;
      for (let k = 0; k < 6; k++) v += T[i * 6 + k] * B(j, k);
      N[i * 6 + j] = v;
    }
    P.set(N);
    this.wPos.applyQuaternion(q);
    this.wQuat.premultiply(q);
    this.shownPos.applyQuaternion(q);
    this.shownQuat.premultiply(q);
    this.upN = null;
    this.rotJump = null;
  }
  /** самокалибровка фокуса: четырёхугольники карты с заметной перспективой */
  private fQuads: Quad[] = [];
  private fNew = 0;
  private fStable = 0;
  onFocal: ((f: number) => void) | null = null;
  /**
   * Задержка камеры, мс: кадр, показанный (requestVideoFrameCallback) в момент T, снят в T − camLatMs. С неё берётся
   * ориентация телефона для кадра и для показа. Оценивается по самой карте (LatencyEstimator), если не задана
   * (?camlat=N → latFixed).
   */
  camLatMs = 33;
  latFixed = false;
  readonly lat = new LatencyEstimator();
  onLatency: ((ms: number) => void) | null = null;
  /** история ориентации телефона (CardTracker.orient) — для оценки задержки и показа на момент кадра */
  history: OrientationHistory | null = null;
  /** скорость карты на экране (доли диагонали в секунду) и телефона (рад/с) */
  quadSpeed = 0;
  private lastQuadT = 0;
  /** причины переходов и прочее для ?debug */
  readonly log: string[] = [];

  constructor(readonly verify = true) {
    this.fsm = new CardFsm(verify);
  }

  get state(): TrackState {
    return this.fsm.state;
  }

  /** что послать воркеру с кадром, снятым при ориентации capQ */
  request(now: number, capQ: THREE.Quaternion | null): { lock: boolean; hint: Pt[] | null; hintRadius: number; rot: number[] | null; lostMs: number } {
    const f = this.fsm;
    let rot: number[] | null = null;
    if (capQ && this.lastCapQ && this.gyroOk) {
      // точки старой камеры → новой: X' = Q_новᵀ · Q_стар · X; в осях изображения (y вниз, z вперёд): S·R·S
      tmpQ.copy(capQ).invert().multiply(this.lastCapQ);
      const m = tmpM.makeRotationFromQuaternion(tmpQ).premultiply(S).multiply(S).elements;
      rot = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
    }
    this.lastCapQ = capQ ? capQ.clone() : null;
    const anchoredLost = f.anchored && f.state !== 'locked';
    return { lock: f.anchored, hint: anchoredLost ? this.hintQuad(capQ, now) : null, hintRadius: f.hintRadius(now), rot, lostMs: anchoredLost ? Math.max(0, now - f.seenAt) : 0 };
  }

  /** где карта сейчас по удерживаемой позе (в px кадра детектора) — подсказка воркеру */
  private hintQuad(q: THREE.Quaternion | null, now: number): Pt[] | null {
    if (!this.hasW) return null;
    const m = this.cameraPose(q, new THREE.Matrix4(), now).elements;
    const hw = 0.5, hh = 0.5 / CARD_ASPECT;
    const out: Pt[] = [];
    for (const [X, Y] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
      const x = m[0] * X + m[4] * Y + m[12], y = m[1] * X + m[5] * Y + m[13], z = m[2] * X + m[6] * Y + m[14];
      if (z > -1e-3) return null;
      out.push({ x: this.K.cx + (this.K.f * x) / -z, y: this.K.cy - (this.K.f * y) / -z });
    }
    return out;
  }

  /** поза карты в системе камеры при ориентации q (по фильтру в мире) */
  private cameraPose(q: THREE.Quaternion | null, out: THREE.Matrix4, t?: number): THREE.Matrix4 {
    out.compose(t !== undefined && this.kf.ok ? this.kf.at(t / 1000, new THREE.Vector3()) : this.wPos, this.wQuat, new THREE.Vector3(1, 1, 1));
    if (q && this.gyroOk) out.premultiply(tmpM.makeRotationFromQuaternion(tmpQ.copy(q).invert()));
    return out;
  }

  /**
   * Нормаль карты, которую показываем (в мире гироскопа, если он годен, иначе в системе камеры), — для выбора из двух
   * поз (mirrorPose) с гистерезисом. upWorld — в какой системе она записана.
   */
  private upN: THREE.Vector3 | null = null;
  private upWorld = false;
  /** зеркальная поза выбрана столько раз (для ?debug и стенда) */
  mirrorPicks = 0;

  /**
   * Из двух поз карты (по углам и зеркальной, geometry.ts mirrorPose) — та, у которой нормаль «вверх от стола»:
   * с гироскопом — вверх в мире (карта лежит на столе), без него — вверх по экрану (над столом телефон держат
   * верхом от себя). Поза с нормалью вниз при «верхней» зеркальной — никогда; иначе зеркальная — только если она
   * заметно (> 25°) ближе к прежней нормали (гистерезис). Ищем её только у мелкой карты (MIRROR_MAX_DIAG). Без неоднозначности поза с нормалью
   * вниз в мире (< −0,35) отбрасывается: карта Сбера лицом вниз на столе не видна, а кот вверх ногами хуже потери кадра.
   */
  private chooseUp(pose: Pose, quad: Quad, capQ: THREE.Quaternion | null, now: number): Pose | null {
    const world = !!capQ && this.gyroOk;
    if (world !== this.upWorld) (this.upN = null), (this.upWorld = world);
    const nOf = (p: Pose) => {
      const n = new THREE.Vector3(...poseNormal(p));
      return world ? n.applyQuaternion(capQ!) : n;
    };
    const nP = nOf(pose);
    // неоднозначность есть только у мелкой карты (слабая перспектива): у крупной зеркальная поза заметно хуже
    const alt = quadDiag(quad) < MIRROR_MAX_DIAG ? mirrorPose(pose, quad, this.K, CARD_ASPECT) : null;
    const ambiguous = !!alt && alt.err <= pose.err + 0.8;
    let pick = pose, nPick = nP;
    if (ambiguous) {
      const nA = nOf(alt!);
      // нормаль вниз → вверх — всегда; иначе зеркальную берём, только если она заметно (> 25°) ближе к прежней
      // нормали и сама не вниз (гистерезис: без этого выбор дёргался на шуме углов, кот поворачивался туда-сюда)
      const useAlt = (nP.y < 0 && nA.y > nP.y + 0.3) || (!!this.upN && nA.y > 0 && nA.angleTo(this.upN) + 0.45 < nP.angleTo(this.upN));
      if (useAlt) {
        pick = alt!;
        nPick = nA;
        this.mirrorPicks++;
      }
    } else if (world && nP.y < -0.35) {
      this.note(now, `поза отброшена: нормаль карты вниз (${nP.y.toFixed(2)})`);
      return null;
    }
    this.upN = nPick;
    return pick;
  }

  /** «Пересадить кота» */
  reanchor(now: number, why = 'пересадка') {
    this.fsm.reset(now, why);
    this.prevQuad = null;
    this.upN = null;
    this.rotJump = null;
    this.orientRef = null;
    this.hasW = false;
    this.shownOk = false;
  }

  private kindOf(st: string | undefined): Kind {
    if (!this.verify || st === 'sber') return 'sber';
    if (st === 'card') return ACCEPT_OTHER_BANKS ? 'sber' : 'other';
    if (st === 'back') return ACCEPT_OTHER_BANKS ? 'sber' : 'back';
    if (st === 'notcard') return 'notcard';
    return 'checking';
  }

  /**
   * Ответ воркера. capQ — ориентация телефона в момент съёмки кадра (null — гироскопа нет),
   * angSpeed — угловая скорость телефона, рад/с (NaN — неизвестно), shownAt — когда кадр появился (rVFC), мс:
   * момент съёмки = shownAt − camLatMs (без него — now, как раньше).
   */
  onResult(r: PipelineOut, capQ: THREE.Quaternion | null, now: number, angSpeed: number, shownAt?: number): SessionStep {
    const capT = shownAt !== undefined ? shownAt - this.camLatMs : now;
    const f = this.fsm;
    const before = f.state;
    const wasEver = f.everLocked;
    const step: SessionStep = {};
    const kind = this.kindOf(r.ver?.state);
    let pose: Pose | null = null;
    let quad: Quad | null = null;
    if (r.quad && r.score >= 0.5) {
      quad = labelCard(r.quad, this.K, this.prevQuad ?? (now - this.orientAt < 8000 ? this.orientRef : null));
      pose = poseFromQuad(quad, this.K, CARD_ASPECT);
      // фокус по уже ведомой карте — и когда поза отброшена: при фокусе «по умолчанию», далёком от настоящего,
      // ошибка наклонной карты всегда > 2 px, и самокалибровка (раньше — только при err < 2) не начиналась никогда
      // (и до посадки: кандидат — тоже прямоугольник ID-1; при неверном фокусе ошибка позы > 4 px и кот не садился)
      if (r.mode !== 'plane' && r.mode !== 'flow' && (f.anchored || (f.state === 'candidate' && kind === 'sber'))) this.calibrate(quad, pose, now);
      // у посаженного кота порог — от размера карты: вблизи (карта 150–250 px) при фокусе, ещё не уточнённом
      // самокалибровкой, ошибка 4–8 px, и кот терял карту именно при приближении
      const errMax = f.anchored ? Math.max(4, 0.035 * quadDiag(quad)) : 4;
      if (pose && (pose.err > errMax || pose.t[2] > -0.5)) {
        this.note(now, `поза отброшена: err ${pose.err.toFixed(1)} z ${pose.t[2].toFixed(2)}`);
        pose = null;
      }
      if (pose) pose = this.chooseUp(pose, quad, capQ, now);
    }
    let jitter = 1;
    if (pose && quad) {
      const diag = quadDiag(quad);
      if (this.prevQuad) {
        const mv = Math.max(...quad.map((p, i) => Math.hypot(p.x - this.prevQuad![i].x, p.y - this.prevQuad![i].y))) / diag;
        jitter = mv;
        const dt = Math.max(0.02, (now - this.lastQuadT) / 1000);
        this.quadSpeed = mv / dt > this.quadSpeed ? mv / dt : this.quadSpeed * 0.7 + (0.3 * mv) / dt;
      }
      this.lastQuadT = now;
      this.prevQuad = quad;
      this.orientRef = quad;
      this.orientAt = now;
    } else {
      this.quadSpeed *= 0.7;
      // карта пропала надолго — нумерацию забываем (через 8 с — orientRef)
      // (одиночный отброшенный кадр нумерацию и «дрожание» не сбрасывает: иначе при чередовании «поиск / ведение
      // с плохой позой» дрожание всегда = 1 и кот не садился — стресс-набор, тёмный стол)
      if (f.state !== 'locked' && now - this.lastQuadT > 500) this.prevQuad = null;
    }
    // размер карты — от короткой стороны кадра (в портрете карта ограничена шириной)
    const L = Math.min(this.w, this.h);
    const size = quad ? Math.max(...[0, 1, 2, 3].map((i) => Math.hypot(quad![i].x - quad![(i + 1) % 4].x, quad![i].y - quad![(i + 1) % 4].y))) / L : 0;
    const inFrame = quad ? quad.filter((p) => p.x >= -1 && p.y >= -1 && p.x <= this.w && p.y <= this.h).length / 4 : 0;
    // до посадки ведение по поверхности тоже считается: детектор пускает его только после кадра с краями карты,
    // а «карта Сбера» проверяется только на кадрах полного поиска
    const found = !!pose;
    f.observe({
      t: now,
      found,
      mode: r.mode,
      err: pose?.err,
      jitter,
      size,
      inFrame,
      glare: r.glare,
      still: !(angSpeed > 0.6),
      kind,
      postNotCard: !!r.ver?.postNotCard,
      quad: !!quad,
      maybeSber: r.ver ? r.ver.maybeSber : undefined,
    });
    if (f.state === 'search' && before !== 'search' && f.log.at(-1)?.why.startsWith('переверификация')) {
      step.reset = true;
      this.reanchor(now, 'переверификация');
    }
    // поза в мир и фильтр
    if (found && pose && f.anchored) {
      // новая посадка — с нуля; карту нашли заново после долгой потери (RELOCALIZE: телефон сдвинули, карта в другом
      // месте кадра) — тоже сразу на карту, без «подлёта» фильтром через весь экран
      if (f.state === 'locked' && before !== 'locked' && (before === 'candidate' || before === 'relocalize' || !this.hasW)) this.hasW = false;
      this.measure(pose, capQ, capT, r.mode, shownAt);
    }
    if (f.state === 'locked' && (before === 'candidate' || before === 'search' || before === 'lost')) {
      step.found = true;
      this.note(now, `посадка: ${f.log.at(-1)?.why ?? ''}`);
    }
    if (f.state === 'lost' && before !== 'lost' && wasEver) step.lost = true;
    if (before !== f.state) this.note(now, `${before} → ${f.state}: ${f.log.at(-1)?.why ?? ''}`);
    step.quad = quad;
    step.pose = pose;
    step.kind = kind;
    return step;
  }

  /** время без ответов воркера (переходы HOLD/RELOCALIZE/LOST идут и так) */
  tick(now: number): SessionStep {
    const before = this.fsm.state;
    this.fsm.tick(now);
    const step: SessionStep = {};
    if (this.fsm.state !== before) {
      this.note(now, `${before} → ${this.fsm.state}: ${this.fsm.log.at(-1)?.why ?? ''}`);
      if (this.fsm.state === 'lost') step.lost = true;
    }
    return step;
  }

  private measure(pose: Pose, capQ: THREE.Quaternion | null, now: number, mode = 'key', shownAt?: number) {
    const R = pose.R, t = pose.t;
    const M = new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
    const mq = new THREE.Quaternion().setFromRotationMatrix(M);
    // задержка камеры — по точным кадрам (ключевой кадр / края). И когда самопроверка гироскопа его «выключила»:
    // при задержке, далёкой от настоящей, предсказанный поворот не сходится с видимым — гироскоп признавался
    // негодным, и задержка не уточнялась никогда (стенд: встряска при задержке 80 мс против 33)
    if (this.history && shownAt !== undefined && !this.latFixed && (mode === 'key' || mode === 'detect')) {
      this.lat.add(mq, shownAt, this.history);
      const e = this.lat.estimate;
      if (e !== null && Math.abs(e - this.camLatMs) > 4) {
        const prev = this.camLatMs;
        this.camLatMs += 0.5 * (e - this.camLatMs);
        if (Math.abs(this.camLatMs - prev) > 6 || this.lat.samples % 50 === 0) this.note(now, `задержка камеры ≈ ${this.camLatMs.toFixed(0)} мс`);
        // самопроверку гироскопа — заново, уже с новой задержкой
        if (Math.abs(this.camLatMs - prev) > 6 && !this.gyroOk) (this.gyroScore = 0), (this.gyroSamples = 0);
        this.onLatency?.(this.camLatMs);
      }
    }
    // проверка гироскопа: видимый поворот карты между кадрами против предсказанного гироскопом
    if (capQ && this.lastMeasR && this.lastMeasCapQ) {
      const still = this.lastMeasR.angleTo(mq);
      if (still > 0.02) {
        const rel = capQ.clone().invert().multiply(this.lastMeasCapQ);
        const pred = rel.multiply(this.lastMeasR);
        const g = pred.angleTo(mq);
        this.gyroScore = this.gyroScore * 0.85 + (g < 0.6 * still ? 0.15 : -0.15);
        this.gyroSamples++;
        if (this.gyroSamples === 8 || (this.gyroSamples > 8 && this.gyroSamples % 50 === 0)) this.note(now, `гироскоп: ${this.gyroOk ? 'совпадает' : 'НЕ совпадает — компенсация выключена'} (${this.gyroScore.toFixed(2)})`);
      }
    }
    this.lastMeasR = mq;
    this.lastMeasCapQ = capQ ? capQ.clone() : null;
    const want = this.gyroWanted();
    if (want !== this.gyroOn) {
      if (capQ && this.hasW) this.rebase(capQ, want);
      else if (!capQ) this.hasW = false;
      this.gyroOn = want;
      this.note(now, `гироскоп ${want ? 'включён' : 'выключен'} (${this.gyroScore.toFixed(2)}) — фильтр переведён`);
    }
    // в мир гироскопа
    if (capQ && this.gyroOk) M.premultiply(tmpM.makeRotationFromQuaternion(capQ));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    M.decompose(p, q, s);
    const ts = now / 1000;
    // шум измерения: поперёк луча — σ px углов, вдоль луча (глубина по размеру карты) — в z·(ширина/px) раз больше
    const z = Math.hypot(t[0], t[1], t[2]);
    const spx = mode === 'key' ? 0.5 : mode === 'detect' ? 0.8 : 1.2;
    const sl = (z * spx) / this.K.f, sd = (z * z * spx * 1.4) / this.K.f;
    const u = p.clone().normalize();
    const R3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R3[i * 3 + j] = (i === j ? sl * sl : 0) + (sd * sd - sl * sl) * u.getComponent(i) * u.getComponent(j);
    if (!this.hasW) {
      this.kf.reset(p, ts, R3);
      this.outliers = 0;
      this.wPos.copy(p);
      this.wQuat.copy(q);
      this.hasW = true;
      this.shownOk = false;
      return;
    }
    // выброс (неверная нумерация, кривой четырёхугольник) — пропускаем; три подряд — карта правда в другом месте
    const save = this.outliers < 2 ? { x: this.kf.x.slice(), P: this.kf.P.slice(), t: this.kf.t } : null;
    // без гироскопа «мир» — система камеры: в положении карты и шум позы, и повороты телефона — сглаживаем сильнее
    this.kf.q = capQ && this.gyroOk ? 10 : 3;
    const d2 = this.kf.update(p, R3, ts);
    if (d2 > 60 && save) {
      this.kf.x.set(save.x);
      this.kf.P.set(save.P);
      this.kf.t = save.t;
      this.outliers++;
    } else if (d2 > 60) {
      this.kf.reset(p, ts, R3);
      this.outliers = 0;
    } else this.outliers = 0;
    this.kf.at(ts, this.wPos);
    // поворот: в мире карта неподвижна — сглаживаем сильно. Большой скачок (> 30°: переворот позы, сменилась нумерация
    // углов, кривой четырёхугольник) — не с одного кадра: только если 3 измерения подряд согласны между собой
    // (гистерезис; раньше — сразу, и одиночный кадр с зеркальной позой переворачивал кота на 1–2 кадра)
    const ang = this.wQuat.angleTo(q);
    // скачок: в мире гироскопа (карта неподвижна) — любой поворот > 30°; без гироскопа поворот телефона виден как
    // поворот карты, поэтому — только переворот нормали (> 35° за один ответ воркера телефоном не повернуть)
    const nOld = new THREE.Vector3(0, 0, 1).applyQuaternion(this.wQuat), nNew = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const jump = capQ && this.gyroOk ? ang > ROT_JUMP : nOld.angleTo(nNew) > NORMAL_JUMP;
    if (jump) {
      const j = this.rotJump;
      if (j && j.q.angleTo(q) < 0.25) j.n++;
      else this.rotJump = { q: q.clone(), n: 1 };
      if (this.rotJump!.n < 3) return;
      this.rotJump = null;
      this.wQuat.copy(q);
      return;
    }
    this.rotJump = null;
    let k = ang > 0.35 ? 1 : 0.25 + 0.75 * Math.min(1, ang / 0.12);
    if (now < this.softRotUntil) k = Math.min(k, 0.15);
    this.wQuat.slerp(q, k);
  }
  /** кандидат на большой поворот и сколько измерений подряд за него */
  private rotJump: { q: THREE.Quaternion; n: number } | null = null;

  /**
   * Кадр рендера: поза якоря в системе камеры (null — кота нет). qNow — ориентация телефона, tShow — момент (мс), на
   * который показываем: CardTracker передаёт момент съёмки показанного кадра камеры и ориентацию на него
   * (DISPLAY_AT_FRAME) — кот совпадает с фоном; без tShow — положение на последнее измерение (без прогноза).
   */
  frame(dt: number, qNow: THREE.Quaternion | null, tShow?: number): THREE.Matrix4 | null {
    if (!this.fsm.anchored || !this.hasW) {
      this.shownOk = false;
      return null;
    }
    // положение — прогноз фильтра на момент показа (скорость сдвига телефона), поворот — догоняет фильтр за ~25 мс
    // В МИРЕ; поворот телефона накладывается после — он без задержки
    if (tShow !== undefined) this.kf.at(tShow / 1000, this.shownPos);
    else this.shownPos.copy(this.wPos);
    if (!this.shownOk) {
      this.shownQuat.copy(this.wQuat);
      this.shownOk = true;
    } else {
      const a = 1 - Math.exp(-dt / 0.025);
      this.shownQuat.slerp(this.wQuat, a);
    }
    this.anchor.compose(this.shownPos, this.shownQuat, new THREE.Vector3(1, 1, 1));
    if (qNow && this.gyroOk) this.anchor.premultiply(tmpM.makeRotationFromQuaternion(tmpQ.copy(qNow).invert()));
    return this.anchor;
  }

  /**
   * Самокалибровка фокуса: копим четырёхугольники карты (целиком в кадре, ≥ 50 px, наклон ≥ 20°), раз в 8 новых — фокус по всему набору (focalFromQuads). Раньше — медиана focalFromQuad по кадрам,
   * только у посаженного кота и при ошибке позы < 8 px: на стенде фокус уходил на 5–12 % от истинного, а при фокусе,
   * далёком от истинного (угол обзора iPhone 56–70° против 63° по умолчанию), позы отбрасывались (> 4 px) и кот
   * терял карту вблизи и на наклоне. Новый фокус — с нуля и фильтр позы (без «подлёта» в другом масштабе).
   */
  private calibrate(quad: Quad, pose: Pose | null, now: number) {
    if (this.fStable >= 3) return;
    if (!quad.every((p) => p.x > 1 && p.y > 1 && p.x < this.w - 2 && p.y < this.h - 2) || quadDiag(quad) < 50) return;
    const L = Math.max(this.w, this.h);
    const fMin = L / 2 / Math.tan((85 * Math.PI) / 360), fMax = L / 2 / Math.tan((45 * Math.PI) / 360);
    // наклон ≥ 20°: без перспективы фокус из кадра не следует (поза — при нынешнем фокусе, для отбора хватает)
    if (!pose || Math.acos(Math.min(1, Math.abs(pose.R[8]))) < 0.35) return;
    // новые кадры — только непохожие на последний принятый (иначе набор из одного ракурса)
    const last = this.fQuads[this.fQuads.length - 1];
    if (last && Math.max(...quad.map((p, i) => Math.hypot(p.x - last[i].x, p.y - last[i].y))) < 0.02 * quadDiag(quad)) return;
    this.fQuads.push(quad);
    if (this.fQuads.length > 48) this.fQuads.shift();
    if (++this.fNew < 8 || this.fQuads.length < 12) return;
    this.fNew = 0;
    const r = focalFromQuads(this.fQuads, this.K.cx, this.K.cy, fMin, fMax);
    if (!r) return;
    // меняем фокус, только если с нынешним карта заметно не ложится в позу (> 0,5 % диагонали в среднем) и с новым —
    // вдвое лучше: на 320-px кадре углы ведения смещены на доли px, и фокус «по углам» гуляет на 5–10 % (стенд) —
    // мелкие поправки делали только хуже (кот кренился и менял масштаб после каждой)
    const cur = r.cost(this.K.f), best = r.cost(r.f);
    if (Math.abs(r.f - this.K.f) / this.K.f < 0.03 || cur < 0.005 || best > 0.5 * cur) {
      this.fStable++;
      return;
    }
    this.fStable = 0;
    this.note(now, `фокус ${this.K.f.toFixed(0)} → ${r.f.toFixed(0)} px (ошибка позы ${(cur * 100).toFixed(2)} → ${(best * 100).toFixed(2)} % диагонали)`);
    const k = r.f / this.K.f;
    this.K = { ...this.K, f: r.f };
    // поза в новом масштабе: при том же размере карты на экране глубина ∝ фокусу — масштабируем состояние фильтра
    // (в мире гироскопа тоже: начало координат — камера). Раньше — фильтр с нуля (hasW = false): через 1–3 с после
    // посадки, в самом конце сцены пробуждения, кот дёргался (записи 20.11)
    this.rescale(k);
    this.onFocal?.(r.f);
  }

  /** глубина сцены ×k (смена фокуса): положение, скорость и ковариация фильтра, показанная поза */
  private rescale(k: number) {
    if (!this.hasW) return;
    for (let i = 0; i < 6; i++) this.kf.x[i] *= k;
    for (let i = 0; i < 36; i++) this.kf.P[i] *= k * k;
    this.wPos.multiplyScalar(k);
    this.shownPos.multiplyScalar(k);
    // наклон карты при новом фокусе чуть другой — довернуть плавно (~0,4 с), а не скачком
    this.softRotUntil = this.kf.t * 1000 + 450;
  }
  /** до этого момента (мс) поворот догоняет измерения мягко (после смены фокуса) */
  private softRotUntil = -1;

  resetFocalSamples() {
    this.fQuads = [];
    this.fNew = 0;
    this.fStable = 0;
  }

  /**
   * Кадр рендера для приложения: кадр камеры на экране появился в shownAt (мс, rVFC) — кот в позе на момент его
   * съёмки (shownAt − camLatMs), с ориентацией телефона на тот же момент. Нет истории ориентации — qFallback.
   */
  display(dt: number, shownAt: number, qFallback: THREE.Quaternion | null): THREE.Matrix4 | null {
    const tc = shownAt - this.camLatMs;
    const q = this.history?.at(tc) ?? qFallback;
    return this.frame(dt, q, tc);
  }

  private note(now: number, s: string) {
    this.log.push(`${(now / 1000).toFixed(1)}с ${s}`);
    if (this.log.length > 40) this.log.shift();
  }
}

/** история ориентации телефона: ориентация на момент съёмки кадра (кадр камеры старше момента, когда мы его берём) */
export class OrientationHistory {
  private buf: { t: number; q: THREE.Quaternion }[] = [];
  push(t: number, q: THREE.Quaternion) {
    const last = this.buf[this.buf.length - 1];
    if (last && t <= last.t) return;
    this.buf.push({ t, q: q.clone() });
    if (this.buf.length > 90) this.buf.shift();
  }
  /** ориентация в момент t (линейно между отсчётами); null — нет данных */
  at(t: number): THREE.Quaternion | null {
    const b = this.buf;
    if (!b.length) return null;
    if (t >= b[b.length - 1].t) return b[b.length - 1].q.clone();
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].t <= t) {
        const k = (t - b[i - 1].t) / Math.max(1e-6, b[i].t - b[i - 1].t);
        return b[i - 1].q.clone().slerp(b[i].q, k);
      }
    }
    return b[0].q.clone();
  }
}
