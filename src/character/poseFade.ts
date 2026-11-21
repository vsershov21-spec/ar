/**
 * Плавный выход из слоя позы поверх клипа (предмет в лапе, скейт, IK раскраски, смена позы сцены): когда слой
 * снимается сразу (cancelAct, вытеснение кнопкой, смена кота), лапы и ноги не прыгают к клипу за кадр, а уходят
 * к нему за 0,2–0,5 с.
 *
 * Как устроено: каждый кадр в одной и той же точке конвейера (после IK действия и скейта, до предмета) снимается
 * показанная поза костей тела (локальные повороты + позиция таза). release() помечает «слой снят»: на следующем
 * кадре в той же точке разница «показано в прошлом кадре − получилось сейчас» по каждой кости затухает по smootherstep.
 * Длительность — от величины разрыва: пиковая скорость затухания ≈ 1,875·разрыв/длительность не выше ~12 рад/с.
 * Переход клипа (AnimBlender) остаётся своим: он смешивает выход миксера, этот — то, что поверх.
 */
import * as THREE from 'three';

const smoother = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));

interface Slot {
  b: THREE.Object3D;
  last: THREE.Quaternion;
  off: THREE.Quaternion;
  pos: boolean;
  lastP: THREE.Vector3;
  offP: THREE.Vector3;
}

export class PoseFade {
  private slots: Slot[] = [];
  private have = false;
  private pending = false;
  private t = 0;
  private dur = 0;
  private tq = new THREE.Quaternion();
  private iq = new THREE.Quaternion();
  /** пиковая угловая скорость затухания, рад/с (длительность подбирается под разрыв) */
  maxRate = 12;
  minDur = 0.2;
  maxDur = 0.5;
  /** стенд: последний разрыв (рад) и длительность (с) */
  readonly dbg = { jump: 0, dur: 0, active: false };

  constructor(model: THREE.Object3D) {
    model.traverse((o) => {
      if (!(o as THREE.Bone).isBone || /Tail|Ear|Eye/.test(o.name)) return;
      this.slots.push({ b: o, last: o.quaternion.clone(), off: new THREE.Quaternion(), pos: /Hips$/.test(o.name), lastP: o.position.clone(), offP: new THREE.Vector3() });
    });
  }

  /** слой снят: следующий кадр начнёт затухание от показанной позы */
  release(minDur = this.minDur) {
    if (!this.have) return;
    this.pending = true;
    this.minDurNext = minDur;
  }
  private minDurNext = 0.2;

  get active() {
    return this.pending || this.t < this.dur;
  }

  /** точка конвейера (каждый кадр): затухание разрыва, затем снимок показанной позы */
  apply(dt: number) {
    const S = this.slots;
    if (this.pending && this.have) {
      this.pending = false;
      let jump = 0, moved = false;
      for (const s of S) {
        s.off.copy(s.last).multiply(this.tq.copy(s.b.quaternion).invert());
        if (s.off.w < 0) s.off.set(-s.off.x, -s.off.y, -s.off.z, -s.off.w);
        jump = Math.max(jump, 2 * Math.acos(Math.min(1, Math.abs(s.off.w))));
        if (s.pos) {
          s.offP.copy(s.lastP).sub(s.b.position);
          if (s.offP.lengthSq() > 1e-12) moved = true;
        }
      }
      this.t = 0;
      this.dur = jump < 0.01 && !moved ? 0 : Math.min(this.maxDur, Math.max(this.minDurNext, (1.875 * jump) / this.maxRate));
      this.dbg.jump = +jump.toFixed(3);
      this.dbg.dur = +this.dur.toFixed(3);
    }
    if (this.t < this.dur) {
      this.t += dt;
      const w = 1 - smoother(this.t / this.dur);
      if (w > 0)
        for (const s of S) {
          this.tq.copy(this.iq).slerp(s.off, w);
          s.b.quaternion.premultiply(this.tq);
          if (s.pos) s.b.position.addScaledVector(s.offP, w);
        }
    }
    this.dbg.active = this.t < this.dur;
    for (const s of S) {
      s.last.copy(s.b.quaternion);
      if (s.pos) s.lastP.copy(s.b.position);
    }
    this.have = true;
  }

  /** сбросить (новый кот, телепорт сцены): без затухания */
  reset() {
    this.pending = false;
    this.t = this.dur = 0;
    this.have = false;
  }
}
