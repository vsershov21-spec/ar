/**
 * Stage — где стоит кот: на карте, «у стекла» (ближе к камере) или в замершей позе при потере карты.
 * Поза кота каждый кадр = смешение позы-на-карте и позы-у-стекла (pos/quat/scale), см. docs/MECHANICS.md.
 */
import * as THREE from 'three';
import type { Tracker } from './tracker/types';
import type { Character } from './character/types';
import type { StageConfig } from './config';
import { clamp, easeInOut } from './core/util';
import type { AnchorName } from './fx/core';
import type { IntroPose } from './awake/timeline';

/** точки частей кота в долях роста (ноги в 0, рост 1, лицом в +Z) — если персонаж не дал свои */
const ANCHOR_FRAC: Record<AnchorName, [number, number, number]> = {
  head: [0, 0.8, 0.05], mouth: [0, 0.66, 0.2], feet: [0, 0.02, 0.05], body: [0, 0.45, 0.1],
  earL: [-0.17, 0.93, 0], earR: [0.17, 0.93, 0], pawR: [0.2, 0.42, 0.18],
};
const defaultAnchor = (n: AnchorName, out: THREE.Vector3) => out.set(...(ANCHOR_FRAC[n] ?? ANCHOR_FRAC.body));

export type StageMode = 'card' | 'glass';

export class Stage {
  readonly root = new THREE.Group(); // сюда кладётся character.object; matrix задаётся вручную
  readonly shadow: THREE.Mesh;
  private mode: StageMode = 'card';
  private t = 0; // 0 = на карте, 1 = у стекла
  private yaw = 0;
  /** угловая скорость поворота, рад/с (пружина с ограничением — без «волчка») */
  private yawVel = 0;
  private yawChase = false;
  private visibleK = 0; // появление (масштаб)
  private hiddenUntil = 0;
  private now = 0;
  private character: Character | null = null;
  private m1 = new THREE.Matrix4();
  private p1 = new THREE.Vector3();
  private q1 = new THREE.Quaternion();
  private s1 = new THREE.Vector3();
  private p2 = new THREE.Vector3();
  private q2 = new THREE.Quaternion();
  private s2 = new THREE.Vector3();
  shown = false;
  /**
   * Сцена пробуждения (src/awake): поза поверх позы на карте — подъём из-под карты, масштаб с перелётом, сальто,
   * вращение, крен, сквош приземления (в ростах кота, вокруг центра тела). null — обычная поза.
   */
  intro: IntroPose | null = null;
  private mI = new THREE.Matrix4();
  private mJ = new THREE.Matrix4();
  private qI = new THREE.Quaternion();
  private eI = new THREE.Euler();
  /** текущая точка опоры на карте (меняется при ходьбе) */
  pos = new THREE.Vector2();
  private walkTarget: THREE.Vector2 | null = null;
  private walkYaw: number | null = null;
  private onArrive: (() => void) | null = null;
  constrainToCard = true;

  constructor(scene: THREE.Scene, private tracker: Tracker, public cfg: StageConfig) {
    this.root.matrixAutoUpdate = false;
    this.root.name = 'stage-root';
    scene.add(this.root);
    // тень-контакт: мягкое пятно в плоскости карты под лапами
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(0.5, 'rgba(0,0,0,0.25)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.shadow.name = 'contact-shadow';
    this.shadow.renderOrder = 0;
    tracker.anchor.add(this.shadow);
    this.pos.set(cfg.footX, cfg.footY);
  }

  /**
   * «Мир кота» (src/home): вместо карты и камеры трекера — пол комнаты и камера сцены. Плоскость пола — то же «XY карты»
   * (якорь повёрнут так, что +Z карты смотрит вверх), поэтому ходьба, поворот к зрителю, «у стекла» и тень работают
   * как на карте. null — снова карта.
   */
  private view: { anchor: THREE.Object3D; camera: THREE.PerspectiveCamera } | null = null;
  get anchor(): THREE.Object3D {
    return this.view?.anchor ?? this.tracker.anchor;
  }
  get camera(): THREE.PerspectiveCamera {
    return this.view?.camera ?? this.tracker.camera;
  }
  get inView() {
    return !!this.view;
  }
  useView(v: { anchor: THREE.Object3D; camera: THREE.PerspectiveCamera } | null) {
    this.view = v;
    this.anchor.add(this.shadow);
    this.yawChase = true;
  }

  /** сбросить позицию в точку опоры из конфига */
  resetPosition() {
    this.pos.set(this.cfg.footX, this.cfg.footY);
    this.walkTarget = null;
  }

  /** экранная точка → точка на плоскости карты/стола (в ширинах карты) или null */
  screenToCard(x: number, y: number, w: number, h: number): THREE.Vector2 | null {
    const a = this.anchor;
    a.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.camera);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(a.matrixWorld);
    const p0 = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld);
    const hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0), new THREE.Vector3());
    if (!hit) return null;
    const l = a.worldToLocal(hit);
    return new THREE.Vector2(l.x, l.y);
  }

  /** ограничение прогулки: в пределах карты (MindAR) или круга (мировой трекинг) */
  clampTarget(p: THREE.Vector2): THREE.Vector2 {
    const out = p.clone();
    if (this.constrainToCard) {
      const hx = 0.5 - 0.1, hy = 0.5 / this.tracker.aspect - 0.06;
      out.x = clamp(out.x, -hx, hx);
      out.y = clamp(out.y, -hy, hy);
    } else if (out.length() > this.cfg.worldWalkRadius) out.setLength(this.cfg.worldWalkRadius);
    return out;
  }

  /** дойти до точки (в координатах карты). Возвращает false, если уже на месте */
  walkTo(p: THREE.Vector2, onArrive?: () => void): boolean {
    const t = this.clampTarget(p);
    if (t.distanceTo(this.pos) < 0.04) return false;
    this.walkTarget = t;
    this.onArrive = onArrive ?? null;
    return true;
  }

  get walking() {
    return !!this.walkTarget;
  }

  /** остановиться там, где стоит (раскраска карты: карта ушла посреди ряда) */
  cancelWalk() {
    this.walkTarget = null;
    this.walkYaw = null;
    this.onArrive = null;
  }

  setCharacter(ch: Character) {
    if (this.character) this.root.remove(this.character.object);
    this.character = ch;
    this.root.add(ch.object);
  }

  get atGlass() {
    return this.mode === 'glass';
  }

  setMode(m: StageMode) {
    this.mode = m;
  }

  show(v: boolean) {
    this.shown = v;
    if (!v) this.visibleK = 0;
  }

  /** спрятать на ms (Хулиган при встряске «пропадает на секунду») */
  hideFor(ms: number) {
    this.hiddenUntil = this.now + ms / 1000;
  }

  /** поза центра карты → поза кота на карте */
  private cardPose(out: THREE.Matrix4, dt: number) {
    const c = this.cfg;
    const a = this.anchor;
    a.updateMatrixWorld(true);
    // камера в координатах карты → yaw кота к зрителю вокруг нормали карты
    const camLocal = a.worldToLocal(this.camera.getWorldPosition(this.tmpA));
    const dx = camLocal.x - this.pos.x, dy = camLocal.y - this.pos.y;
    // после поворота на +90° по X «вперёд» кота (+Z модели) смотрит в -Y карты
    const targetYaw = this.walkYaw ?? (c.yawFollow ? Math.atan2(dx, -dy) : 0);
    let d = targetYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.turn(d, dt, this.walkYaw !== null);
    const local = this.m2.compose(
      this.tmpB.set(this.pos.x, this.pos.y, c.footZ),
      this.q3.setFromEuler(this.e1.set(Math.PI / 2, this.yaw, 0, 'XYZ')),
      this.tmpC.set(c.height, c.height, c.height),
    );
    out.multiplyMatrices(a.matrixWorld, local);
  }

  /**
   * Поворот к цели: критически демпфированная пружина, угловая скорость ограничена (к зрителю 2,6 рад/с,
   * в ходьбе 5 рад/с), не зависит от частоты кадров. К зрителю — с гистерезисом: дрожание трекинга
   * не крутит кота, а сдвиг камеры больше ~7° он плавно догоняет до точного взгляда.
   */
  private turn(d: number, dt: number, walking: boolean) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    if (walking) this.yawChase = true;
    else {
      // гистерезис: начинает поворот, когда зритель ушёл дальше ~7°, и доворачивает точно на него
      if (Math.abs(d) > 0.12) this.yawChase = true;
      else if (Math.abs(d) < 0.015 && Math.abs(this.yawVel) < 0.05) this.yawChase = false;
      if (!this.yawChase) d = 0;
    }
    const w = walking ? 9 : 5;
    const vMax = walking ? 5 : 2.6;
    this.yawVel += (w * w * d - 2 * w * this.yawVel) * dt;
    this.yawVel = clamp(this.yawVel, -vMax, vMax);
    this.yaw += this.yawVel * dt;
  }

  /** «у стекла»: прямо перед камерой, ноги у нижнего края экрана, рост = glassHeightFrac экрана */
  private glassPose(out: THREE.Matrix4) {
    const cam = this.camera;
    const a = this.anchor;
    const anchorPos = this.tmpA.setFromMatrixPosition(a.matrixWorld);
    // камера трекера — в начале координат; камера комнаты стоит в мире
    const D = Math.max(cam.near * 4, (this.view ? anchorPos.distanceTo(cam.position) : anchorPos.length()) * 0.5);
    const halfH = D * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const H = 2 * halfH * this.cfg.glassHeightFrac;
    // лапы на ~76% высоты экрана — над нижней панелью интерфейса (микрофон, чипы)
    const pos = this.tmpB.set(0, -halfH * 0.52, -D).applyMatrix4(cam.matrixWorld);
    const q = cam.getWorldQuaternion(this.q3);
    out.compose(pos, q, this.tmpC.set(H, H, H));
  }

  update(dt: number) {
    this.now += dt;
    // ходьба по плоскости карты
    if (this.walkTarget) {
      const d = this.v2.copy(this.walkTarget).sub(this.pos);
      const len = d.length();
      // направление движения в координатах карты → yaw (вперёд кота = -Y карты при yaw=0)
      this.walkYaw = Math.atan2(d.x, -d.y);
      // шагает, когда уже почти развернулся по ходу (не едет боком/задом)
      const err = Math.abs(Math.atan2(Math.sin(this.walkYaw - this.yaw), Math.cos(this.walkYaw - this.yaw)));
      const step = this.cfg.walkSpeed * dt * clamp((Math.cos(err) - 0.2) / 0.7, 0.15, 1);
      if (len <= step) {
        this.pos.copy(this.walkTarget);
        this.walkTarget = null;
        this.walkYaw = null;
        const cb = this.onArrive;
        this.onArrive = null;
        cb?.();
      } else this.pos.add(d.multiplyScalar(step / len));
    }
    const target = this.mode === 'glass' ? 1 : 0;
    this.t = clamp(this.t + Math.sign(target - this.t) * dt / 0.7, 0, 1);
    if (Math.abs(this.t - target) < 0.01) this.t = target;
    const hidden = this.now < this.hiddenUntil;
    this.visibleK = clamp(this.visibleK + (this.shown && !hidden ? dt / 0.25 : -dt / 0.15), 0, 1);

    this.cardPose(this.m1, dt);
    this.m1.decompose(this.p1, this.q1, this.s1);
    if (this.t > 0) {
      this.glassPose(this.m1);
      this.m1.decompose(this.p2, this.q2, this.s2);
      const k = easeInOut(this.t);
      this.p1.lerp(this.p2, k);
      // прыжок по дуге к стеклу
      this.p1.y += Math.sin(k * Math.PI) * this.s2.y * 0.25;
      this.q1.slerp(this.q2, k);
      this.s1.lerp(this.s2, k);
    }
    const it = this.intro;
    this.s1.multiplyScalar(Math.max(0.0001, it ? 1 : this.visibleK));
    this.root.matrix.compose(this.p1, this.q1, this.s1);
    if (it) {
      // T(подъём) · T(центр тела) · R(сальто, вращение, крен) · S(масштаб, сквош) · T(−центр тела)
      const c = 0.45, k = Math.max(0.0001, it.scale);
      this.qI.setFromEuler(this.eI.set(it.flip, it.spin, it.roll, 'YXZ'));
      this.mI.compose(this.tmpB.set(0, it.lift + c * k, 0), this.qI, this.tmpC.set(k * (1 + it.squash * 0.6), k * (1 - it.squash), k * (1 + it.squash * 0.6)));
      this.mI.multiply(this.mJ.makeTranslation(0, -c, 0));
      this.root.matrix.multiply(this.mI);
    }
    this.root.matrixWorldNeedsUpdate = true;
    this.root.visible = it ? it.scale > 0.001 : this.visibleK > 0.001;
    if (this.character) {
      this.character.object.userData.tilt = this.cfg.billboardTilt * (1 - this.t);
      // скорость шага в ростах кота в секунду — 3D-кот подгоняет под неё темп клипа ходьбы
      this.character.object.userData.moveSpeed = this.walkTarget ? this.cfg.walkSpeed / Math.max(0.01, this.cfg.height) : 0;
    }

    // тень: под лапами, пропадает у стекла
    const c = this.cfg;
    this.shadow.position.set(this.pos.x, this.pos.y, c.footZ + 0.002);
    this.shadow.scale.set(c.height * 0.55, c.height * 0.32, 1);
    const shK = it ? it.shadow : this.visibleK;
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = (1 - this.t) * shK * 0.9;
    this.shadow.visible = shK > 0.001;
  }

  /**
   * Экранная точка части кота (px) и рост кота на экране s (px) — для «мировых» эффектов
   * (пузырь у рта, Zzz над головой, искры из-под лап). Точку даёт персонаж (кости рига), иначе — доли роста.
   */
  anchorScreen(name: AnchorName, w: number, h: number): { x: number; y: number; s: number } {
    // только корень (и родители): кость персонажа сама обновит свою цепочку в getWorldPosition. Раньше —
    // updateMatrixWorld(true) всего поддерева кота (все кости и меши) на каждый запрос точки: эффекты и пузырь
    // спрашивают её по нескольку раз за кадр
    this.root.updateWorldMatrix(true, false);
    const cam = this.camera;
    const local = this.character?.anchorLocal?.(name) ?? defaultAnchor(name, this.tmpA);
    const p = this.tmpA.copy(local).applyMatrix4(this.root.matrixWorld).project(cam);
    const f = this.tmpB.set(0, 0, 0).applyMatrix4(this.root.matrixWorld).project(cam);
    const top = this.tmpC.set(0, 1, 0).applyMatrix4(this.root.matrixWorld).project(cam);
    const s = Math.hypot(((top.x - f.x) / 2) * w, ((top.y - f.y) / 2) * h);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, s: Math.max(40, s) };
  }
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  // временные объекты горячего цикла (update — каждый кадр): без new Matrix4/Quaternion/Euler на кадр
  private m2 = new THREE.Matrix4();
  private q3 = new THREE.Quaternion();
  private e1 = new THREE.Euler();
  private v2 = new THREE.Vector2();

  /** экранная точка (px) центра «головы» кота — для эффектов (пузырь жвачки, блёстки) */
  headScreen(w: number, h: number, frac = 0.78): { x: number; y: number } {
    this.root.updateWorldMatrix(true, false);
    const p = this.tmpA.set(0, frac, 0).applyMatrix4(this.root.matrixWorld);
    p.project(this.camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  }
}
