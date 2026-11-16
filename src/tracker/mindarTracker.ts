/**
 * Адаптер MindAR (image tracking). Используем Controller из mind-ar напрямую, без MindARThree:
 * MindARThree 1.2.5 импортирует `sRGBEncoding` из three, которого нет начиная с r162,
 * и навязывает свой WebGLRenderer + CSS3DRenderer. Логика камеры/видео повторяет MindARThree.
 * Тяжёлый пакет (tfjs внутри, ~2 МБ) грузится динамически только при старте AR.
 */
import * as THREE from 'three';
import { TrackerBase } from './base';
import type { Tracker } from './types';

export interface MindAROptions {
  filterMinCF?: number;
  filterBeta?: number;
  warmupTolerance?: number;
  missTolerance?: number;
}

export class MindARTracker extends TrackerBase implements Tracker {
  readonly capabilities = { imageTarget: true, worldTracking: false, orientationFallback: true };
  readonly name = 'mindar';
  aspect = 1.586;
  video: HTMLVideoElement | null = null;
  private controller: any = null;
  private postMatrix = new THREE.Matrix4();
  private w = 1;
  private h = 1;

  constructor(private container: HTMLElement, private targetSrc: string, private opts: MindAROptions = {}) {
    super();
  }

  /** Камера: вызывать прямо из обработчика жеста (iOS требует user gesture для getUserMedia/play). */
  async startVideo(): Promise<void> {
    const video = document.createElement('video');
    // как в рабочем референсе ar_cart: атрибуты, а не только свойства — иначе iOS Safari не играет inline
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.playsInline = true;
    video.className = 'camera-video';
    this.container.prepend(video);
    this.video = video;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-getusermedia');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.srcObject = stream;
    });
    video.setAttribute('width', String(video.videoWidth));
    video.setAttribute('height', String(video.videoHeight));
    await video.play().catch(() => undefined);
  }

  async start(): Promise<void> {
    if (!this.video) await this.startVideo();
    this.hold.start();
    const video = this.video!;
    const { Controller } = await import('mind-ar/dist/mindar-image.prod.js');
    this.controller = new Controller({
      inputWidth: video.videoWidth,
      inputHeight: video.videoHeight,
      filterMinCF: this.opts.filterMinCF ?? null,
      filterBeta: this.opts.filterBeta ?? null,
      warmupTolerance: this.opts.warmupTolerance ?? null,
      missTolerance: this.opts.missTolerance ?? null,
      maxTrack: 1,
      onUpdate: (data) => {
        if (data.type !== 'updateMatrix') return;
        if (data.worldMatrix) {
          const m = new THREE.Matrix4();
          m.fromArray(data.worldMatrix);
          m.multiply(this.postMatrix);
          this.target = m;
          this.setFound(true);
        } else {
          this.setFound(false);
        }
      },
    });
    this.resize(this.w, this.h);
    const { dimensions } = await this.controller.addImageTargets(this.targetSrc);
    const [mw, mh] = dimensions[0];
    this.aspect = mw / mh;
    // как в MindARThree: центр маркера и масштаб «1 = ширина маркера»
    this.postMatrix.compose(
      new THREE.Vector3(mw / 2, mw / 2 + (mh - mw) / 2, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(mw, mw, mw),
    );
    await this.controller.dummyRun(video);
    this.controller.processVideo(video);
    this.resize(this.w, this.h);
  }

  stop() {
    this.controller?.stopProcessVideo();
    const s = this.video?.srcObject as MediaStream | null;
    s?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    this.video = null;
  }

  /** Повторяет MindARThree.resize: fov из проекции контроллера с поправкой на обрезку видео (object-fit: cover). */
  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    const video = this.video;
    if (!video || !this.controller || !video.videoWidth) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      return;
    }
    const videoRatio = video.videoWidth / video.videoHeight;
    const containerRatio = w / h;
    let vw: number, vh: number;
    if (videoRatio > containerRatio) {
      vh = h;
      vw = vh * videoRatio;
    } else {
      vw = w;
      vh = vw / videoRatio;
    }
    const proj = this.controller.getProjectionMatrix();
    const inputRatio = this.controller.inputWidth / this.controller.inputHeight;
    const inputAdjust = inputRatio > containerRatio ? video.videoWidth / this.controller.inputWidth : video.videoHeight / this.controller.inputHeight;
    let videoDisplayHeight: number;
    if (inputRatio > containerRatio) videoDisplayHeight = h * inputAdjust;
    else videoDisplayHeight = (w / this.controller.inputWidth) * this.controller.inputHeight * inputAdjust;
    const fovAdjust = h / videoDisplayHeight;
    this.camera.fov = (2 * Math.atan((1 / proj[5]) * fovAdjust) * 180) / Math.PI;
    this.camera.near = proj[14] / (proj[10] - 1.0);
    this.camera.far = proj[14] / (proj[10] + 1.0);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    Object.assign(video.style, {
      top: `${-(vh - h) / 2}px`,
      left: `${-(vw - w) / 2}px`,
      width: `${vw}px`,
      height: `${vh}px`,
    });
  }
}
