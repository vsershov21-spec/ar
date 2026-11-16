/**
 * Трекер-заглушка для ?debug: без камеры. Карта «лежит на столе» перед камерой,
 * найдена/потеряна — кнопками. Рисует саму карту (текстура card.png), чтобы видеть привязку.
 */
import * as THREE from 'three';
import { TrackerBase } from './base';
import type { Tracker } from './types';
import { CARD_ASPECT } from '../config';

export class DebugTracker extends TrackerBase implements Tracker {
  readonly capabilities = { imageTarget: true, worldTracking: false, orientationFallback: false };
  readonly name = 'debug';
  readonly aspect = CARD_ASPECT;
  readonly card: THREE.Mesh;
  wobble = false;
  /** наклон карты: 0 — лицом к камере, ~1.05 рад — лежит на столе, камера под углом ~30° */
  tilt = 1.0;
  distance = 2.1;
  yaw = 0.0;

  constructor(cardImageUrl: string) {
    super();
    this.camera.fov = 55;
    this.camera.near = 0.01;
    this.camera.far = 100;
    const tex = new THREE.TextureLoader().load(cardImageUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(1, 1 / CARD_ASPECT);
    this.card = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
    this.card.name = 'debug-card';
    this.card.renderOrder = -1;
    // скруглённые углы карты — маской через alphaMap
    this.card.material = new THREE.MeshBasicMaterial({ map: tex, alphaMap: roundedMask(), transparent: true });
    this.anchor.add(this.card);
    this.target = new THREE.Matrix4();
    this.placeCard(0);
  }

  placeCard(t: number) {
    const w = this.wobble ? 1 : 0;
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-this.tilt + w * 0.05 * Math.sin(t * 0.9), this.yaw + w * 0.25 * Math.sin(t * 0.4), w * 0.04 * Math.sin(t * 1.3)),
    );
    const p = new THREE.Vector3(w * 0.06 * Math.sin(t * 0.7), -0.35, -this.distance);
    this.target!.compose(p, q, new THREE.Vector3(1, 1, 1));
  }

  async start() {
    this.setFound(true);
  }
  stop() {
    this.setFound(false);
  }
  simulate(found: boolean) {
    this.setFound(found);
  }
  update(dt: number, t: number) {
    this.placeCard(t);
    super.update(dt, t);
  }
  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

function roundedMask() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = Math.round(256 / CARD_ASPECT);
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, 14);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  return t;
}
