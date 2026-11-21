/**
 * Раскраска карты (src/card/paint.ts): поза «рисует инструментом» поверх клипа — IK-лайт без решателя.
 *   присед: бёдра вперёд-вниз, голени назад, стопы на полу (таз опускается ровно настолько, насколько поднялись стопы);
 *   наклон и разворот корпуса к точке (Spine, Spine1, Spine2 — в долях, с пределами);
 *   правая лапа — две кости (плечо → локоть → кисть): длина до цели по теореме косинусов, локоть вниз-наружу;
 *   кисть ведёт баллончик / кисть так, что сопло (кончик) смотрит в точку на карте — это делает PropRig.aim.
 * Режимы: carry — лапа по клипу (идёт, баллончик у бока); shake — трясёт баллончик у груди (7 Гц); aim — сопло /
 * кончик кисти в точку; dip — кисть в банку; raise — показывает баллончик над головой. Вес и цель — сглаженно
 * (≈ 0,2 с), чтобы переходы между мазками не дёргали лапу. Клип Meshy с движением руки (paint_spray) — вес меньше:
 * клип даёт живость, IK — точность (краска всё равно идёт туда, куда реально смотрит сопло).
 */
import * as THREE from 'three';

export type AimMode = 'off' | 'carry' | 'shake' | 'aim' | 'dip' | 'raise';
export interface AimRequest {
  mode: AimMode;
  /** точка в мире (aim, dip) */
  target?: THREE.Vector3 | null;
  /** присед 0…1 */
  crouch?: number;
  tool?: 'spray' | 'brush';
  /** доля IK на лапе 0…1 (по умолчанию 1) */
  weight?: number;
}

export interface IkCtx {
  bones: Map<string, THREE.Object3D>;
  /** корень персонажа: ноги в 0, рост ≈ 1, лицом в +Z */
  object: THREE.Object3D;
  /** узел модели, которым опускаем таз при приседе (position.y) */
  inner: THREE.Object3D;
  axes: { up: THREE.Vector3; side: THREE.Vector3; fwd: THREE.Vector3 };
  rot: (b: THREE.Object3D, axisWorld: THREE.Vector3, angle: number) => void;
}

/** отступ кисти лапы от точки (в ростах кота): баллончик держат на расстоянии, кисть касается карты кончиком */
export const STANDOFF = { spray: 0.27, brush: 0.24 };
const SHAKE_HZ = 7;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class ToolIK {
  private req: AimRequest = { mode: 'off' };
  private w = 0;
  private crouchK = 0;
  private t = 0;
  /** сглаженная цель в осях персонажа */
  private tl = new THREE.Vector3();
  private hasT = false;
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private v4 = new THREE.Vector3();
  private v5 = new THREE.Vector3();
  private ax = new THREE.Vector3();
  private feet = [new THREE.Vector3(), new THREE.Vector3()];
  /**
   * цель кисти лапы в осях персонажа — сглаженно при смене режима (aim ↔ carry ↔ dip ↔ shake ↔ raise): раньше цель
   * менялась за кадр при весе ≈ 1 (смена мазка, банка) — рывок лапы 84–93 рад/с (аудит 21.11). Уходит вес — цель
   * остаётся прежней (лапа к клипу по весу, а не через позу «над головой»)
   */
  private wl = new THREE.Vector3();
  private hasW = false;
  /** наклон и разворот корпуса — сглаженно (раньше разворот обнулялся за кадр, когда пропадала цель) */
  private leanS = 0;
  private twistS = 0;
  /** знак доворота локтя (около 180° — прошлого кадра) */
  private poleSg = 0;
  /** куда сейчас должно смотреть сопло (мир) — для PropRig.aim; null — реквизит как в клипе */
  readonly aimPoint = new THREE.Vector3();
  aimW = 0;
  /** QA: цель кисти лапы и где она оказалась (мир), опускание таза */
  readonly dbg = { wt: new THREE.Vector3(), hand: new THREE.Vector3(), drop: 0, reach: 0 };
  /** присед сейчас (QA) */
  get crouch() {
    return this.crouchK;
  }
  get weight() {
    return this.w;
  }
  get mode() {
    return this.req.mode;
  }

  set(r: AimRequest | null) {
    this.req = r ?? { mode: 'off' };
  }

  apply(dt: number, c: IkCtx) {
    const r = this.req;
    this.t += dt;
    const armOn = r.mode === 'aim' || r.mode === 'dip' || r.mode === 'shake' || r.mode === 'raise';
    const wantW = armOn ? clamp(r.weight ?? 1, 0, 1) : 0;
    // вес: к цели экспоненциально (τ 0,16 с), но не быстрее 4/с — вход в позу без рывка
    this.w += clamp((wantW - this.w) * Math.min(1, dt / 0.16), -4 * dt, 4 * dt);
    const wantC = r.mode === 'off' ? 0 : clamp(r.crouch ?? 0, 0, 1);
    this.crouchK += (wantC - this.crouchK) * Math.min(1, dt / 0.2);
    if (this.w < 0.002 && this.crouchK < 0.002) {
      this.aimW = 0;
      this.hasW = false;
      this.leanS = this.twistS = 0;
      return;
    }
    const obj = c.object;
    obj.updateWorldMatrix(true, false);
    const scale = obj.getWorldScale(this.v1).y || 1;
    // цель в осях персонажа (сглаженно — дрожь не идёт в лапу)
    if ((r.mode === 'aim' || r.mode === 'dip') && r.target) {
      const want = obj.worldToLocal(this.v2.copy(r.target));
      if (!this.hasT) this.tl.copy(want);
      else this.tl.lerp(want, 1 - Math.exp(-dt / 0.045));
      this.hasT = true;
    } else if (r.mode !== 'aim' && r.mode !== 'dip') this.hasT = false;

    const { up, side } = c.axes;
    // ── присед: колени вперёд, голени назад, стопы ровно; таз опускаем, пока стопы не встанут на пол
    const th = this.crouchK * 0.95;
    if (th > 0.002) {
      const footY = (i: number) => obj.worldToLocal(c.bones.get(i ? 'RightFoot' : 'LeftFoot')!.getWorldPosition(this.feet[i])).y;
      const hasLegs = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'].every((n) => c.bones.has(n));
      if (hasLegs) {
        const y0 = Math.min(footY(0), footY(1));
        for (const s of ['Left', 'Right']) {
          c.rot(c.bones.get(s + 'UpLeg')!, side, -th);
          c.rot(c.bones.get(s + 'Leg')!, side, th * 2);
          c.rot(c.bones.get(s + 'Foot')!, side, -th);
        }
        obj.updateMatrixWorld(true);
        const y1 = Math.min(footY(0), footY(1));
        c.inner.position.y -= y1 - y0;
        this.dbg.drop = y1 - y0;
        c.inner.updateMatrixWorld(true);
      }
    }
    // ── корпус: наклон к карте и разворот к точке
    let lean = this.crouchK * 0.5, twist = 0;
    if (this.hasT && (r.mode === 'aim' || r.mode === 'dip')) {
      const horiz = Math.hypot(this.tl.x, this.tl.z);
      // дальше — ниже наклон (кисть должна дотянуться), баллончик — меньше: краска долетит
      lean += clamp((horiz - 0.28) * (r.tool === 'brush' ? 1.5 : 0.7), 0, r.tool === 'brush' ? 0.55 : 0.3) * this.w;
      // точка справа (−X) — разворот вправо; правая лапа и так справа: доворот меньше
      twist = clamp(Math.atan2(this.tl.x + 0.12, Math.max(0.05, this.tl.z)) * 0.45, -0.5, 0.5) * this.w;
    }
    const kb = 1 - Math.exp(-dt / 0.15);
    this.leanS += clamp((lean - this.leanS) * kb, -2 * dt, 2 * dt);
    this.twistS += clamp((twist - this.twistS) * kb, -2 * dt, 2 * dt);
    lean = this.leanS;
    twist = this.twistS;
    const sp = [['Spine', 0.38], ['Spine1', 0.34], ['Spine2', 0.28]] as const;
    for (const [n, k] of sp) {
      const b = c.bones.get(n);
      if (!b) continue;
      if (lean) c.rot(b, side, lean * k);
      if (twist) c.rot(b, up, twist * k);
    }
    // ── правая лапа
    const S = c.bones.get('RightArm'), E = c.bones.get('RightForeArm'), Wb = c.bones.get('RightHand');
    if (!S || !E || !Wb || this.w < 0.002) {
      this.aimW = 0;
      return;
    }
    const s = S.getWorldPosition(this.v1), e = E.getWorldPosition(this.v2), wv = Wb.getWorldPosition(this.v3);
    const a = s.distanceTo(e), b = e.distanceTo(wv);
    const reach = (a + b) * 0.985;
    // цель кисти лапы (мир)
    const wt = this.v4;
    if (r.mode === 'aim' || r.mode === 'dip') {
      const T = obj.localToWorld(this.v5.copy(this.tl));
      this.aimPoint.copy(T);
      // баллончик держат выше и дальше от точки (лапа вперёд, сопло вниз на карту), кисть — кончиком в точку
      const spray = r.tool !== 'brush' && r.mode === 'aim';
      const tp = this.v5.copy(T).addScaledVector(up, (spray ? 0.2 : 0.02) * scale);
      const d0 = this.ax.copy(tp).sub(s).normalize();
      wt.copy(tp).addScaledVector(d0, -STANDOFF[r.tool ?? 'spray'] * scale * (r.mode === 'dip' ? 0.9 : 1));
      this.aimW = this.w;
    } else if (r.mode === 'shake') {
      const k = Math.sin(this.t * Math.PI * 2 * SHAKE_HZ);
      // у груди, ниже дуги наушников и шарфа (раньше 0,6 — предплечье в наушниках Хулигана, 9 мм)
      obj.localToWorld(wt.set(-0.16, 0.5 + 0.04 * k, 0.28 + 0.012 * k));
      this.aimW = 0;
    } else if (r.mode === 'raise') {
      obj.localToWorld(wt.set(-0.2, 1.02, 0.14));
      this.aimW = 0;
    } else {
      // carry / off: вес уходит — лапа к клипу от прошлой цели
      if (this.hasW) obj.localToWorld(wt.copy(this.wl));
      else wt.copy(wv);
      this.aimW = 0;
    }
    // цель кисти — сглаженно в осях персонажа (τ 0,1 с, не быстрее 1,6 роста/с); тряска (7 Гц) — как есть
    {
      const wl = obj.worldToLocal(this.v5.copy(wt));
      if (!this.hasW) this.wl.copy(wl);
      else if (r.mode !== 'shake' || this.wl.distanceTo(wl) > 0.08) {
        const step = this.ax.copy(wl).sub(this.wl).multiplyScalar(1 - Math.exp(-dt / 0.1));
        const mx = 1.6 * dt;
        if (step.length() > mx) step.setLength(mx);
        this.wl.add(step);
      } else this.wl.copy(wl);
      this.hasW = true;
      obj.localToWorld(wt.copy(this.wl));
    }
    const sw = this.v5.copy(wt).sub(s);
    if (sw.length() > reach) wt.copy(s).addScaledVector(sw.normalize(), reach);
    const d = clamp(s.distanceTo(wt), Math.abs(a - b) + 1e-4, reach);
    // 1) локоть: угол сгиба по теореме косинусов
    const u = this.ax.copy(e).sub(s).normalize();
    const l = this.v5.copy(wv).sub(e).normalize();
    const bend = Math.acos(clamp(u.dot(l), -1, 1));
    const want = Math.PI - Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
    const n = u.clone().cross(l);
    if (n.lengthSq() < 1e-8) n.copy(side).negate();
    n.normalize();
    c.rot(E, n, (want - bend) * this.w);
    // 2) плечо: направление плечо→кисть лапы на цель
    const w2 = Wb.getWorldPosition(this.v3);
    const cur = this.v5.copy(w2).sub(s).normalize();
    const tgt = this.ax.copy(wt).sub(s).normalize();
    const ang = Math.acos(clamp(cur.dot(tgt), -1, 1));
    if (ang > 1e-4) {
      const axis = cur.clone().cross(tgt);
      if (axis.lengthSq() > 1e-10) c.rot(S, axis.normalize(), ang * this.w);
    }
    // 3) локоть вниз-наружу (не задирается вверх и не входит в бок)
    const sw2 = this.v5.copy(wt).sub(s).normalize();
    const e2 = E.getWorldPosition(this.v2).sub(s);
    const off = e2.addScaledVector(sw2, -e2.dot(sw2));
    const pole = obj.localToWorld(this.v3.set(-0.9, -0.2, -0.6)).sub(obj.getWorldPosition(this.ax)).normalize();
    pole.addScaledVector(sw2, -pole.dot(sw2));
    if (off.lengthSq() > 1e-10 && pole.lengthSq() > 1e-10) {
      off.normalize();
      pole.normalize();
      const pa = Math.acos(clamp(off.dot(pole), -1, 1));
      let sgn = Math.sign(off.clone().cross(pole).dot(sw2)) || 1;
      if (pa > 2.6 && this.poleSg) sgn = this.poleSg;
      this.poleSg = sgn;
      c.rot(S, sw2, sgn * pa * 0.7 * this.w);
    }
    this.dbg.wt.copy(wt);
    Wb.getWorldPosition(this.dbg.hand);
    this.dbg.reach = reach;
  }
}
