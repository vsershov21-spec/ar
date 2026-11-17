/**
 * Обработка одного кадра в воркере — без DOM и без VideoFrame (их читает worker.ts), чтобы тот же код
 * гонять в тестах и на офлайн-стенде (tests/card/bench.test.ts): детектор → проверка «карта Сбера» → блики.
 */
import { CardDetector } from './detector';
import { CardVerifier, type CropIn, type VerifyReport } from './verifier';

export interface PipelineIn {
  /** номер кадра (главный поток сопоставляет ответ с ориентацией телефона в момент съёмки) */
  id?: number;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  focal: number;
  reset?: boolean;
  /** кот посажен: держаться этой карты */
  lock?: boolean;
  /** где карта должна быть (кадр детектора), пока её не видно */
  hint?: { x: number; y: number }[] | null;
  /** насколько широко искать ту же карту вокруг hint (доли диагонали; растёт со временем потери) */
  hintRadius?: number;
  /** поворот камеры с прошлого кадра по гироскопу — 3×3 построчно, в осях изображения (x вправо, y вниз, z вперёд) */
  rot?: number[] | null;
  detectEvery?: number;
  verify?: boolean;
  crop?: CropIn | null;
  /** стенд «до»: без ключевого кадра и гироскопа — как до переработки */
  legacy?: boolean;
}

export interface PipelineOut {
  id?: number;
  quad: { x: number; y: number }[] | null;
  score: number;
  mode: string;
  ms: number;
  ver?: VerifyReport;
  /** доля пересвеченных точек на карте 0..1 (подсказка «меньше бликов») */
  glare?: number;
  /** сверка с ключевым кадром: ZNCC и доля согласных пикселей (только после посадки) */
  key?: { zncc: number; inl: number } | null;
  /** почему карты нет / почему ведём так (debug) */
  why?: string;
}

export class CardPipeline {
  readonly det = new CardDetector();
  readonly ver = new CardVerifier();
  private detectEvery = this.det.params.detectEvery;

  process(m: PipelineIn): PipelineOut | null {
    const det = this.det;
    if (m.reset) {
      det.reset();
      this.ver.reset();
      if (m.w <= 1) return null;
    }
    if (m.lock !== undefined) det.locked = m.lock;
    if (m.hint !== undefined) det.hint = (m.hint as never) ?? null;
    if (m.hintRadius !== undefined) det.hintRadius = m.hintRadius;
    det.gyroRot = m.legacy ? null : m.rot ?? null;
    det.params.keyframe = !m.legacy;
    if (m.detectEvery) this.detectEvery = m.detectEvery;
    // пока кот не посажен и идёт проверка «это карта Сбера?» — полный поиск через кадр: проверяем только кадры
    // полного поиска (точные углы). По времени полный поиск ≈ ведению потоком (края считаются в каждом кадре)
    det.params.detectEvery = !det.locked && m.verify !== false ? Math.min(2, this.detectEvery) : this.detectEvery;
    const r = det.process(m.rgba, m.w, m.h, { focal: m.focal });
    const out: PipelineOut = { id: m.id, quad: r.quad, score: r.score, mode: r.mode, ms: r.ms, key: det.keyInfo, why: det.why };
    if (m.verify !== false) {
      const t0 = now();
      out.ver = this.ver.step(det, r, { rgba: m.rgba, w: m.w, h: m.h }, { f: m.focal, cx: m.w / 2, cy: m.h / 2 }, now(), m.crop ?? null);
      out.ms += now() - t0;
    }
    if (r.quad) out.glare = glareOn(m.rgba, m.w, m.h, r.quad);
    return out;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** доля пересвеченных точек внутри четырёхугольника (сетка 16 × 10 по билинейной параметризации) */
export function glareOn(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, q: { x: number; y: number }[]): number {
  let hot = 0, tot = 0;
  for (let j = 0; j < 10; j++)
    for (let i = 0; i < 16; i++) {
      const u = 0.08 + (0.84 * (i + 0.5)) / 16, v = 0.08 + (0.84 * (j + 0.5)) / 10;
      const x = (1 - v) * ((1 - u) * q[0].x + u * q[1].x) + v * ((1 - u) * q[3].x + u * q[2].x);
      const y = (1 - v) * ((1 - u) * q[0].y + u * q[1].y) + v * ((1 - u) * q[3].y + u * q[2].y);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      const k = (yi * w + xi) * 4;
      tot++;
      if (Math.min(rgba[k], rgba[k + 1], rgba[k + 2]) > 238) hot++;
    }
  return tot ? hot / tot : 0;
}
