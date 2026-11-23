/**
 * Проверка «это карта Сбера?» в потоке кадров (живёт в воркере рядом с детектором).
 *
 * Пока кот не посажен — проверяем кандидата часто (кадры полного поиска, не чаще ~12 раз в секунду; воркер
 * в это время ищет карту заново через кадр), копим уверенность по кадрам
 * (CardEvidence). Если ведём не карту (бутылка, книга), а в кадре есть другие кандидаты — по одному за кадр
 * проверяем их и, если у кого-то видны признаки карты, переводим детектор на него (CardDetector.adopt).
 * После посадки — переверификация раз в секунду в отдельном окне: один размытый кадр ничего не решает,
 * «это не карта» — только если 5 проверок подряд без единого признака.
 */
import type { CardDetector, DetectResult } from './detector';
import { quadDiag, quadDistance, alignQuad, type Quad, type Pt, type Intrinsics } from './geometry';
import { CardEvidence, HIT, classifyCard, fmtFeatures, type CardKind, type CardVerdict, type Img } from './verify';

export interface CropIn {
  img: Img;
  /** прямоугольник кадра детектора (px), который растянут на img */
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface VerifyReport {
  /** решение по текущему кандидату (до посадки) */
  state: CardKind;
  /** после посадки: 5 проверок подряд «не карта» */
  postNotCard: boolean;
  /** строка признаков для ?debug */
  line: string;
  /** проверяли в этом кадре */
  checked: boolean;
  ms: number;
  /** номер известного дизайна, если отпечаток совпал в этой проверке (−1 — нет) */
  design?: number;
  /**
   * Есть намёк на Сбер и на банковскую карту (знак ≥ 0,3 и чип ≥ 0,35 — каждый хотя бы в 3 проверках окна): только тогда машина состояний может
   * посадить кота «по форме» после терпения. Без намёка (чужая карта без пойманного чипа) — не садим.
   */
  maybeSber?: boolean;
}

const PRE_MS = 80;
/** «намёк на знак Сбера» для посадки по форме */
const MAYBE_LOGO = 0.3;
/** «намёк на чип» для посадки по форме */
const MAYBE_CHIP = 0.35;
const POST_MS = 1000;

export class CardVerifier {
  readonly ev = new CardEvidence();
  /** после посадки: короткое окно переверификации */
  readonly post = new CardEvidence(5);
  private track: Quad | null = null;
  private trackAt = -1e9;
  private lastAt = -1e9;
  private wasLocked = false;
  private alt = 0;
  private line = '';

  /**
   * Посадка «по форме» возможна: намёк на знак И намёк на чип (банковская карта) — каждый хотя бы в 3 проверках окна.
   * Иначе картинки на карточке сажали кота «по форме»: кольцо, похожее на знак, без чипа (негатив n000, наклон 50°);
   * знак и «чип» по одному разу на зелёной картинке (n194, клетчатая скатерть).
   */
  private maybe(): boolean {
    const c = this.ev.counts();
    // известная чужая карта по отпечатку — никакой посадки «по форме»
    return c.foreign === 0 && c.maxLogo >= MAYBE_LOGO && c.maxChip >= MAYBE_CHIP && c.nLogo >= 3 && c.nChip >= 3;
  }

  reset() {
    this.ev.reset();
    this.post.reset();
    this.track = null;
    this.lastAt = -1e9;
    this.wasLocked = false;
  }

  /** классификация четырёхугольника кадра детектора: по фрагменту в большем разрешении, если он его покрывает */
  classify(q: Pt[], lo: Img, K: Intrinsics, crop?: CropIn | null): CardVerdict | null {
    if (crop) {
      const sx = crop.img.w / crop.w, sy = crop.img.h / crop.h;
      const qc = q.map((p) => ({ x: (p.x + 0.5 - crop.x0) * sx - 0.5, y: (p.y + 0.5 - crop.y0) * sy - 0.5 }));
      const inside = qc.every((p) => p.x >= 1 && p.y >= 1 && p.x <= crop.img.w - 2 && p.y <= crop.img.h - 2);
      if (inside) return classifyCard(crop.img, qc, { f: K.f * sx, cx: (K.cx + 0.5 - crop.x0) * sx - 0.5, cy: (K.cy + 0.5 - crop.y0) * sy - 0.5 });
    }
    return classifyCard(lo, q, K);
  }

  step(det: CardDetector, r: DetectResult, lo: Img, K: Intrinsics, now: number, crop?: CropIn | null, force = false): VerifyReport {
    const locked = det.locked;
    if (locked && !this.wasLocked) this.post.reset();
    this.wasLocked = locked;
    const rep: VerifyReport = { state: this.ev.state, postNotCard: false, line: this.line, checked: false, ms: 0, maybeSber: this.maybe() };
    const q = r.quad;
    if (!q) {
      // карта пропала надолго — начинаем заново
      if (!locked && now - this.trackAt > 1500) {
        this.ev.reset();
        this.track = null;
      }
      rep.state = this.ev.state;
      return rep;
    }
    // новая «дорожка» (другой предмет) — уверенность заново
    if (!locked && this.track && quadDistance(alignQuad(q, this.track), this.track) > 0.35 * quadDiag(this.track)) this.ev.reset();
    this.track = q;
    this.trackAt = now;
    // только кадры полного поиска: там углы точные (при ведении потоком углы могут «плыть» на несколько px,
    // а знак Сбера на карте — 5–10 px). Ведение по поверхности (plane) — края не подтверждены, тем более нет.
    let qv: Quad | null = r.mode === 'detect' ? q : null;
    if (!qv && (r.mode === 'track' || r.mode === 'key') && det.ranDetect) {
      // полный поиск был, но победило ведение: берём тот же прямоугольник из полного поиска (точные углы)
      const c = det.lastCandidates.find((c) => quadDistance(alignQuad(c.quad, q), q) < 0.08 * quadDiag(q));
      if (c) qv = c.quad;
    }
    if (!qv) return rep;
    if (!force && now - this.lastAt < (locked ? POST_MS : PRE_MS)) return rep;
    this.lastAt = now;
    const t0 = performance.now();
    const v = this.classify(qv, lo, K, crop);
    if (!v) return rep;
    rep.checked = true;
    if (locked) {
      this.post.push(v, now);
      const c = this.post.counts();
      rep.postNotCard = c.n >= 5 && c.none === c.n;
    } else {
      this.ev.push(v, now);
      // ведём явно не карту, а в кадре есть другие кандидаты — проверим одного из них
      if ((this.ev.state === 'notcard' || (this.ev.state === 'unknown' && this.ev.win.length >= 4 && this.ev.counts().none === this.ev.win.length)) && det.ranDetect) {
        const others = det.lastCandidates.filter((c) => quadDistance(alignQuad(c.quad, q), q) > 0.3 * quadDiag(q)).slice(0, 3);
        if (others.length) {
          const c = others[this.alt++ % others.length];
          const va = this.classify(c.quad, lo, K, crop);
          if (va && (va.f.logo >= HIT.logo || va.f.designHit || va.f.chip >= HIT.chip || va.f.back >= HIT.back)) {
            det.adopt(c.quad);
            this.ev.reset();
            this.ev.push(va, now);
            this.track = c.quad;
          }
        }
      }
    }
    const c = (locked ? this.post : this.ev).counts();
    this.line = `${locked ? 'post' : this.ev.state} n${c.n} s${c.sber} c${c.chip} b${c.back} · ${fmtFeatures(v)} · ${crop ? 'crop' : 'lo'} ${v.f.px.toFixed(0)}px ${v.ms.toFixed(1)}мс`;
    rep.state = this.ev.state;
    rep.design = v.f.designHit ? v.f.designId : -1;
    rep.maybeSber = this.maybe();
    rep.line = this.line;
    rep.ms = performance.now() - t0;
    return rep;
  }
}
