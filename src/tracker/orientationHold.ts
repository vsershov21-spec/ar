/**
 * Фоллбэк 3DoF: когда карта пропала, «замораживаем» якорь в мире и компенсируем
 * только поворот телефона по DeviceOrientation (без сдвига — гироскоп его не знает).
 * Итог: кот остаётся «на месте», если ребёнок поворачивает телефон; при сдвиге — уплывает,
 * поэтому держим ограниченное время (см. docs/MECHANICS.md).
 */
import * as THREE from 'three';

const zee = new THREE.Vector3(0, 0, 1);
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° по X

/** Ориентация камеры по углам устройства (как в three DeviceOrientationControls). */
export function deviceQuaternion(alpha: number, beta: number, gamma: number, screenOrient: number, out = new THREE.Quaternion()) {
  const d = THREE.MathUtils.DEG2RAD;
  const euler = new THREE.Euler(beta * d, alpha * d, -gamma * d, 'YXZ');
  out.setFromEuler(euler);
  out.multiply(q1);
  out.multiply(new THREE.Quaternion().setFromAxisAngle(zee, -screenOrient * d));
  return out;
}

export class OrientationHold {
  private current: THREE.Quaternion | null = null;
  private atLoss: THREE.Quaternion | null = null;
  private frozen = new THREE.Matrix4();
  private listening = false;
  enabled = true;

  start() {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      const so = (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number;
      const prev = this.current ? this.current.clone() : null;
      this.current = deviceQuaternion(e.alpha, e.beta, e.gamma, so, this.current ?? new THREE.Quaternion());
      const now = performance.now();
      // время отсчёта — по метке события, а не по моменту обработки: при занятом главном потоке (iOS) события
      // приходят пачкой, и dt «по часам обработчика» ≈ 0 давал ложные всплески скорости → «Держи телефон ровно…»
      const ts = e.timeStamp > 0 && Math.abs(e.timeStamp - now) < 1000 ? e.timeStamp : now;
      if (prev && this.lastT) {
        const dt = Math.max(0.012, (ts - this.lastT) / 1000);
        const w = prev.angleTo(this.current) / dt;
        this.speed += (w - this.speed) * 0.3;
      }
      this.lastT = ts;
      this.onSample?.(now, this.current);
    });
  }

  /** каждый отсчёт датчика (мс performance.now, ориентация камеры) — для истории ориентации трекера карты */
  onSample: ((t: number, q: THREE.Quaternion) => void) | null = null;

  /** текущая ориентация камеры в мире (null — датчика нет или нет разрешения) */
  get quaternion(): THREE.Quaternion | null {
    return this.current;
  }

  /** угловая скорость телефона, рад/с (сглаженная); NaN — гироскопа нет */
  private speed = 0;
  private lastT = 0;
  get angularSpeed() {
    return this.current ? this.speed : NaN;
  }

  get available() {
    return !!this.current;
  }

  /** карта потеряна: запоминаем позу якоря (в системе камеры) и ориентацию телефона */
  freeze(anchorInCamera: THREE.Matrix4) {
    this.frozen.copy(anchorInCamera);
    this.atLoss = this.current ? this.current.clone() : null;
  }

  /** поза якоря в системе камеры с учётом поворота телефона после потери */
  apply(out: THREE.Matrix4): THREE.Matrix4 {
    out.copy(this.frozen);
    if (!this.enabled || !this.atLoss || !this.current) return out;
    // мир_якорь = Q_loss * A_loss ;  A_now = Q_now^-1 * мир_якорь
    const rel = this.current.clone().invert().multiply(this.atLoss);
    out.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(rel));
    return out;
  }
}
