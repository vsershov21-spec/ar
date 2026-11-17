/**
 * Детектор банковской карты (любой ID-1, 85.60 × 53.98 мм) на уменьшенном кадре камеры. Без OpenCV:
 *
 *   RGBA → размытие [1 4 6 4 1] по каналам → цветной градиент (тензор Ди Дзенцо: Собель по R, G, B)
 *   → подавление немаксимумов → порог (адаптивный, по перцентилю) → отрезки (рост областей с одинаковой
 *   ориентацией, как в LSD, + проверка прямолинейности) → пары «почти параллельных» отрезков → четырёхугольники
 *   из двух пар → отсев (выпуклость, площадь, отрезки лежат на сторонах, метрика: соотношение сторон 1.586 и
 *   прямой угол в 3D при приблизительном фокусе) → оценка: доля сторон, подтверждённых краем
 *   → уточнение сторон до субпикселя (поиск максимума градиента по нормали + робастная прямая) → углы.
 *
 * Между полными поисками — трекинг: разреженный оптический поток (пирамидальный Лукас–Канаде по точкам
 * карты и стола вокруг неё) → гомография движения (RANSAC) → прогноз углов → уточнение по краям.
 * Полный поиск всё равно запускается раз в detectEvery кадров — чтобы не «залипнуть» на чужом прямоугольнике.
 *
 * Чистый TypeScript без DOM: работает в Web Worker (worker.ts), в основном потоке и в тестах.
 */
import {
  type Pt, type Quad, type Intrinsics, type Line, CARD_ASPECT,
  intersect, isConvex, orderClockwise, signedArea, metricShape, applyH, homography, quadDiag, quadDistance, pointInQuad, alignQuad,
  mul3, invert3, type Mat3,
} from './geometry';
import { KeyframeTracker, type AlignResult } from './keyframe';

export interface CardDetectorParams {
  /** порог края не ниже этого (единицы Собеля по 0..255 после размытия) */
  minEdge: number;
  /** порог края = edgeRatio × перцентиль edgePct силы немаксимумов */
  edgeRatio: number;
  edgePct: number;
  /** допуск ориентации при росте отрезка, рад */
  angleTol: number;
  /** минимальная длина отрезка, доля min(w, h) */
  minSegFrac: number;
  /** сколько самых длинных отрезков перебирать */
  maxSegs: number;
  /** сколько лучших пар «противоположных сторон» комбинировать */
  maxPairs: number;
  /** максимальный угол между противоположными сторонами на изображении (перспектива), рад */
  maxOppAngle: number;
  /** минимальный угол между соседними сторонами на изображении, рад */
  minAdjAngle: number;
  /** площадь карты: доли кадра */
  minAreaFrac: number;
  maxAreaFrac: number;
  /** при полном поиске углы должны быть внутри кадра с этим отступом (доля размера; < 0 — можно наружу). В трекинге — можно за кадр */
  outside: number;
  /** соотношение сторон и допуск |ln(a / aspect)| */
  aspect: number;
  aspectTol: number;
  /** допуск |cos| угла между сторонами в 3D */
  cosTol: number;
  /** минимальная средняя «подтверждённость» сторон краем 0..1 */
  minSupport: number;
  /** вторая по слабости сторона должна быть подтверждена хотя бы на столько (одну может закрыть палец) */
  minSide2: number;
  /** уточнение: поиск края по нормали ±px */
  refineRange: number;
  /** трекинг: полный поиск раз в N кадров */
  detectEvery: number;
  /** трекинг включён */
  track: boolean;
  /** после посадки — ведение по ключевому кадру (keyframe.ts); false — как до ноября 2026 (стенд «до») */
  keyframe: boolean;
}

export const defaultDetectorParams: CardDetectorParams = {
  minEdge: 14,
  edgeRatio: 0.3,
  edgePct: 0.92,
  angleTol: (22.5 * Math.PI) / 180,
  minSegFrac: 0.07,
  maxSegs: 50,
  maxPairs: 160,
  maxOppAngle: (55 * Math.PI) / 180,
  minAdjAngle: (28 * Math.PI) / 180,
  minAreaFrac: 0.015,
  maxAreaFrac: 0.92,
  outside: -0.025,
  aspect: CARD_ASPECT,
  aspectTol: 0.22,
  cosTol: 0.45,
  minSupport: 0.5,
  minSide2: 0.45,
  refineRange: 3,
  detectEvery: 6,
  track: true,
  keyframe: true,
};

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  len: number;
  /** направление отрезка, рад [0, π) */
  dir: number;
  line: Line;
  mx: number;
  my: number;
  mag: number;
}

export interface Candidate {
  quad: Quad;
  score: number;
  support: number[];
  aspect: number;
  cos: number;
}

export interface DetectResult {
  /** углы карты по часовой стрелке на экране (нумерация произвольная), px кадра детектора */
  quad: Quad | null;
  /** 0..1 */
  score: number;
  /** plane — карту ведём по поверхности стола (края карты не подтверждены: размыта, закрыта, ушла из кадра) */
  mode: 'detect' | 'track' | 'key' | 'plane' | 'none';
  /** время обработки, мс */
  ms: number;
  edgeThreshold: number;
  /** для отладки (debug: true) */
  segments?: Segment[];
  candidates?: Candidate[];
  edges?: Uint8Array;
  flow?: { x: number; y: number; ok: boolean }[];
}

export interface ProcessOptions {
  /** фокус в px кадра детектора; по умолчанию — горизонтальный угол обзора ~63° по длинной стороне */
  focal?: number;
  debug?: boolean;
  /** принудительно полный поиск (без трекинга) */
  forceDetect?: boolean;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const angDiffPi = (a: number, b: number) => {
  let d = Math.abs(a - b) % Math.PI;
  return d > Math.PI / 2 ? Math.PI - d : d;
};

/** фокус по умолчанию: горизонтальный угол обзора по длинной стороне кадра, градусы */
export const DEFAULT_HFOV = 63;
export const focalFromFov = (w: number, h: number, hfovDeg = DEFAULT_HFOV) => Math.max(w, h) / 2 / Math.tan((hfovDeg * Math.PI) / 360);

export class CardDetector {
  params: CardDetectorParams;
  private w = 0;
  private h = 0;
  private ch!: Float32Array[]; // размытые R, G, B
  private tmp!: Float32Array;
  private jxx!: Float32Array;
  private jxy!: Float32Array;
  private jyy!: Float32Array;
  private mag!: Float32Array;
  private theta!: Float32Array;
  private edge!: Uint8Array;
  private used!: Uint8Array;
  private gray!: Float32Array;
  private pyr: Float32Array[] = [];
  private prevPyr: Float32Array[] = [];
  private pyrDims: [number, number][] = [];
  private thr = 0;
  private prevQuad: Quad | null = null;
  /** карта была подтверждена краями — дальше можно вести по плоскости стола */
  private anchored = false;
  private planeFrames = 0;
  /** движение прошлого кадра (гомография кадр→кадр) — начальное приближение для потока */
  private lastH: number[] | null = null;
  private guess(a: Pt): Pt | undefined {
    // гироскоп знает поворот телефона между кадрами точнее, чем «как в прошлый раз»
    const G = this.gyroG ?? this.lastH;
    if (!G) return undefined;
    const b = applyH(G, a);
    const g = { x: b.x - a.x, y: b.y - a.y };
    return Number.isFinite(g.x) && Number.isFinite(g.y) && Math.hypot(g.x, g.y) < 80 ? g : undefined;
  }
  /** диагностика ведения по поверхности (debug) */
  planeInfo = { pts: 0, tracked: 0, inliers: 0, why: '' };
  private planeMiss = 0;
  private sinceDetect = 0;
  private K: Intrinsics = { f: 1, cx: 0, cy: 0 };

  constructor(params: Partial<CardDetectorParams> = {}) {
    this.params = { ...defaultDetectorParams, ...params };
  }

  /** забыть прошлый кадр (сброс трекинга) */
  /** Кот посажен: новые прямоугольники в кадре кота не утаскивают. Возврат к карте — только рядом с ожидаемым местом
   *  (hint — где карта должна быть по гироскопу), пересадка — только явно (reset). */
  locked = false;
  hint: Quad | null = null;
  /** радиус поиска той же карты вокруг hint, доли диагонали */
  hintRadius = 0.6;
  /** поворот камеры с прошлого кадра (гироскоп), 3×3 в осях изображения; null — нет данных */
  gyroRot: number[] | null = null;
  /** сверка с ключевым кадром в этом кадре (null — не было) */
  keyInfo: { zncc: number; inl: number } | null = null;
  /** почему в этом кадре так (debug) */
  why = '';
  /** кандидаты последнего полного поиска (лучшие первыми) — для проверки «это карта?» (verify.ts) */
  lastCandidates: Candidate[] = [];
  /** в этом кадре был полный поиск (lastCandidates — свежие) */
  ranDetect = false;
  /**
   * Кот не посажен, а ведём не карту (проверка по содержимому: книга, бутылка) — перейти на другого кандидата.
   * Логику посаженного кота (locked/hint) не трогает.
   */
  adopt(q: Quad) {
    if (this.locked) return;
    this.prevQuad = q;
    this.lastH = null;
    this.anchored = true;
    this.planeFrames = 0;
    this.sinceDetect = 0;
  }
  /** забыть текущую «дорожку» (ведём не карту) — следующий кадр начнётся с полного поиска */
  drop() {
    if (this.locked) return;
    this.prevQuad = null;
    this.lastH = null;
    this.anchored = false;
    this.planeFrames = 0;
  }
  reset() {
    this.key.reset();
    this.keyH = null;
    this.keyVel = null;
    this.keyQuad = null;
    this.locked = false;
    this.hint = null;
    this.lastH = null;
    this.anchored = false;
    this.planeFrames = 0;
    this.prevQuad = null;
  }

  private alloc(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const n = w * h;
    this.ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.tmp = new Float32Array(n);
    this.jxx = new Float32Array(n);
    this.jxy = new Float32Array(n);
    this.jyy = new Float32Array(n);
    this.mag = new Float32Array(n);
    this.theta = new Float32Array(n);
    this.edge = new Uint8Array(n);
    this.used = new Uint8Array(n);
    this.gray = new Float32Array(n);
    this.pyrDims = [];
    let lw = w, lh = h;
    for (let l = 0; l < 3; l++) {
      this.pyrDims.push([lw, lh]);
      lw = Math.max(1, lw >> 1);
      lh = Math.max(1, lh >> 1);
    }
    this.pyr = this.pyrDims.map(([a, b]) => new Float32Array(a * b));
    this.prevPyr = this.pyrDims.map(([a, b]) => new Float32Array(a * b));
    this.prevQuad = null;
  }

  // ───────────── ключевой кадр (после посадки) ─────────────
  /** шаблон карты, снятый при посадке: выравнивание по нему убирает дрейф и дрожание (keyframe.ts) */
  readonly key = new KeyframeTracker();
  /** гомография шаблон → кадр в прошлом кадре (null — в прошлом кадре не выровнялись) */
  private keyH: Mat3 | null = null;
  /** движение кадр→кадр по шаблону (прогноз без гироскопа) */
  private keyVel: Mat3 | null = null;
  /** углы по шаблону в нумерации детектора (для сопоставления с hint и потоком) */
  private keyQuad: Quad | null = null;
  private frameNo = 0;
  private keyFrame = -1e9;
  /** кадров подряд без выравнивания по ключевому кадру */
  private keyFails = 0;
  /** гомография поворота камеры между кадрами по гироскопу (K·R·K⁻¹) в этом кадре */
  private gyroG: Mat3 | null = null;

  private gyroHomography(): Mat3 | null {
    const R = this.gyroRot;
    if (!R || R.length !== 9) return null;
    const { f, cx, cy } = this.K;
    const Kc: Mat3 = [f, 0, cx, 0, f, cy, 0, 0, 1];
    const Ki: Mat3 = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
    const G = mul3(Kc, mul3(R, Ki));
    return G.every(Number.isFinite) ? G.map((x) => x / G[8]) : null;
  }

  /** выравнивание по ключевому кадру от начального приближения H0; null — не сошлось или не та картинка */
  private tryKey(H0: Mat3, ref: Quad | null): AlignResult | null {
    const r = this.key.align(this.pyr, this.pyrDims, H0);
    if (!r) return null;
    this.keyInfo = { zncc: r.zncc, inl: r.inl };
    if (r.vis < 0.3 || r.inl < 0.45 || r.zncc < 0.75) return null;
    // форма — по-прежнему карта (на однотонном участке выравнивание может «растянуть» угол)
    const m = metricShape(r.quad, this.K);
    if (!m) return null;
    const asp = m.aspect >= 1 ? m.aspect : 1 / m.aspect;
    if (Math.abs(Math.log(asp / CARD_ASPECT)) > 0.3 || Math.abs(m.cos) > 0.5) return (this.keyInfo = { ...this.keyInfo!, zncc: -1 }), null;
    if (ref) {
      const a0 = Math.abs(signedArea(ref)), a1 = Math.abs(signedArea(r.quad));
      if (a1 < a0 * 0.5 || a1 > a0 * 2) return null;
    }
    const diag = quadDiag(r.quad);
    const c = { x: (r.quad[0].x + r.quad[2].x) / 2, y: (r.quad[0].y + r.quad[2].y) / 2 };
    if (diag < 10 || c.x < -this.w || c.x > 2 * this.w || c.y < -this.h || c.y > 2 * this.h) return null;
    return r;
  }

  private keyCandidate(r: AlignResult, ref: Quad | null): Candidate {
    const quad = ref ? alignQuad(r.quad, ref) : r.quad;
    return { quad, score: Math.min(1, 0.55 + 0.45 * r.zncc * Math.min(1, r.inl / 0.8)), support: [0, 0, 0, 0], aspect: 0, cos: 0 };
  }

  /** Обработать кадр RGBA (w × h). */
  process(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: ProcessOptions = {}): DetectResult {
    const t0 = now();
    this.alloc(w, h);
    const p = this.params;
    this.K = { f: opts.focal ?? focalFromFov(w, h), cx: w / 2, cy: h / 2 };
    [this.pyr, this.prevPyr] = [this.prevPyr, this.pyr];
    // серый кадр и пирамида — всегда (поток, ключевой кадр); карта краёв — только если понадобится
    // (полный поиск, ведение по краям): в ведении по ключевому кадру её не считаем (≈ −40 % времени кадра)
    this.frameRgba = rgba;
    this.edgesReady = false;
    this.grayOnly(rgba);
    this.buildPyramid();

    let best: Candidate | null = null;
    let mode: DetectResult['mode'] = 'none';
    let flow: DetectResult['flow'];
    let detectOut: { segments: Segment[]; candidates: Candidate[] } | null = null;
    this.ranDetect = false;
    this.keyInfo = null;
    this.why = '';
    this.frameNo++;
    this.gyroG = this.gyroHomography();
    if (!this.locked && this.key.ready) {
      this.key.reset();
      this.keyH = this.keyVel = this.keyQuad = null;
    }
    const useKey = this.locked && this.key.ready && p.track && p.keyframe && !opts.forceDetect;
    let keyRes: AlignResult | null = null;

    // 1. после посадки — прежде всего выравнивание по ключевому кадру (прогноз: прошлая поза × гироскоп)
    if (useKey) {
      let H0: Mat3 | null = null;
      if (this.keyH) H0 = this.gyroG ? mul3(this.gyroG, this.keyH) : this.keyVel ? mul3(this.keyVel, this.keyH) : this.keyH;
      else if (this.prevQuad && this.keyQuad) {
        const h = this.key.homographyFor(alignQuad(this.prevQuad, this.keyQuad));
        H0 = h && this.gyroG ? mul3(this.gyroG, h) : h;
      } else if (this.hint && this.keyQuad) H0 = this.key.homographyFor(alignQuad(this.hint, this.keyQuad));
      if (H0) keyRes = this.tryKey(H0, this.prevQuad);
      if (keyRes) {
        best = this.keyCandidate(keyRes, this.prevQuad ?? this.keyQuad);
        mode = 'key';
        this.sinceDetect++;
      } else {
        const ki = this.keyInfo as { zncc: number; inl: number } | null;
        this.why = ki ? `key✗ z${ki.zncc.toFixed(2)} i${ki.inl.toFixed(2)}` : 'key✗';
      }
    }

    if (!best && p.track && this.prevQuad && !opts.forceDetect) {
      const tr = this.trackStep(this.prevQuad, opts.debug);
      flow = tr.flow;
      if (tr.cand) {
        best = tr.cand;
        mode = 'track';
      } else if (this.anchored && this.planeFrames < MAX_PLANE_FRAMES) {
        // края карты не видно — ведём её по поверхности: кот остаётся на месте и масштабируется с расстоянием
        const pq = this.planeStep(this.prevQuad);
        if (pq) {
          best = { quad: pq, score: 0.56, support: [0, 0, 0, 0], aspect: 0, cos: 0 };
          mode = 'plane';
        }
      }
      this.sinceDetect++;
      // поток/поверхность нашли карту — уточняем по ключевому кадру (снова без дрейфа)
      if (best && useKey && this.keyQuad) {
        const h = this.key.homographyFor(alignQuad(best.quad, this.keyQuad));
        const r = h ? this.tryKey(h, best.quad) : null;
        if (r) {
          keyRes = r;
          best = this.keyCandidate(r, best.quad);
          mode = 'key';
        }
      }
    }
    if (!best || this.sinceDetect >= p.detectEvery) {
      detectOut = this.detect();
      this.lastCandidates = detectOut.candidates;
      this.ranDetect = true;
      this.sinceDetect = 0;
      let d: Candidate | undefined = detectOut.candidates[0];
      if (d && this.locked) {
        // посаженный кот: принимаем только «ту же» карту — рядом с текущей/ожидаемой позицией и того же размера
        const ref = best ? best.quad : this.hint;
        if (!ref) d = undefined;
        else if (mode === 'key') d = undefined; // ведём по ключевому кадру — полный поиск только для проверки «карта Сбера»
        else {
          // ищем ту же карту: среди кандидатов рядом с ожидаемым местом; дальше 0,6 диагонали — только если
          // её подтверждает ключевой кадр (та же картинка), иначе чужой прямоугольник утащил бы кота
          d = undefined;
          for (const c of detectOut.candidates.slice(0, 4)) {
            const dq = alignQuad(c.quad, ref);
            const a0 = Math.abs(signedArea(ref)), a1 = Math.abs(signedArea(dq));
            const dist = quadDistance(dq, ref) / quadDiag(ref);
            const lim = best ? 0.35 : this.hintRadius;
            if (dist > lim || a1 < a0 * 0.4 || a1 > a0 * 2.5) continue;
            if (this.key.ready && this.keyQuad) {
              const h = this.key.homographyFor(alignQuad(c.quad, this.keyQuad));
              const r = h ? this.tryKey(h, null) : null;
              if (r) {
                keyRes = r;
                d = this.keyCandidate(r, ref);
                break;
              }
              if (dist > 0.6 || best) continue;
            }
            if (a1 < a0 * 0.5 || a1 > a0 * 2) continue;
            d = { ...c, quad: dq };
            break;
          }
          if (d && keyRes && !best) {
            best = d;
            mode = 'key';
            d = undefined;
          }
        }
      }
      // карта ведётся по поверхности — чужой прямоугольник (книга, телефон) кота не утащит: только рядом с ожидаемым местом
      if (d && mode === 'plane' && best && quadDistance(alignQuad(d.quad, best.quad), best.quad) > 0.35 * quadDiag(best.quad)) d = undefined;
      if (d) {
        if (!best) {
          best = d;
          mode = 'detect';
        } else if (quadDistance(alignQuad(d.quad, best.quad), best.quad) > 0.08 * quadDiag(best.quad) && d.score > best.score + 0.1) {
          best = d;
          mode = 'detect';
        } else if (d.score > best.score) {
          best = { ...d, quad: alignQuad(d.quad, best.quad) };
          mode = 'detect';
        }
      }
    }
    this.prevQuad = best ? best.quad : null;
    // ключевой кадр: состояние выравнивания; съёмка при посадке; редкое обновление при сильной смене масштаба/вида
    if (mode === 'key' && keyRes) {
      this.keyFails = 0;
      this.keyVel = this.keyH ? (() => {
        const inv = invert3(this.keyH!);
        return inv ? mul3(keyRes!.H, inv) : null;
      })() : null;
      this.keyH = keyRes.H;
      this.keyQuad = keyRes.quad;
      const q = keyRes.quad;
      const wPx = (Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2;
      const want = Math.max(20, Math.min(56, wPx / 2)) / this.key.scale;
      const scaleOff = (want < 0.7 || want > 1.45) && keyRes.inl > 0.75;
      const lookOff = keyRes.zncc < 0.88 && keyRes.inl > 0.88 && keyRes.vis > 0.9;
      if ((scaleOff || lookOff) && this.frameNo - this.keyFrame > 15 && this.key.capture(this.gray, this.w, this.h, q, this.frameNo, keyRes.H)) this.keyFrame = this.frameNo;
    } else {
      this.keyH = null;
      this.keyVel = null;
      if (useKey) this.keyFails++;
      // ключевой кадр устарел (карта сильно приблизилась/наклонилась, сменился свет) — а края карты её
      // уверенно подтверждают: новый ключевой кадр с этой позы
      const stale = useKey && this.keyFails >= 4 && best && mode === 'track' && best.score >= 0.62 && this.frameNo - this.keyFrame > 8;
      if (stale) this.key.reset();
      if (this.locked && p.keyframe && best && !this.key.ready && (mode === 'detect' || mode === 'track') && best.score >= 0.5) {
        if (this.key.capture(this.gray, this.w, this.h, best.quad, this.frameNo)) {
          this.keyFrame = this.frameNo;
          this.keyFails = 0;
          this.keyH = this.key.homographyFor(best.quad);
          this.keyQuad = best.quad;
        }
      } else if (best && mode !== 'plane' && this.keyQuad) this.keyQuad = alignQuad(best.quad, this.keyQuad);
    }
    if (best && mode !== 'plane') {
      this.anchored = true;
      this.planeFrames = 0;
    } else if (mode === 'plane') this.planeFrames++;
    else if (!this.locked) this.anchored = false;

    const res: DetectResult = { quad: best ? best.quad : null, score: best ? best.score : 0, mode: best ? mode : 'none', ms: now() - t0, edgeThreshold: this.thr };
    if (opts.debug) {
      this.ensureEdges();
      res.edges = this.edge.slice();
      res.flow = flow;
      if (detectOut) {
        res.segments = detectOut.segments;
        res.candidates = detectOut.candidates.slice(0, 8);
      }
    }
    return res;
  }

  // ───────────── края ─────────────

  private frameRgba: Uint8ClampedArray | Uint8Array | null = null;
  private edgesReady = false;
  /** карта краёв текущего кадра (лениво) */
  private ensureEdges() {
    if (this.edgesReady || !this.frameRgba) return;
    this.edgesReady = true;
    this.edges(this.frameRgba);
  }

  /** серый = размытие [1 4 6 4 1] яркости (то же, что яркость размытых каналов: обе операции линейны) */
  private grayOnly(rgba: Uint8ClampedArray | Uint8Array) {
    const n = this.w * this.h, g = this.gray;
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    this.blur5(g);
  }

  private edges(rgba: Uint8ClampedArray | Uint8Array) {
    const { w, h } = this;
    const n = w * h;
    const [R, G, B] = this.ch;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      R[i] = rgba[j];
      G[i] = rgba[j + 1];
      B[i] = rgba[j + 2];
    }
    for (const c of this.ch) this.blur5(c);

    const { jxx, jxy, jyy, mag, theta } = this;
    jxx.fill(0);
    jxy.fill(0);
    jyy.fill(0);
    mag.fill(0);
    for (const c of this.ch) {
      for (let y = 1; y < h - 1; y++) {
        let i = y * w + 1;
        for (let x = 1; x < w - 1; x++, i++) {
          const a = c[i - w - 1], b = c[i - w], cc = c[i - w + 1], d = c[i - 1], f = c[i + 1], g = c[i + w - 1], hh = c[i + w], k = c[i + w + 1];
          const gx = (cc + 2 * f + k - a - 2 * d - g) * 0.25;
          const gy = (g + 2 * hh + k - a - 2 * b - cc) * 0.25;
          jxx[i] += gx * gx;
          jxy[i] += gx * gy;
          jyy[i] += gy * gy;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const a = jxx[i], b = jxy[i], c = jyy[i];
      const m = (a + c) * 0.5, d = Math.sqrt((a - c) * (a - c) * 0.25 + b * b);
      mag[i] = Math.sqrt(m + d);
    }
    // подавление немаксимумов (направление — без тригонометрии: по знакам 2θ = atan2(2·jxy, jxx − jyy)) + порог
    const edge = this.edge;
    edge.fill(0);
    const hist = new Uint32Array(512);
    let cnt = 0;
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const m = mag[i];
        if (m < 2) continue;
        const A = jxx[i] - jyy[i], B = 2 * jxy[i];
        let o: number;
        if (A > 0 && B < A && B > -A) o = 1; // градиент ~горизонтален (|θ| < 22.5°)
        else if (A < 0 && B < -A && B > A) o = w; // ~вертикален
        else o = B > 0 ? w + 1 : w - 1;
        if (m >= mag[i + o] && m > mag[i - o]) {
          edge[i] = 1;
          hist[m >= 511 ? 511 : m | 0]++;
          cnt++;
        }
      }
    }
    const target = cnt * this.params.edgePct;
    let acc = 0, pct = 0;
    for (let k = 0; k < 512; k++) {
      acc += hist[k];
      if (acc >= target) {
        pct = k;
        break;
      }
    }
    this.thr = Math.max(this.params.minEdge, this.params.edgeRatio * pct);
    const thr = this.thr;
    for (let i = 0; i < n; i++) {
      if (!edge[i]) continue;
      if (mag[i] < thr) edge[i] = 0;
      else theta[i] = 0.5 * Math.atan2(2 * jxy[i], jxx[i] - jyy[i]); // ось градиента, (−π/2, π/2]
    }
  }

  /** размытие ядром [1 4 6 4 1]/16 по x и y */
  private blur5(c: Float32Array) {
    const { w, h, tmp } = this;
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const xm2 = x < 2 ? 0 : x - 2, xm1 = x < 1 ? 0 : x - 1, xp1 = x + 1 >= w ? w - 1 : x + 1, xp2 = x + 2 >= w ? w - 1 : x + 2;
        tmp[r + x] = (c[r + xm2] + 4 * c[r + xm1] + 6 * c[r + x] + 4 * c[r + xp1] + c[r + xp2]) * 0.0625;
      }
    }
    for (let y = 0; y < h; y++) {
      const ym2 = (y < 2 ? 0 : y - 2) * w, ym1 = (y < 1 ? 0 : y - 1) * w, yp1 = (y + 1 >= h ? h - 1 : y + 1) * w, yp2 = (y + 2 >= h ? h - 1 : y + 2) * w, r = y * w;
      for (let x = 0; x < w; x++) c[r + x] = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[r + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) * 0.0625;
    }
  }

  // ───────────── отрезки ─────────────

  segments(): Segment[] {
    this.ensureEdges();
    const { w, h, edge, mag, theta, used } = this;
    const p = this.params;
    used.fill(0);
    const minLen = p.minSegFrac * Math.min(w, h);
    // семена по убыванию силы (сортировка подсчётом)
    const buckets: number[][] = Array.from({ length: 64 }, () => []);
    const n = w * h;
    for (let i = 0; i < n; i++) if (edge[i]) buckets[Math.min(63, (mag[i] / 8) | 0)].push(i);
    const out: Segment[] = [];
    const stack: number[] = [];
    const region: number[] = [];
    const cosTol2 = Math.cos(2 * p.angleTol);
    const NB = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
    for (let b = 63; b >= 0; b--) {
      for (const seed of buckets[b]) {
        if (used[seed]) continue;
        // рост области: соседи-края с той же ориентацией и на одной прямой
        region.length = 0;
        stack.length = 0;
        stack.push(seed);
        used[seed] = 1;
        let c2 = Math.cos(2 * theta[seed]), s2 = Math.sin(2 * theta[seed]);
        let cmean = c2, smean = s2;
        const ang = theta[seed];
        let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, cnt = 0, smag = 0;
        let lnx = Math.cos(ang), lny = Math.sin(ang), lc = 0, lineOk = false;
        while (stack.length) {
          const i = stack.pop()!;
          region.push(i);
          const x = i % w, y = (i / w) | 0;
          sx += x;
          sy += y;
          sxx += x * x;
          syy += y * y;
          sxy += x * y;
          cnt++;
          smag += mag[i];
          if (cnt >= 6 && (cnt & 3) === 0) {
            const mx = sx / cnt, my = sy / cnt;
            const cxx = sxx / cnt - mx * mx, cyy = syy / cnt - my * my, cxy = sxy / cnt - mx * my;
            const dir = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
            lnx = -Math.sin(dir);
            lny = Math.cos(dir);
            lc = lnx * mx + lny * my;
            lineOk = true;
          }
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          for (const o of NB) {
            const q = i + o;
            if (!edge[q] || used[q]) continue;
            const tq = theta[q];
            const cq = Math.cos(2 * tq), sq = Math.sin(2 * tq);
            // |θq − θобласти| < angleTol ⇔ cos(2Δ) > cos(2·angleTol)
            if (cq * cmean + sq * smean < cosTol2) continue;
            if (lineOk && Math.abs(lnx * (q % w) + lny * ((q / w) | 0) - lc) > 1.25) continue;
            used[q] = 1;
            stack.push(q);
            c2 += cq;
            s2 += sq;
            const l2 = Math.hypot(c2, s2) || 1;
            cmean = c2 / l2;
            smean = s2 / l2;
          }
        }
        if (cnt < Math.max(5, minLen * 0.3)) continue;
        const mx = sx / cnt, my = sy / cnt;
        const cxx = sxx / cnt - mx * mx, cyy = syy / cnt - my * my, cxy = sxy / cnt - mx * my;
        let dir = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
        const dx = Math.cos(dir), dy = Math.sin(dir);
        let tmin = Infinity, tmax = -Infinity, perp = 0;
        for (const i of region) {
          const x = i % w - mx, y = ((i / w) | 0) - my;
          const t = x * dx + y * dy;
          if (t < tmin) tmin = t;
          if (t > tmax) tmax = t;
          perp += (x * -dy + y * dx) ** 2;
        }
        const len = tmax - tmin + 1;
        // короткие куски тоже берём: их склеит mergeCollinear (край карты, рассечённый линиями фона)
        if (len < Math.max(5, minLen * 0.3) || Math.sqrt(perp / cnt) > 1.2) continue;
        // плотность: отрезок без больших дыр
        if (cnt < 0.6 * len) continue;
        if (dir < 0) dir += Math.PI;
        const x1 = mx + dx * tmin, y1 = my + dy * tmin, x2 = mx + dx * tmax, y2 = my + dy * tmax;
        const a = -dy, bb = dx;
        out.push({ x1, y1, x2, y2, len, dir, line: { a, b: bb, c: a * mx + bb * my }, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, mag: smag / cnt });
      }
    }
    return mergeCollinear(out).filter((s) => s.len >= minLen);
  }

  // ───────────── поиск четырёхугольников ─────────────

  private detect(): { segments: Segment[]; candidates: Candidate[] } {
    const p = this.params;
    const { w, h } = this;
    // длина выше cap уже не добавляет веса: иначе длинные слабые волокна дерева вытесняют короткие контрастные стороны дальней карты
    const cap = 0.2 * Math.min(w, h);
    const rank = (s: Segment) => Math.min(s.len, cap) * Math.pow(s.mag, 0.8);
    const all = this.segments().sort((a, b) => rank(b) - rank(a));
    if (all.length > 120) all.length = 120;
    const cands: Candidate[] = [];
    const area0 = w * h;
    const mo = p.outside * Math.max(w, h);
    const minSide = 0.6 * p.minSegFrac * Math.min(w, h);
    const seen = new Set<string>();
    /** четырёхугольник из прямых четырёх сторон по кругу: s0 (c0→c1), s1 (c1→c2), s2 (c2→c3), s3 (c3→c0) */
    const tryQuad = (s0: Segment, s1: Segment, s2: Segment, s3: Segment) => {
      const c0 = intersect(s3.line, s0.line), c1 = intersect(s0.line, s1.line), c2 = intersect(s1.line, s2.line), c3 = intersect(s2.line, s3.line);
      if (!c0 || !c1 || !c2 || !c3) return;
      const q = [c0, c1, c2, c3];
      if (q.some((c) => c.x < -mo || c.y < -mo || c.x > w + mo || c.y > h + mo)) return;
      if (!isConvex(q)) return;
      const area = Math.abs(signedArea(q));
      if (area < p.minAreaFrac * area0 || area > p.maxAreaFrac * area0) return;
      if (!onSide(s0, c0, c1) || !onSide(s1, c1, c2) || !onSide(s2, c2, c3) || !onSide(s3, c3, c0)) return;
      if (Math.min(dist(c0, c1), dist(c1, c2), dist(c2, c3), dist(c3, c0)) < minSide) return;
      const key = q.map((c) => `${Math.round(c.x / 2)},${Math.round(c.y / 2)}`).sort().join(';');
      if (seen.has(key)) return;
      seen.add(key);
      const cand = this.evaluate(orderClockwise(q));
      if (cand) cands.push(cand);
    };

    // А. Углы: пары непараллельных отрезков, сходящихся концами (L-стык). Карта даёт 4 таких стыка,
    // а параллельные линии фона (волокна, строки текста) — ни одного. Цепочка «стык — сторона — стык»
    // даёт три стороны; четвёртую ищем среди отрезков, примерно параллельных средней.
    const M = all.length;
    const ends: number[][] = Array.from({ length: M }, () => []); // ends[j] — номера стыков j
    const jn: { i: number; j: number; endI: number; endJ: number }[] = [];
    for (let i = 0; i < M; i++)
      for (let j = i + 1; j < M; j++) {
        const a = all[i], b = all[j];
        if (angDiffPi(a.dir, b.dir) < p.minAdjAngle) continue;
        const c = intersect(a.line, b.line);
        if (!c) continue;
        const ea = nearEnd(a, c), eb = nearEnd(b, c);
        if (ea < 0 || eb < 0) continue;
        ends[i].push(jn.length);
        ends[j].push(jn.length);
        jn.push({ i, j, endI: ea, endJ: eb });
      }
    let budget = 4000;
    for (let j = 0; j < M && budget > 0; j++) {
      // стыки на разных концах отрезка j
      const at: number[][] = [[], []];
      for (const k of ends[j]) {
        const J = jn[k];
        const other = J.i === j ? J.j : J.i;
        at[J.i === j ? J.endI : J.endJ].push(other);
      }
      if (!at[0].length || !at[1].length) continue;
      const sj = all[j];
      for (const i of at[0])
        for (const k of at[1]) {
          if (i === k) continue;
          // противоположная j сторона: примерно параллельна, по другую сторону, не короче 30% j
          for (let l = 0; l < M && budget > 0; l++) {
            if (l === i || l === j || l === k) continue;
            const sl = all[l];
            if (angDiffPi(sl.dir, sj.dir) > p.maxOppAngle) continue;
            budget--;
            tryQuad(sj, all[k], sl, all[i]);
            tryQuad(sj, all[i], sl, all[k]);
          }
        }
    }

    // Б. Пары «противоположных сторон» среди самых сильных отрезков (страховка, если углы закрыты/размыты)
    const segs = all.slice(0, p.maxSegs);
    const minSep = 0.06 * Math.min(w, h);
    const pairs: { i: number; j: number; dir: number; s: number }[] = [];
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        if (angDiffPi(a.dir, b.dir) > p.maxOppAngle) continue;
        const d1 = Math.abs(a.line.a * b.mx + a.line.b * b.my - a.line.c), d2 = Math.abs(b.line.a * a.mx + b.line.b * a.my - b.line.c);
        if (d1 < minSep || d2 < minSep) continue;
        const c2 = Math.cos(2 * a.dir) * a.len + Math.cos(2 * b.dir) * b.len, s2 = Math.sin(2 * a.dir) * a.len + Math.sin(2 * b.dir) * b.len;
        let dir = 0.5 * Math.atan2(s2, c2);
        if (dir < 0) dir += Math.PI;
        pairs.push({ i, j, dir, s: rank(a) + rank(b) });
      }
    pairs.sort((a, b) => b.s - a.s);
    // каждый отрезок — не больше чем в 8 парах (иначе параллельные волокна дерева вытесняют карту)
    const per = new Uint8Array(segs.length);
    const kept: typeof pairs = [];
    for (const pr of pairs) {
      if (per[pr.i] >= 8 || per[pr.j] >= 8) continue;
      per[pr.i]++;
      per[pr.j]++;
      kept.push(pr);
      if (kept.length >= p.maxPairs) break;
    }
    for (let a = 0; a < kept.length; a++) {
      const A = kept[a];
      for (let b = a + 1; b < kept.length; b++) {
        const B = kept[b];
        if (A.i === B.i || A.i === B.j || A.j === B.i || A.j === B.j) continue;
        if (angDiffPi(A.dir, B.dir) < p.minAdjAngle) continue;
        tryQuad(segs[A.i], segs[B.j], segs[A.j], segs[B.i]);
      }
    }
    const outSegs = all;
    cands.sort((a, b) => b.score - a.score);
    // дубликаты
    const uniq: Candidate[] = [];
    for (const c of cands) {
      if (uniq.some((u) => quadDistance(alignQuad(c.quad, u.quad), u.quad) < 0.03 * quadDiag(u.quad))) continue;
      uniq.push(c);
      if (uniq.length >= 12) break;
    }
    // уточняем лучших и пересчитываем оценку
    const refined: Candidate[] = [];
    for (const c of uniq.slice(0, 4)) {
      const r = this.refine(c.quad, p.refineRange);
      const e = r ? this.evaluate(r) : null;
      refined.push(e && e.score >= c.score * 0.9 ? e : c);
    }
    refined.push(...uniq.slice(4));
    refined.sort((a, b) => b.score - a.score);
    // напечатанный внутри карты прямоугольник (чип, рамка дизайна) не должен выигрывать у самой карты
    const top = refined[0];
    if (top) {
      for (const c of refined) {
        if (c === top || c.score < top.score * 0.92) continue;
        if (top.quad.every((pt) => pointInQuad(pt, c.quad)) && Math.abs(signedArea(c.quad)) > 1.3 * Math.abs(signedArea(top.quad))) {
          refined.splice(refined.indexOf(c), 1);
          refined.unshift(c);
          break;
        }
      }
    }
    return { segments: outSegs, candidates: refined };
  }

  /** Оценка четырёхугольника: подтверждение сторон краем × метрика × размер. null — не карта. */
  evaluate(q: Quad): Candidate | null {
    this.ensureEdges();
    const p = this.params;
    if (!isConvex(q)) return null;
    const m = metricShape(q, this.K);
    if (!m) return null;
    const a = m.aspect >= 1 ? m.aspect : 1 / m.aspect;
    const ea = Math.abs(Math.log(a / p.aspect));
    if (ea > p.aspectTol || Math.abs(m.cos) > p.cosTol) return null;
    const sides = [0, 1, 2, 3].map((k) => this.sideSupport(q[k], q[(k + 1) % 4]));
    const sup = sides.map((s) => s.support);
    const sorted = [...sup].sort((x, y) => x - y);
    const mean = (sup[0] + sup[1] + sup[2] + sup[3]) / 4;
    if (mean < p.minSupport || sorted[1] < p.minSide2) return null;
    const area = Math.abs(signedArea(q)) / (this.w * this.h);
    const fa = Math.exp(-((ea / (p.aspectTol * 0.6)) ** 2));
    const fc = Math.exp(-((m.cos / (p.cosTol * 0.7)) ** 2));
    const fs = 0.8 + 0.2 * Math.min(1, Math.sqrt(area / 0.12));
    // минимум + среднее: одна плохая сторона снижает оценку, но не обнуляет
    const s = 0.65 * mean + 0.35 * (sorted[0] + sorted[1]) / 2;
    // стороны карты кончаются в углах; линия, уходящая дальше (волокно дерева, край стола), — не сторона карты
    const over = (sides[0].over + sides[1].over + sides[2].over + sides[3].over) / 4;
    const maxOver = Math.max(sides[0].over, sides[1].over, sides[2].over, sides[3].over);
    const fo = 1 - 0.35 * over - 0.15 * maxOver;
    // контраст: край карты обычно сильнее текстуры фона
    const magMean = (sides[0].mag + sides[1].mag + sides[2].mag + sides[3].mag) / 4;
    const fm = Math.min(1, magMean / (3 * this.thr));
    // все четыре стороны — край одного предмета: контраст сторон не различается в разы
    const mags = sides.map((x) => x.mag);
    const fk = Math.min(1, 0.4 + 1.5 * (Math.min(...mags) / Math.max(1e-6, Math.max(...mags))));
    const score = Math.min(1, s * (0.55 + 0.45 * fa) * (0.7 + 0.3 * fc) * fs * fo * fk * (0.75 + 0.25 * fm));
    return { quad: q, score, support: sup, aspect: a, cos: m.cos };
  }

  /**
   * Сторона (A → B): support — доля точек (без 10% у углов — там скругление), где есть край нужной ориентации;
   * mag — средняя сила этого края; over — доля точек продолжения прямой за углами (12–30% длины), где край
   * тоже есть (у настоящей карты сторона в углу кончается).
   */
  private sideSupport(A: Pt, B: Pt): { support: number; mag: number; over: number } {
    const { w, h, edge, theta, mag } = this;
    const L = dist(A, B);
    const N = Math.max(8, Math.min(48, Math.round(L / 2.5)));
    const dx = (B.x - A.x) / L, dy = (B.y - A.y) / L;
    const nx = -dy, ny = dx;
    const nAng = Math.atan2(ny, nx);
    const probe = (t: number, r = 2): number => {
      const px = A.x + (B.x - A.x) * t, py = A.y + (B.y - A.y) * t;
      if (px < 2 || py < 2 || px > w - 3 || py > h - 3) return -1; // за кадром — не считаем
      for (let k = -r; k <= r; k++) {
        const x = Math.round(px + nx * k), y = Math.round(py + ny * k);
        const i = y * w + x;
        if (edge[i] && angDiffPi(theta[i], nAng) < 0.35) return mag[i];
      }
      return 0;
    };
    let hit = 0, tot = 0, sm = 0;
    for (let s = 0; s < N; s++) {
      const v = probe(0.1 + (0.8 * (s + 0.5)) / N);
      if (v < 0) continue;
      tot++;
      if (v > 0) {
        hit++;
        sm += v;
      }
    }
    const M = 8;
    const mean = hit ? sm / hit : 0;
    let oh = 0, ot = 0;
    for (let s = 0; s < M; s++) {
      const t = 0.12 + (0.18 * (s + 0.5)) / M;
      for (const tt of [-t, 1 + t]) {
        const v = probe(tt, 1);
        if (v < 0) continue;
        ot++;
        // считаем только край сравнимой силы: слабое волокно стола на продолжении стороны не мешает
        if (v > 0.6 * mean) oh++;
      }
    }
    // сторона почти целиком за кадром: не подтверждена
    if (tot < N * 0.4) return { support: 0, mag: 0, over: 0 };
    return { support: hit / tot, mag: mean, over: ot >= 4 ? oh / ot : 0 };
  }

  /** производная цвета вдоль нормали n в пикселе (из тензора) */
  private gN(x: number, y: number, nx: number, ny: number): number {
    const { w, h } = this;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 1 || y0 < 1 || x0 >= w - 2 || y0 >= h - 2) return 0;
    const fx = x - x0, fy = y - y0;
    const v = (i: number) => Math.sqrt(Math.max(0, this.jxx[i] * nx * nx + 2 * this.jxy[i] * nx * ny + this.jyy[i] * ny * ny));
    const i = y0 * w + x0;
    return (v(i) * (1 - fx) + v(i + 1) * fx) * (1 - fy) + (v(i + w) * (1 - fx) + v(i + w + 1) * fx) * fy;
  }

  /** Уточнение сторон: максимум градиента по нормали в ±range px, робастная прямая; углы — пересечения. */
  refine(q: Quad, range: number): Quad | null {
    this.ensureEdges();
    const lines: Line[] = [];
    const thr = this.thr * 0.6;
    for (let k = 0; k < 4; k++) {
      const A = q[k], B = q[(k + 1) % 4];
      const L = dist(A, B);
      const dx = (B.x - A.x) / L, dy = (B.y - A.y) / L;
      const nx = -dy, ny = dx;
      const N = Math.max(10, Math.min(60, Math.round(L / 2)));
      const pts: Pt[] = [];
      for (let s = 0; s < N; s++) {
        const t = 0.1 + (0.8 * (s + 0.5)) / N;
        const px = A.x + (B.x - A.x) * t, py = A.y + (B.y - A.y) * t;
        let bk = 0, bv = -1, vm = 0, vp = 0;
        for (let o = -range; o <= range; o++) {
          const v = this.gN(px + nx * o, py + ny * o, nx, ny);
          if (v > bv) {
            bv = v;
            bk = o;
          }
        }
        if (bv < thr || bk === -range || bk === range) continue;
        vm = this.gN(px + nx * (bk - 1), py + ny * (bk - 1), nx, ny);
        vp = this.gN(px + nx * (bk + 1), py + ny * (bk + 1), nx, ny);
        const den = vm - 2 * bv + vp;
        const sub = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (vm - vp)) / den)) : 0;
        pts.push({ x: px + nx * (bk + sub), y: py + ny * (bk + sub) });
      }
      const fit = pts.length >= Math.max(5, N * 0.3) ? robustLine(pts, { a: nx, b: ny, c: nx * A.x + ny * A.y }) : null;
      lines.push(fit ?? { a: nx, b: ny, c: nx * A.x + ny * A.y });
    }
    const out: Pt[] = [];
    for (let k = 0; k < 4; k++) {
      const c = intersect(lines[(k + 3) % 4], lines[k]);
      if (!c) return null;
      out.push(c);
    }
    if (!isConvex(out)) return null;
    // нумерация как у входа
    return out as Quad;
  }

  // ───────────── трекинг ─────────────

  private buildPyramid() {
    const [w0] = this.pyrDims[0];
    this.pyr[0].set(this.gray);
    for (let l = 1; l < this.pyr.length; l++) {
      const [pw] = this.pyrDims[l - 1];
      const [lw, lh] = this.pyrDims[l];
      const src = this.pyr[l - 1], dst = this.pyr[l];
      for (let y = 0; y < lh; y++)
        for (let x = 0; x < lw; x++) {
          const i = 2 * y * pw + 2 * x;
          dst[y * lw + x] = (src[i] + src[i + 1] + src[i + pw] + src[i + pw + 1]) * 0.25;
        }
    }
    void w0;
  }

  private trackStep(prev: Quad, debug?: boolean): { cand: Candidate | null; flow?: DetectResult['flow'] } {
    const pts = this.features(prev);
    const tracked: { a: Pt; b: Pt }[] = [];
    const flow: DetectResult['flow'] = [];
    for (const a of pts) {
      const g = this.guess(a);
      const b = lk(this.prevPyr, this.pyr, this.pyrDims, a, g);
      let ok = false;
      if (b) {
        const back = lk(this.pyr, this.prevPyr, this.pyrDims, b, g && { x: -g.x, y: -g.y });
        ok = !!back && dist(back, a) < 0.8;
        if (ok) tracked.push({ a, b });
      }
      if (debug) flow.push({ x: b?.x ?? a.x, y: b?.y ?? a.y, ok });
    }
    let pred: Quad = prev;
    const H = ransacHomography(tracked, 2);
    if (H) this.lastH = H;
    if (H) pred = prev.map((c) => applyH(H, c)) as Quad;
    else if (tracked.length >= 3) {
      const dx = median(tracked.map((t) => t.b.x - t.a.x)), dy = median(tracked.map((t) => t.b.y - t.a.y));
      pred = prev.map((c) => ({ x: c.x + dx, y: c.y + dy })) as Quad;
    }
    let r = this.refine(pred, 6);
    if (r) r = this.refine(r, 2) ?? r;
    const cand = r ? this.evaluate(r) : null;
    return { cand, flow: debug ? flow : undefined };
  }

  /**
   * Карта не подтверждается краями — двигаем её вместе с поверхностью стола: точки текстуры вокруг карты
   * (карта ушла из кадра — по всему кадру), поток Лукаса–Канаде туда-обратно, гомография плоскости по RANSAC
   * (стол — самая большая плоскость в кадре; бутылки и руки отсеиваются как выбросы).
   */
  private planeStep(prev: Quad): Quad | null {
    const { w, h } = this;
    // точки вокруг карты берём, только пока карта в основном в кадре; иначе — весь кадр
    const pc = { x: (prev[0].x + prev[2].x) / 2, y: (prev[0].y + prev[2].y) / 2 };
    const inside = pc.x > w * 0.1 && pc.x < w * 0.9 && pc.y > h * 0.1 && pc.y < h * 0.9;
    const near = inside ? this.features(prev, 3.2, 96) : [];
    const whole = this.featuresRect(6, 6, w - 7, h - 7, 120);
    // попытки: возле карты с прогнозом → весь кадр с прогнозом → весь кадр без прогноза (пирамида)
    const tries: [Pt[], boolean, number][] = [];
    if (near.length >= 24) tries.push([near, true, 24]);
    if (this.lastH) tries.push([whole, true, 20]);
    tries.push([whole, false, 20]);
    let H: number[] | null = null;
    for (const [pts, useGuess, minInl] of tries) {
      H = this.planeH(pts, useGuess, minInl);
      if (H) break;
    }
    // прогноз движения обновляем только удачным шагом: одна осечка не должна сбивать следующие
    if (H) (this.lastH = H), (this.planeMiss = 0);
    else if (++this.planeMiss > 4) this.lastH = null;
    const info = this.planeInfo;
    if (!H) return null;
    const q = prev.map((c) => applyH(H!, c)) as Quad;
    // вырожденное преобразование (сложилась, перевернулась, улетела) — лучше потерять, чем показать кривого кота
    if (!isConvex(q) || signedArea(q) * signedArea(prev) <= 0) return (info.why = 'degenerate'), null;
    const a0 = Math.abs(signedArea(prev)), a1 = Math.abs(signedArea(q));
    if (a1 < a0 * 0.6 || a1 > a0 * 1.6) return (info.why = 'scale-jump'), null;
    const diag = quadDiag(q);
    const cx = (q[0].x + q[2].x) / 2, cy = (q[0].y + q[2].y) / 2;
    if (cx < -2 * w || cx > 3 * w || cy < -2 * h || cy > 3 * h || diag < 8 || diag > 6 * Math.hypot(w, h)) return (info.why = 'far'), null;
    info.why = 'ok';
    return q;
  }

  /** гомография плоскости между кадрами по точкам pts (поток туда-обратно + RANSAC) */
  private planeH(pts: Pt[], useGuess: boolean, minInl = 10): number[] | null {
    const tracked: { a: Pt; b: Pt }[] = [];
    for (const a of pts) {
      const g = useGuess ? this.guess(a) : undefined;
      const b = lk(this.prevPyr, this.pyr, this.pyrDims, a, g);
      if (!b) continue;
      const back = lk(this.pyr, this.prevPyr, this.pyrDims, b, g && { x: -g.x, y: -g.y });
      if (back && dist(back, a) < 0.8) tracked.push({ a, b });
    }
    const info = (this.planeInfo = { pts: pts.length, tracked: tracked.length, inliers: 0, why: '' });
    if (tracked.length < 12) return (info.why = 'few-tracked'), null;
    const H = ransacHomography(tracked, 2);
    if (!H) return (info.why = 'no-H'), null;
    let inl = 0;
    for (const t of tracked) if (dist(applyH(H, t.a), t.b) < 2) inl++;
    info.inliers = inl;
    if (inl < minInl || inl < tracked.length * 0.4) return (info.why = 'few-inliers'), null;
    return H;
  }

  /** точки для потока: «уголки» (минимальное собственное число) в окрестности карты */
  private features(q: Quad, grow = 1.6, max = 48): Pt[] {
    const { w, h } = this;
    const c = { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const p of q) {
      const ex = c.x + (p.x - c.x) * grow, ey = c.y + (p.y - c.y) * grow;
      x0 = Math.min(x0, ex);
      y0 = Math.min(y0, ey);
      x1 = Math.max(x1, ex);
      y1 = Math.max(y1, ey);
    }
    return this.featuresRect(Math.max(6, Math.floor(x0)), Math.max(6, Math.floor(y0)), Math.min(w - 7, Math.ceil(x1)), Math.min(h - 7, Math.ceil(y1)), max);
  }

  private featuresRect(x0: number, y0: number, x1: number, y1: number, max: number): Pt[] {
    const g = this.prevPyr[0];
    const { w } = this;
    if (x1 - x0 < 8 || y1 - y0 < 8) return [];
    const cell = Math.max(6, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / (max * 1.35))));
    const out: { p: Pt; e: number }[] = [];
    for (let cy = y0; cy < y1; cy += cell)
      for (let cx = x0; cx < x1; cx += cell) {
        let be = 0, bx = 0, by = 0;
        for (let y = cy; y < Math.min(y1, cy + cell); y += 2)
          for (let x = cx; x < Math.min(x1, cx + cell); x += 2) {
            let sxx = 0, syy = 0, sxy = 0;
            for (let v = -2; v <= 2; v++)
              for (let u = -2; u <= 2; u++) {
                const i = (y + v) * w + x + u;
                const gx = (g[i + 1] - g[i - 1]) * 0.5, gy = (g[i + w] - g[i - w]) * 0.5;
                sxx += gx * gx;
                syy += gy * gy;
                sxy += gx * gy;
              }
            const e = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
            if (e > be) {
              be = e;
              bx = x;
              by = y;
            }
          }
        if (be > 25) out.push({ p: { x: bx, y: by }, e: be });
      }
    out.sort((a, b) => b.e - a.e);
    return out.slice(0, max).map((o) => o.p);
  }
}

/** сколько кадров подряд можно вести карту только по столу (~15 кадров/с → 40 с), дальше нужен повторный захват */
const MAX_PLANE_FRAMES = 600;

// ───────────── вспомогательное ─────────────

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Точка c (пересечение прямых) — у конца отрезка s? 0 — у (x1, y1), 1 — у (x2, y2), −1 — нет.
 * Допуск — скругление угла карты и разрывы края: до 3 px + 15% длины снаружи, до 20% длины внутри.
 */
function nearEnd(s: Segment, c: Pt): number {
  const dx = (s.x2 - s.x1) / s.len, dy = (s.y2 - s.y1) / s.len;
  const t = (c.x - s.x1) * dx + (c.y - s.y1) * dy;
  const out = 3 + 0.15 * s.len, inn = 0.2 * s.len;
  if (t > -out && t < inn) return 0;
  if (t > s.len - inn && t < s.len + out) return 1;
  return -1;
}

/** отрезок лежит на стороне (A, B): его проекция почти вся внутри стороны */
function onSide(s: Segment, A: Pt, B: Pt): boolean {
  const L = dist(A, B);
  if (L < 1e-6) return false;
  const dx = (B.x - A.x) / L, dy = (B.y - A.y) / L;
  const t1 = ((s.x1 - A.x) * dx + (s.y1 - A.y) * dy) / L, t2 = ((s.x2 - A.x) * dx + (s.y2 - A.y) * dy) / L;
  const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
  const inside = Math.max(0, Math.min(hi, 1.06) - Math.max(lo, -0.06));
  return inside >= 0.75 * (hi - lo);
}

/** слить почти коллинеарные отрезки с небольшим разрывом (шум, мелкие блики) */
function mergeCollinear(segs: Segment[]): Segment[] {
  segs.sort((a, b) => b.len - a.len);
  const out: Segment[] = [];
  for (const s of segs) {
    let merged = false;
    for (let k = 0; k < out.length; k++) {
      const o = out[k];
      if (angDiffPi(o.dir, s.dir) > 0.05) continue;
      // разный контраст — разные объекты (сторона карты и продолжающее её волокно стола)
      if (o.mag > 1.6 * s.mag || s.mag > 1.6 * o.mag) continue;
      // дешёвая проверка до подгонки: середина s рядом с прямой o
      if (Math.abs(o.line.a * s.mx + o.line.b * s.my - o.line.c) > 3) continue;
      const dx = Math.cos(o.dir), dy = Math.sin(o.dir);
      const ts = [o.x1, o.x2, s.x1, s.x2].map((x, i) => x * dx + [o.y1, o.y2, s.y1, s.y2][i] * dy);
      const oLo = Math.min(ts[0], ts[1]), oHi = Math.max(ts[0], ts[1]), sLo = Math.min(ts[2], ts[3]), sHi = Math.max(ts[2], ts[3]);
      const gap = Math.max(sLo - oHi, oLo - sHi);
      if (gap > Math.max(6, 0.15 * (o.len + s.len))) continue;
      // общая прямая по концам обоих: все концы должны лежать на ней
      const fit = robustLine(
        [{ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }],
        o.line,
      );
      if (!fit) continue;
      const res = Math.max(...[o.x1, o.x2, s.x1, s.x2].map((x, i) => Math.abs(fit.a * x + fit.b * [o.y1, o.y2, s.y1, s.y2][i] - fit.c)));
      if (res > 1.5) continue;
      // новый отрезок по крайним точкам (вес — длина)
      const W = o.len + s.len;
      const mx = (o.mx * o.len + s.mx * s.len) / W, my = (o.my * o.len + s.my * s.len) / W;
      const lo = Math.min(oLo, sLo), hi = Math.max(oHi, sHi);
      const t0 = mx * dx + my * dy;
      const x1 = mx + (lo - t0) * dx, y1 = my + (lo - t0) * dy, x2 = mx + (hi - t0) * dx, y2 = my + (hi - t0) * dy;
      const a = -dy, b = dx;
      out[k] = { x1, y1, x2, y2, len: hi - lo, dir: o.dir, line: { a, b, c: a * mx + b * my }, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, mag: (o.mag * o.len + s.mag * s.len) / W };
      merged = true;
      break;
    }
    if (!merged) out.push(s);
  }
  return out;
}

/** прямая по точкам: МНК (полный) с весами Хьюбера, 3 итерации */
function robustLine(pts: Pt[], init: Line): Line | null {
  let line = init;
  let first = true;
  for (let it = 0; it < 4; it++) {
    let sw = 0, sx = 0, sy = 0;
    const ws = pts.map((p) => {
      if (first) return 1;
      const r = Math.abs(line.a * p.x + line.b * p.y - line.c);
      return r < 0.7 ? 1 : 0.7 / r;
    });
    first = false;
    pts.forEach((p, i) => {
      sw += ws[i];
      sx += ws[i] * p.x;
      sy += ws[i] * p.y;
    });
    if (sw < 1e-6) return null;
    const mx = sx / sw, my = sy / sw;
    let cxx = 0, cyy = 0, cxy = 0;
    pts.forEach((p, i) => {
      const dx = p.x - mx, dy = p.y - my;
      cxx += ws[i] * dx * dx;
      cyy += ws[i] * dy * dy;
      cxy += ws[i] * dx * dy;
    });
    const dir = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let a = -Math.sin(dir), b = Math.cos(dir);
    // сохраняем ориентацию нормали как у исходной прямой
    if (a * init.a + b * init.b < 0) {
      a = -a;
      b = -b;
    }
    line = { a, b, c: a * mx + b * my };
  }
  return line;
}

function sample(img: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > w - 1.001) x = w - 1.001;
  if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}

/** пирамидальный Лукас–Канаде для одной точки; окно 9×9, null — потеряна */
/** guess — ожидаемое смещение (px полного размера): движение прошлого кадра; без него повторяющийся узор стола «ловит» не тот период */
function lk(A: Float32Array[], B: Float32Array[], dims: [number, number][], p: Pt, guess?: Pt): Pt | null {
  const R = 4;
  const top = 1 << (A.length - 1);
  let gx = guess ? guess.x / top : 0, gy = guess ? guess.y / top : 0; // смещение на текущем уровне
  for (let l = A.length - 1; l >= 0; l--) {
    const [w, h] = dims[l];
    const s = 1 / (1 << l);
    const px = p.x * s, py = p.y * s;
    if (px < R + 1 || py < R + 1 || px > w - R - 2 || py > h - R - 2) {
      if (l === 0) return null;
      gx *= 2;
      gy *= 2;
      continue;
    }
    const a = A[l], b = B[l];
    let sxx = 0, syy = 0, sxy = 0;
    const ix: number[] = [], iy: number[] = [], iv: number[] = [];
    for (let v = -R; v <= R; v++)
      for (let u = -R; u <= R; u++) {
        const x = px + u, y = py + v;
        const dx = (sample(a, w, h, x + 1, y) - sample(a, w, h, x - 1, y)) * 0.5;
        const dy = (sample(a, w, h, x, y + 1) - sample(a, w, h, x, y - 1)) * 0.5;
        ix.push(dx);
        iy.push(dy);
        iv.push(sample(a, w, h, x, y));
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
      }
    const det = sxx * syy - sxy * sxy;
    if (det < 1e-3) return null;
    let vx = 0, vy = 0;
    for (let it = 0; it < 10; it++) {
      let bx = 0, by = 0, k = 0;
      for (let v = -R; v <= R; v++)
        for (let u = -R; u <= R; u++, k++) {
          const d = iv[k] - sample(b, w, h, px + u + gx + vx, py + v + gy + vy);
          bx += d * ix[k];
          by += d * iy[k];
        }
      const ex = (syy * bx - sxy * by) / det, ey = (sxx * by - sxy * bx) / det;
      vx += ex;
      vy += ey;
      if (ex * ex + ey * ey < 0.0009) break;
    }
    gx += vx;
    gy += vy;
    if (l > 0) {
      gx *= 2;
      gy *= 2;
    }
  }
  const out = { x: p.x + gx, y: p.y + gy };
  return Number.isFinite(out.x) && Number.isFinite(out.y) ? out : null;
}

/** гомография движения по трекам (RANSAC по 4 точкам, затем МНК по инлаерам) */
export function ransacHomography(tr: { a: Pt; b: Pt }[], thr: number): number[] | null {
  if (tr.length < 8) return null;
  let best: number[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < 60; it++) {
    const idx = new Set<number>();
    while (idx.size < 4) idx.add(Math.floor(rnd() * tr.length));
    const s = [...idx].map((i) => tr[i]);
    const H = homography(s.map((t) => t.a), s.map((t) => t.b));
    if (!H) continue;
    const inl: number[] = [];
    tr.forEach((t, i) => {
      const p = applyH(H, t.a);
      if (Math.hypot(p.x - t.b.x, p.y - t.b.y) < thr) inl.push(i);
    });
    if (inl.length > best.length) best = inl;
  }
  if (best.length < Math.max(6, tr.length * 0.4)) return null;
  return homography(best.map((i) => tr[i].a), best.map((i) => tr[i].b));
}
