/**
 * Адаптер 8th Wall (опционально, ?tracker=8thwall).
 * Режим: «карта задаёт якорь → дальше мировой трекинг (SLAM)». Пока карта видна — якорь = поза карты;
 * когда карта ушла — якорь остаётся в мире, а камера продолжает двигаться (6DoF), кот стоит на столе.
 *
 * ВАЖНО про лицензии (см. docs/TRACKER_8THWALL.md):
 *  - открытый движок 8th Wall (MIT, github.com/8thwall/8thwall) содержит Image Targets, но НЕ SLAM;
 *  - SLAM есть только в Distributed Engine Binary (@8thwall/engine-binary, проприетарная лицензия
 *    Niantic Spatial «XR Engine License Agreement», ~30 МБ). Перед продом — юр. проверка.
 * Бинарник не входит в репозиторий: `npm run setup-8thwall` копирует его в public/external/xr/.
 * Целевые данные карты готовит @8thwall/image-target-cli → public/targets/8thwall/<имя>.json.
 *
 * Код ниже собран по публичному API XR8 (XrController, custom pipeline module) и НЕ проверен
 * на устройстве — считать заготовкой.
 */
import * as THREE from 'three';
import type { Tracker, TrackerCapabilities } from './types';
import { asset } from '../core/util';
import { CARD_ASPECT } from '../config';

declare global {
  interface Window { XR8?: any; THREE?: any }
}

export class EighthWallTracker implements Tracker {
  readonly name = '8thwall';
  readonly capabilities: TrackerCapabilities = { imageTarget: true, worldTracking: true, orientationFallback: false };
  readonly anchor = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
  readonly aspect = CARD_ASPECT;
  isTracking = false;
  private anchored = false;
  private found = new Set<() => void>();
  private lost = new Set<() => void>();
  private cardWidthM = 0.0856;
  private worldAnchor = new THREE.Matrix4();

  constructor(private canvas: HTMLCanvasElement, private targetJsonUrl = 'targets/8thwall/card.json') {
    this.anchor.matrixAutoUpdate = false;
    this.camera.matrixAutoUpdate = false;
  }

  get anchorValid() {
    return this.isTracking || this.anchored;
  }

  onFound(cb: () => void) {
    this.found.add(cb);
    return () => this.found.delete(cb);
  }
  onLost(cb: () => void) {
    this.lost.add(cb);
    return () => this.lost.delete(cb);
  }

  private async loadEngine(): Promise<any> {
    if (window.XR8) return window.XR8;
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = asset('external/xr/xr.js');
      s.async = true;
      s.dataset.preloadChunks = 'slam';
      s.onerror = () => reject(new Error('8th Wall engine binary не найден: выполните npm run setup-8thwall'));
      document.head.appendChild(s);
      window.addEventListener('xrloaded', () => resolve(), { once: true });
    });
    return window.XR8;
  }

  async start() {
    const XR8 = await this.loadEngine();
    const target = await fetch(asset(this.targetJsonUrl)).then((r) => r.json());
    XR8.XrController.configure({ imageTargetData: [target], disableWorldTracking: false, scale: 'responsive' });
    const self = this;
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(), // рисует видео камеры в canvas 8th Wall
      XR8.XrController.pipelineModule(),
      {
        name: 'sber-cat-anchor',
        onUpdate({ processCpuResult }: any) {
          const r = processCpuResult?.reality;
          if (!r) return;
          // поза камеры в мире
          const cq = new THREE.Quaternion(r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w);
          const cp = new THREE.Vector3(r.position.x, r.position.y, r.position.z);
          self.camera.matrix.compose(cp, cq, new THREE.Vector3(1, 1, 1));
          self.camera.matrixWorld.copy(self.camera.matrix);
          self.camera.matrixWorldInverse.copy(self.camera.matrix).invert();
          if (r.intrinsics) {
            self.camera.projectionMatrix.fromArray(r.intrinsics);
            self.camera.projectionMatrixInverse.copy(self.camera.projectionMatrix).invert();
          }
        },
        listeners: [
          { event: 'reality.imagefound', process: ({ detail }: any) => self.onImage(detail, true) },
          { event: 'reality.imageupdated', process: ({ detail }: any) => self.onImage(detail, true) },
          { event: 'reality.imagelost', process: () => self.onImage(null, false) },
        ],
      },
    ]);
    XR8.run({ canvas: this.canvas });
  }

  private onImage(detail: any, visible: boolean) {
    if (visible && detail) {
      // detail.position/rotation/scale — поза центра картинки в мире; scale = ширина картинки в ед. мира
      const q = new THREE.Quaternion(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w);
      // у 8th Wall нормаль картинки — +Y? Приводим к нашему соглашению (+Z — нормаль): поворот -90° по X
      q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      const s = detail.scale ?? this.cardWidthM;
      this.worldAnchor.compose(new THREE.Vector3(detail.position.x, detail.position.y, detail.position.z), q, new THREE.Vector3(s, s, s));
      this.anchored = true;
    }
    if (visible !== this.isTracking) {
      this.isTracking = visible;
      (visible ? this.found : this.lost).forEach((cb) => cb());
    }
  }

  stop() {
    window.XR8?.stop();
  }

  update() {
    if (!this.anchored) return;
    // якорь живёт в мире; камера движется — рендер берёт camera.matrixWorld
    this.anchor.matrix.copy(this.worldAnchor);
    this.anchor.matrixWorldNeedsUpdate = true;
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
  }

  setSmoothing() {
    /* у 8th Wall своё сглаживание */
  }
}
