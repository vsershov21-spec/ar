/**
 * WebXR hit-test (Android Chrome, ARCore). Карта не распознаётся (image-tracking в WebXR
 * пока только за флагом Chrome) — ребёнок наводит прицел на карту/стол и тапает:
 * в этой точке ставится якорь, дальше — полноценный мировой трекинг 6DoF.
 * Масштаб метрический: anchor масштабирован до ширины карты ID-1 (0.0856 м), чтобы «1 ед. = ширина карты».
 * Включение: ?tracker=webxr (кнопка появится только если navigator.xr поддерживает immersive-ar).
 */
import * as THREE from 'three';
import type { Tracker, TrackerCapabilities } from './types';
import { CARD_ASPECT, CARD_W_MM } from '../config';

export class WebXRTracker implements Tracker {
  readonly name = 'webxr';
  readonly capabilities: TrackerCapabilities = { imageTarget: false, worldTracking: true, orientationFallback: false };
  readonly anchor = new THREE.Group();
  camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
  readonly aspect = CARD_ASPECT;
  isTracking = false;
  private placed = false;
  private renderer: THREE.WebGLRenderer | null = null;
  private hitSource: XRHitTestSource | null = null;
  private lastHit = new THREE.Matrix4();
  private hasHit = false;
  readonly reticle: THREE.Mesh;
  private found = new Set<() => void>();
  private lost = new Set<() => void>();

  constructor(private overlayRoot: HTMLElement) {
    this.anchor.matrixAutoUpdate = false;
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.045, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
  }

  static async isSupported() {
    try {
      return !!(navigator as any).xr && (await (navigator as any).xr.isSessionSupported('immersive-ar'));
    } catch {
      return false;
    }
  }

  get anchorValid() {
    return this.placed;
  }

  attachRenderer(r: THREE.WebGLRenderer) {
    this.renderer = r;
    r.xr.enabled = true;
  }

  onFound(cb: () => void) {
    this.found.add(cb);
    return () => this.found.delete(cb);
  }
  onLost(cb: () => void) {
    this.lost.add(cb);
    return () => this.lost.delete(cb);
  }

  async start() {
    if (!this.renderer) throw new Error('WebXR: нужен renderer');
    const xr = (navigator as any).xr;
    const session: XRSession = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: this.overlayRoot },
    });
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);
    this.camera = this.renderer.xr.getCamera() as unknown as THREE.PerspectiveCamera;
    const viewer = await session.requestReferenceSpace('viewer');
    this.hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    // тап по экрану в AR-сессии = select → ставим якорь в точку прицела
    session.addEventListener('select', () => this.place());
    session.addEventListener('end', () => {
      this.hitSource = null;
    });
  }

  /** поставить кота в точку прицела (повторный тап — переставить) */
  place() {
    if (!this.hasHit) return;
    const s = CARD_W_MM / 1000;
    // хит-тест даёт позу с +Y вверх; наше соглашение: +Z — нормаль. Поворот -90° по X.
    const m = this.lastHit.clone().multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)).multiply(new THREE.Matrix4().makeScale(s, s, s));
    this.anchor.matrix.copy(m);
    this.anchor.matrixWorldNeedsUpdate = true;
    const was = this.placed;
    this.placed = true;
    this.isTracking = true;
    if (!was) this.found.forEach((cb) => cb());
  }

  update() {
    const r = this.renderer;
    const frame = (r?.xr as any)?.getFrame?.() as XRFrame | undefined;
    const ref = r?.xr.getReferenceSpace();
    if (!frame || !ref || !this.hitSource) return;
    const hits = frame.getHitTestResults(this.hitSource);
    const pose = hits[0]?.getPose(ref);
    this.hasHit = !!pose;
    this.reticle.visible = !!pose && !this.placed;
    if (pose) {
      this.lastHit.fromArray(pose.transform.matrix);
      this.reticle.matrix.copy(this.lastHit);
    }
  }

  stop() {
    void this.renderer?.xr.getSession()?.end();
  }
  resize() {}
  setSmoothing() {}
}
