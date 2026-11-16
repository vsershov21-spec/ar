/**
 * Сглаживание дрожания позы карты.
 * Позиция — One Euro Filter (Casiez et al. 2012): сильное сглаживание на медленных движениях,
 * малая задержка на быстрых. Поворот — slerp с адаптивным коэффициентом по угловой скорости.
 */
export class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  get value() {
    return this.y;
  }
  reset() {
    this.y = null;
  }
}

const alphaFor = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private last: number | null = null;
  constructor(public minCutoff = 1.0, public beta = 0.02, public dCutoff = 1.0) {}
  filter(value: number, tSec: number): number {
    const dt = this.last === null ? 1 / 60 : Math.max(1e-3, tSec - this.last);
    const prev = this.x.value;
    this.last = tSec;
    const d = prev === null ? 0 : (value - prev) / dt;
    const ed = this.dx.filter(d, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }
  reset() {
    this.x.reset();
    this.dx.reset();
    this.last = null;
  }
}

/** Сглаживание вектора из N компонент. */
export class OneEuroVec {
  private f: OneEuro[];
  constructor(n: number, minCutoff = 1.0, beta = 0.02) {
    this.f = Array.from({ length: n }, () => new OneEuro(minCutoff, beta));
  }
  filter(v: number[], tSec: number): number[] {
    return v.map((x, i) => this.f[i].filter(x, tSec));
  }
  setParams(minCutoff: number, beta: number) {
    this.f.forEach((f) => {
      f.minCutoff = minCutoff;
      f.beta = beta;
    });
  }
  reset() {
    this.f.forEach((f) => f.reset());
  }
}

/** Коэффициент slerp для поворота: чем быстрее вращение, тем меньше сглаживание. */
export function rotationAlpha(angleRad: number, dtSec: number, base = 8, boost = 40): number {
  const k = base + boost * Math.min(1, angleRad / 0.5);
  return 1 - Math.exp(-k * dtSec);
}
