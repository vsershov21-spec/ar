import * as THREE from 'three';
import { OneEuroVec, rotationAlpha } from './smoothing';
import { OrientationHold } from './orientationHold';

/** Общая часть адаптеров: события, сглаживание целевой матрицы в anchor. */
export abstract class TrackerBase {
  readonly anchor = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100000);
  isTracking = false;
  /** удержание позы при потере карты (3DoF по гироскопу) */
  readonly hold = new OrientationHold();
  private holding = false;
  private foundCbs = new Set<() => void>();
  private lostCbs = new Set<() => void>();
  protected target: THREE.Matrix4 | null = null;
  private pos = new OneEuroVec(3, 1.2, 0.015);
  private tp = new THREE.Vector3();
  private tq = new THREE.Quaternion();
  private ts = new THREE.Vector3();
  private cp = new THREE.Vector3();
  private cq = new THREE.Quaternion();
  private cs = new THREE.Vector3();
  private hasPose = false;
  smoothing = true;

  constructor() {
    this.anchor.matrixAutoUpdate = false;
    this.anchor.name = 'card-anchor';
  }

  onFound(cb: () => void) {
    this.foundCbs.add(cb);
    return () => this.foundCbs.delete(cb);
  }
  onLost(cb: () => void) {
    this.lostCbs.add(cb);
    return () => this.lostCbs.delete(cb);
  }
  protected setFound(v: boolean) {
    if (v === this.isTracking) return;
    this.isTracking = v;
    if (!v) {
      this.hold.freeze(this.anchor.matrix);
      this.holding = true;
    } else {
      this.holding = false;
    }
    if (v) {
      // после потери — не «доезжаем» плавно из старой позы, а прыгаем сразу
      this.pos.reset();
      this.hasPose = false;
    }
    (v ? this.foundCbs : this.lostCbs).forEach((cb) => cb());
  }

  setSmoothing(minCutoff: number, beta: number) {
    this.pos.setParams(minCutoff, beta);
    this.smoothing = minCutoff < 50;
  }

  get anchorValid() {
    return this.isTracking || this.holding;
  }

  update(dt: number, t: number) {
    if (this.holding) {
      // потеря: якорь замер в мире, компенсируем поворот телефона (если есть гироскоп)
      this.hold.apply(this.anchor.matrix);
      this.anchor.matrixWorldNeedsUpdate = true;
      return;
    }
    if (!this.target || !this.isTracking) return;
    this.target.decompose(this.tp, this.tq, this.ts);
    if (!this.hasPose || !this.smoothing) {
      this.cp.copy(this.tp);
      this.cq.copy(this.tq);
      this.cs.copy(this.ts);
      this.hasPose = true;
    } else {
      const p = this.pos.filter([this.tp.x, this.tp.y, this.tp.z], t);
      this.cp.set(p[0], p[1], p[2]);
      const ang = this.cq.angleTo(this.tq);
      this.cq.slerp(this.tq, rotationAlpha(ang, dt));
      this.cs.lerp(this.ts, 1 - Math.exp(-12 * dt));
    }
    this.anchor.matrix.compose(this.cp, this.cq, this.cs);
    this.anchor.matrixWorldNeedsUpdate = true;
  }
}
