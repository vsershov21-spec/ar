/**
 * Обработка одного кадра в воркере — без DOM и без VideoFrame (их читает worker.ts), чтобы тот же код
 * гонять в тестах и на офлайн-стенде (tests/card/bench.test.ts): детектор → проверка «карта Сбера» → блики.
 */
import { CardDetector } from './detector';
import { CardVerifier, type CropIn, type VerifyReport } from './verifier';
import { HIT } from './verify';
import { alignQuad, quadDiag, quadDistance, type Quad } from './geometry';

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
  /** кот посажен, а позу трекер не принимает столько мс (HOLD/RELOCALIZE) — пора искать карту по содержимому */
  lostMs?: number;
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
  /** средняя яркость кадра 0..255 (подсказка «темно» без отдельного чтения кадра) */
  luma?: number;
  /** следующий кадр будет с полным поиском (до посадки к нему нужен фрагмент под проверку «Сбер») */
  detNext?: boolean;
  /** карту нашли заново по содержимому (знак/дизайн), когда кот сидел, а карта была потеряна */
  relocated?: boolean;
  /**
   * Кот сидит, карта была потеряна (lostMs > 0): свежая проверка «чья карта» именно у этого кандидата (CARD-01/02).
   * sber — уверенный знак Сбера / отпечаток дизайна под котом / узнана по содержимому (relocated); foreign — отпечаток
   * известной чужой карты; none — проверили, признаков нет. Нет поля — в этом кадре не проверяли (нет точных углов).
   * Без «sber» главный поток кота на кандидата не возвращает: геометрия — только подсказка.
   */
  fresh?: 'sber' | 'foreign' | 'none';
  /** время этапов, мс: подготовка кадра, ключевой кадр, поток/поверхность, полный поиск, проверка «Сбер», прочее */
  stages?: { pre: number; key: number; flow: number; detect: number; verify: number; other: number };
}

/** кот сидит, карты нет столько мс — ищем её полным поиском среди всех кандидатов кадра (relocalize) */
const RELOC_MS = 300;

export class CardPipeline {
  readonly det = new CardDetector();
  readonly ver = new CardVerifier();
  private detectEvery = this.det.params.detectEvery;
  /** узнавание той же карты Сбера после потери: кандидат и сколько проверок подряд он «Сбер» (at — номер проверки) */
  private reloc: { quad: Quad; hits: number; at: number } | null = null;
  private relocTick = 0;

  process(m: PipelineIn): PipelineOut | null {
    const det = this.det;
    if (m.reset) {
      det.reset();
      this.ver.reset();
      if (m.w <= 1) return null;
    }
    if (m.lock !== undefined) det.locked = m.lock;
    det.lost = det.locked && (m.lostMs ?? 0) > 0;
    if (m.hint !== undefined) det.hint = (m.hint as never) ?? null;
    if (m.hintRadius !== undefined) det.hintRadius = m.hintRadius;
    det.gyroRot = m.legacy ? null : m.rot ?? null;
    det.params.keyframe = !m.legacy;
    if (m.detectEvery) this.detectEvery = m.detectEvery;
    // пока кот не посажен и идёт проверка «это карта Сбера?» — полный поиск через кадр: проверяем только кадры
    // полного поиска (точные углы). По времени полный поиск ≈ ведению потоком (края считаются в каждом кадре)
    // кот сидит, а карты нет дольше RELOC_MS (резкий сдвиг телефона, смаз): полный поиск тоже через кадр — иначе карта,
    // уже снова резкая в кадре, находилась через 1–1,5 с, и всё это время кот стоял у края экрана без карты (запись
    // 23.11, 14:00:48 — «второй кот у края»)
    const lostLong = det.locked && (m.lostMs ?? 0) > RELOC_MS;
    det.params.detectEvery = lostLong && m.verify !== false ? 1 : (!det.locked && m.verify !== false) || lostLong ? Math.min(2, this.detectEvery) : this.detectEvery;
    const r = det.process(m.rgba, m.w, m.h, { focal: m.focal });
    const out: PipelineOut = { id: m.id, quad: r.quad, score: r.score, mode: r.mode, ms: r.ms, key: det.keyInfo, why: det.why };
    let tv = 0;
    if (m.verify !== false) {
      const t0 = now();
      out.ver = this.ver.step(det, r, { rgba: m.rgba, w: m.w, h: m.h }, { f: m.focal, cx: m.w / 2, cy: m.h / 2 }, now(), m.crop ?? null);
      tv = now() - t0;
      out.ms += tv;
    }
    // кот сидит, карта потеряна (рука ушла, телефон сдвинули/приблизили): ищем её по содержимому среди кандидатов
    // полного поиска — не только у прогноза. Раньше карта, ушедшая дальше 0,6 диагонали от прогноза при другом
    // масштабе, не находилась вовсе: кот 6 с висел, потом «Где карта?» при карте в кадре (запись 18.11).
    // (воркер может и «вести» что-то по ключевому кадру/поверхности, а поза не принимается главным потоком — тоже ищем)
    if (m.verify !== false && det.locked && (!r.quad || (m.lostMs ?? 0) > RELOC_MS) && det.ranDetect) {
      const t0 = now();
      const q = this.relocalize({ rgba: m.rgba, w: m.w, h: m.h }, { f: m.focal, cx: m.w / 2, cy: m.h / 2 }, m.crop ?? null);
      if (q) {
        out.quad = q.quad;
        out.score = Math.max(0.6, q.score);
        out.mode = 'detect';
        out.relocated = true;
      }
      tv += now() - t0;
      out.ms += now() - t0;
    } else if (!det.locked || !(m.lostMs ?? 0)) this.reloc = null;
    // CARD-01/02: после потери у кандидата нет «унаследованного» класса — проверяем, чья это карта, по ЭТОМУ кадру
    if (m.verify !== false && det.locked && (m.lostMs ?? 0) > 0 && out.quad) {
      const t0 = now();
      out.fresh = out.relocated ? 'sber' : this.freshClass(out.quad as Quad, r, { rgba: m.rgba, w: m.w, h: m.h }, { f: m.focal, cx: m.w / 2, cy: m.h / 2 }, m.crop ?? null);
      tv += now() - t0;
      out.ms += now() - t0;
    }
    out.detNext = !det.locked && det.detectDueNext;
    const t1 = now();
    const oq = out.quad;
    if (oq) out.glare = glareOn(m.rgba, m.w, m.h, oq);
    let ls = 0, ln = 0;
    for (let i = 0; i < m.rgba.length; i += 4 * 37) (ls += 0.299 * m.rgba[i] + 0.587 * m.rgba[i + 1] + 0.114 * m.rgba[i + 2]), ln++;
    out.luma = ln ? ls / ln : undefined;
    const to = now() - t1;
    out.ms += to;
    const st = det.stages;
    out.stages = { pre: st.pre, key: st.key, flow: st.flow, detect: st.detect, verify: tv, other: Math.max(0, st.total - st.pre - st.key - st.flow - st.detect) + to };
    return out;
  }

  /**
   * Чья карта под потерянным котом — по одному кадру с точными углами (полный поиск; ведение без полного поиска —
   * не проверяем: углы «плывут», знак 5–10 px). Критерии — как у первой посадки (CardEvidence): чужой отпечаток —
   * foreign; уверенный знак Сбера (≥ HIT.strong, кольцо чужого банка даёт ≤ 0,81) или отпечаток дизайна, на котором
   * кот сидел (known; до узнавания — любой известный дизайн Сбера), — sber.
   */
  private freshClass(q: Quad, r: { quad: Quad | null; mode: string }, lo: { rgba: Uint8ClampedArray; w: number; h: number }, K: { f: number; cx: number; cy: number }, crop: CropIn | null): 'sber' | 'foreign' | 'none' | undefined {
    const det = this.det;
    let qv: Quad | null = r.mode === 'detect' && r.quad ? r.quad : null;
    if (!qv && det.ranDetect) qv = det.lastCandidates.find((c) => quadDistance(alignQuad(c.quad, q), q) < 0.08 * quadDiag(q))?.quad ?? null;
    if (!qv) return undefined;
    const v = this.ver.classify(qv, lo, K, crop);
    if (!v) return undefined;
    if ((v.f.foreign ?? -1) >= 0) return 'foreign';
    const known = this.ver.ev.known;
    if (v.side === 'front' && (v.f.logo >= HIT.strong || (v.f.designHit && (known < 0 || v.f.designId === known)))) return 'sber';
    return 'none';
  }

  /**
   * Кандидат полного поиска — та же карта Сбера? Проверка через кадр (≈ 7 мс на кандидата, на телефоне ×2–3 — только
   * пока карта потеряна), до двух лучших кандидатов; «да» — знак или известный дизайн в 2 проверках подряд в одном месте.
   */
  private relocalize(lo: { rgba: Uint8ClampedArray; w: number; h: number }, K: { f: number; cx: number; cy: number }, crop: CropIn | null): { quad: Quad; score: number } | null {
    if (this.relocTick++ & 1) return null;
    const n = this.relocTick;
    const cands = this.det.lastCandidates.filter((c) => c.score >= 0.45).slice(0, 2);
    for (const c of cands) {
      const v = this.ver.classify(c.quad, lo, K, crop);
      if (!v || (v.f.foreign ?? -1) >= 0 || !(v.f.logo >= HIT.logo || v.f.designHit)) continue;
      const r = this.reloc;
      if (r && n - r.at <= 8 && quadDistance(alignQuad(c.quad, r.quad), r.quad) < 0.15 * quadDiag(r.quad)) r.hits++;
      else this.reloc = { quad: c.quad, hits: 1, at: n };
      const cur = this.reloc!;
      cur.at = n;
      cur.quad = c.quad;
      if (cur.hits >= 2) {
        this.reloc = null;
        return { quad: this.det.relocate(c.quad), score: c.score };
      }
      return null;
    }
    return null;
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
