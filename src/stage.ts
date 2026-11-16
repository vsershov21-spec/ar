/**
 * Stage — где стоит кот: на карте, «у стекла» (ближе к камере) или в замершей позе при потере карты.
 * Поза кота каждый кадр = смешение позы-на-карте и позы-у-стекла (pos/quat/scale), см. docs/MECHANICS.md.
 */
import * as THREE from 'three';
import type { Tracker } from './tracker/types';
import type { Character } from './character/types';
import type { StageConfig } from './config';
import { clamp, easeInOut } from './core/util';

export type StageMode = 'card' | 'glass';

export class Stage {
  readonly root = new THREE.Group(); // сюда кладётся character.object; matrix задаётся вручную
  readonly shadow: THREE.Mesh;
  private mode: StageMode = 'card';
  private t = 0; // 0 = на карте, 1 = у стекла
  private yaw = 0;
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

  /** сбросить позицию в точку опоры из конфига */
  resetPosition() {
    this.pos.set(this.cfg.footX, this.cfg.footY);
    this.walkTarget = null;
  }

  /** экранная точка → точка на плоскости карты/стола (в ширинах карты) или null */
  screenToCard(x: number, y: number, w: number, h: number): THREE.Vector2 | null {
    const a = this.tracker.anchor;
    a.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.tracker.camera);
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
  private cardPose(out: THREE.Matrix4) {
    const c = this.cfg;
    const a = this.tracker.anchor;
    a.updateMatrixWorld(true);
    // камера в координатах карты → yaw кота к зрителю вокруг нормали карты
    const camLocal = a.worldToLocal(this.tracker.camera.getWorldPosition(new THREE.Vector3()));
    const dx = camLocal.x - this.pos.x, dy = camLocal.y - this.pos.y;
    // после поворота на +90° по X «вперёд» кота (+Z модели) смотрит в -Y карты
    const targetYaw = this.walkYaw ?? (c.yawFollow ? Math.atan2(dx, -dy) : 0);
    let d = targetYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (this.walkYaw !== null ? 0.25 : 0.12);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(this.pos.x, this.pos.y, c.footZ),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, this.yaw, 0, 'XYZ')),
      new THREE.Vector3(c.height, c.height, c.height),
    );
    out.multiplyMatrices(a.matrixWorld, local);
  }

  /** «у стекла»: прямо перед камерой, ноги у нижнего края экрана, рост = glassHeightFrac экрана */
  private glassPose(out: THREE.Matrix4) {
    const cam = this.tracker.camera;
    const a = this.tracker.anchor;
    const anchorPos = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld);
    const D = Math.max(cam.near * 4, anchorPos.length() * 0.5);
    const halfH = D * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const H = 2 * halfH * this.cfg.glassHeightFrac;
    // лапы на ~76% высоты экрана — над нижней панелью интерфейса (микрофон, чипы)
    const pos = new THREE.Vector3(0, -halfH * 0.52, -D).applyMatrix4(cam.matrixWorld);
    const q = cam.getWorldQuaternion(new THREE.Quaternion());
    out.compose(pos, q, new THREE.Vector3(H, H, H));
  }

  update(dt: number) {
    this.now += dt;
    // ходьба по плоскости карты
    if (this.walkTarget) {
      const d = this.walkTarget.clone().sub(this.pos);
      const len = d.length();
      const step = this.cfg.walkSpeed * dt;
      // направление движения в координатах карты → yaw (вперёд кота = -Y карты при yaw=0)
      this.walkYaw = Math.atan2(d.x, -d.y);
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

    this.cardPose(this.m1);
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
    this.s1.multiplyScalar(Math.max(0.0001, this.visibleK));
    this.root.matrix.compose(this.p1, this.q1, this.s1);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.visible = this.visibleK > 0.001;
    if (this.character) this.character.object.userData.tilt = this.cfg.billboardTilt * (1 - this.t);

    // тень: под лапами, пропадает у стекла
    const c = this.cfg;
    this.shadow.position.set(this.pos.x, this.pos.y, c.footZ + 0.002);
    this.shadow.scale.set(c.height * 0.55, c.height * 0.32, 1);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = (1 - this.t) * this.visibleK * 0.9;
    this.shadow.visible = this.visibleK > 0.001;
  }

  /** экранная точка (px) центра «головы» кота — для эффектов (пузырь жвачки, блёстки) */
  headScreen(w: number, h: number, frac = 0.78): { x: number; y: number } {
    this.root.updateMatrixWorld(true);
    const p = new THREE.Vector3(0, frac, 0).applyMatrix4(this.root.matrixWorld);
    p.project(this.tracker.camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  }
}
