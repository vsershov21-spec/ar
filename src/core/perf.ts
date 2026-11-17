/**
 * Замеры производительности и адаптивное качество.
 *
 * PerfMeter — время участков кадра (performance.now), включается ?perf (или window.__perf.enable()).
 * Отчёт: window.__perf.report() — средние/95-й перцентиль по участкам, fps, отметки старта (marks).
 *
 * Quality — адаптивное качество по измеренной частоте кадров: на слабом телефоне снижает pixelRatio, число
 * оболочек меха и частоту трекера; на сильном ничего не меняет (уровень 0 = как без адаптации).
 * Решение принимается по скользящему окну ~2 с, вниз быстрее, вверх — медленно и с гистерезисом (без «качелей»).
 * ?q=0|1|2|3 — зафиксировать уровень (для сравнения на телефоне), ?q=auto — по умолчанию.
 */

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class PerfMeter {
  enabled = false;
  private t0 = 0;
  private cur = '';
  private acc = new Map<string, number[]>();
  private frameAcc: number[] = [];
  private frameStart = 0;
  readonly marks: Record<string, number> = {};

  /**
   * Счётчики работы (всегда включены, стоят копейки): render — кадры рендера, logic — кадры логики,
   * tracker — кадры в детектор, mic — порции звука микрофона, asr — порции звука в распознавание.
   * rates() — частоты, Гц, за последнюю ~1 с (строка энергобюджета в ?debug, стенд scripts/bench/energy.mjs).
   */
  private counts: Record<string, number> = {};
  private rateCounts: Record<string, number> = {};
  private rateT = 0;
  private lastRates: Record<string, number> = {};
  /** накопительные счётчики с открытия страницы */
  readonly totals: Record<string, number> = {};

  count(name: string, n = 1) {
    this.counts[name] = (this.counts[name] ?? 0) + n;
    this.totals[name] = (this.totals[name] ?? 0) + n;
  }

  rates(): Record<string, number> {
    const t = now();
    if (!this.rateT) this.rateT = t;
    if (t - this.rateT >= 1000) {
      const k = 1000 / (t - this.rateT);
      const out: Record<string, number> = {};
      for (const n of new Set([...Object.keys(this.counts), ...Object.keys(this.rateCounts)])) out[n] = +(((this.counts[n] ?? 0) - (this.rateCounts[n] ?? 0)) * k).toFixed(1);
      this.rateCounts = { ...this.counts };
      this.rateT = t;
      this.lastRates = out;
    }
    return this.lastRates;
  }

  mark(name: string) {
    if (!(name in this.marks)) this.marks[name] = Math.round(now());
  }

  beginFrame() {
    if (!this.enabled) return;
    this.frameStart = now();
    this.t0 = this.frameStart;
    this.cur = '';
  }

  /** закрыть предыдущий участок и начать новый */
  section(name: string) {
    if (!this.enabled) return;
    const t = now();
    if (this.cur) this.push(this.cur, t - this.t0);
    this.cur = name;
    this.t0 = t;
  }

  endFrame() {
    if (!this.enabled) return;
    const t = now();
    if (this.cur) this.push(this.cur, t - this.t0);
    this.cur = '';
    this.frameAcc.push(t - this.frameStart);
    if (this.frameAcc.length > 4000) this.frameAcc.splice(0, 2000);
  }

  /** внешний замер (трекер, воркер) */
  add(name: string, ms: number) {
    if (this.enabled) this.push(name, ms);
  }

  private push(name: string, ms: number) {
    let a = this.acc.get(name);
    if (!a) this.acc.set(name, (a = []));
    a.push(ms);
    if (a.length > 4000) a.splice(0, 2000);
  }

  reset() {
    this.acc.clear();
    this.frameAcc = [];
  }

  report() {
    const stat = (a: number[]) => {
      if (!a.length) return { n: 0, avg: 0, p95: 0 };
      const s = [...a].sort((x, y) => x - y);
      return { n: a.length, avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p95: +s[Math.floor(s.length * 0.95)].toFixed(3) };
    };
    const sections: Record<string, { n: number; avg: number; p95: number }> = {};
    this.acc.forEach((a, k) => (sections[k] = stat(a)));
    return { frameJs: stat(this.frameAcc), sections, marks: { ...this.marks } };
  }
}

export const perf = new PerfMeter();

export interface QualityLevel {
  /** множитель к devicePixelRatio (не выше 2) */
  dprCap: number;
  /** доля оболочек меха (1 — все) */
  fur: number;
  /** максимум кадров трекера в секунду (0 — без ограничения: по кадрам камеры) */
  trackerHz: number;
}

/** 0 — как без адаптации; дальше — дешевле */
export const QUALITY_LEVELS: QualityLevel[] = [
  { dprCap: 2, fur: 1, trackerHz: 0 },
  { dprCap: 1.5, fur: 1, trackerHz: 30 },
  { dprCap: 1.25, fur: 0.5, trackerHz: 24 },
  { dprCap: 1, fur: 0.25, trackerHz: 20 },
];

export class AdaptiveQuality {
  level = 0;
  /** уровень зафиксирован (?q=N) */
  readonly fixed: boolean;
  onChange: (lvl: QualityLevel, i: number) => void = () => {};
  private win: number[] = [];
  private winT = 0;
  private goodT = 0;
  private cooldown = 0;
  /** не судить первые секунды (компиляция шейдеров, загрузка) */
  private warmup = 3;
  /** вкладка была скрыта/кадр — пауза: не считать */
  private readonly target: number;

  constructor(param: string | null, target = 50) {
    this.target = target;
    const n = param === null || param === 'auto' ? NaN : Number(param);
    this.fixed = Number.isFinite(n);
    if (this.fixed) this.level = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Math.round(n)));
  }

  get current(): QualityLevel {
    return QUALITY_LEVELS[this.level];
  }

  /** сброс окна (вкладка вернулась, сменилась модель) */
  pause(sec = 1.5) {
    this.win = [];
    this.winT = 0;
    this.warmup = Math.max(this.warmup, sec);
  }

  private capped = false;
  /**
   * dt — реальный интервал между кадрами, с; capFps — частота, которую сейчас просит энергобюджет (0 — без потолка).
   * При потолке 30/20 к/с интервал приводим к «как при 60» (dt · cap / 60): медленно — относительно потолка,
   * иначе бюджет и адаптация подстёгивали бы друг друга (кадров меньше → «тормозит» → хуже картинка).
   */
  tick(dt: number, capFps = 0) {
    if (this.fixed) return;
    const norm = capFps > 0 && capFps < 60 ? capFps / 60 : 1;
    if (norm < 1) this.capped = true;
    if (this.warmup > 0) {
      this.warmup -= dt;
      return;
    }
    if (dt > 2) return; // пауза (свёрнуто, отладчик) — не кадр; скрытие вкладки сбрасывает окно само (pause)
    this.win.push(dt * norm);
    this.winT += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.winT < 2) return;
    const s = [...this.win].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    const fps = 1 / med;
    this.win = [];
    this.winT = 0;
    const wasCapped = this.capped;
    this.capped = false;
    if (this.cooldown > 0) return;
    // экран 30 Гц / энергосбережение iOS (rAF 30) — это не «тормозит»: снижать качество бессмысленно
    const target = this.target;
    const capped30 = !wasCapped && fps > 28 && fps < 32.5 && s[Math.floor(s.length * 0.1)] > 1 / 34;
    if (fps < target * 0.8 && !capped30 && this.level < QUALITY_LEVELS.length - 1) {
      this.set(this.level + 1);
      this.goodT = 0;
      this.cooldown = 2;
    } else if (fps > target * 1.1) {
      // вверх — только после 10 с стабильно хорошей частоты
      this.goodT += 2;
      if (this.goodT >= 10 && this.level > 0) {
        this.set(this.level - 1);
        this.goodT = 0;
        this.cooldown = 4;
      }
    } else this.goodT = 0;
  }

  set(i: number) {
    i = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, i));
    if (i === this.level) return;
    this.level = i;
    this.onChange(QUALITY_LEVELS[i], i);
  }
}
