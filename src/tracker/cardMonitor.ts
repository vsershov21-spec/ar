/**
 * Наблюдатель за картой и кадром: «карта далеко / слишком близко», «темно».
 * Чистая часть (CardMonitor) — по ширине карты в долях кадра и средней яркости; покрыта тестами.
 *  card_far   — карта уже 12% ширины кадра дольше 2 с;
 *  card_close — шире 90% дольше 2 с;
 *  low_light  — средняя яркость ниже порога дольше 3 с (кадр уменьшается до 32×24 раз в 500 мс).
 * Каждое событие — один раз, пока условие не уйдёт (с гистерезисом), не чаще cooldown из events.json у director.
 */
import * as THREE from 'three';
import type { Tracker } from './types';

export interface CardMonitorConfig {
  farFrac: number;
  closeFrac: number;
  holdMs: number;
  /** яркость 0..255 */
  darkLuma: number;
  darkHoldMs: number;
  /** гистерезис: условие считается ушедшим, только если вышли за порог на столько (доля / единицы яркости) */
  hystFrac: number;
  hystLuma: number;
}
export const defaultCardMonitorConfig: CardMonitorConfig = { farFrac: 0.12, closeFrac: 0.9, holdMs: 2000, darkLuma: 40, darkHoldMs: 3000, hystFrac: 0.03, hystLuma: 12 };

export type CardEvent = 'card_far' | 'card_close' | 'low_light';

export class CardMonitor {
  private farT = 0;
  private closeT = 0;
  private darkT = 0;
  private fired = new Set<CardEvent>();
  constructor(private emit: (e: CardEvent) => void, readonly cfg: CardMonitorConfig = defaultCardMonitorConfig) {}

  /** ширина карты в долях ширины кадра (null — карты нет в кадре) */
  card(frac: number | null, dtMs: number) {
    const c = this.cfg;
    if (frac === null) {
      this.farT = this.closeT = 0;
      return;
    }
    this.farT = frac < c.farFrac ? this.farT + dtMs : 0;
    this.closeT = frac > c.closeFrac ? this.closeT + dtMs : 0;
    if (frac > c.farFrac + c.hystFrac) this.fired.delete('card_far');
    if (frac < c.closeFrac - c.hystFrac) this.fired.delete('card_close');
    this.fire('card_far', this.farT >= c.holdMs);
    this.fire('card_close', this.closeT >= c.holdMs);
  }

  /** средняя яркость кадра 0..255 (замер раз в ~500 мс; dtMs — с прошлого замера) */
  light(luma: number, dtMs: number) {
    const c = this.cfg;
    this.darkT = luma < c.darkLuma ? this.darkT + dtMs : 0;
    if (luma > c.darkLuma + c.hystLuma) this.fired.delete('low_light');
    this.fire('low_light', this.darkT >= c.darkHoldMs);
  }

  private fire(e: CardEvent, cond: boolean) {
    if (cond && !this.fired.has(e)) {
      this.fired.add(e);
      this.emit(e);
    }
  }
}

const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
/** ширина карты на экране в долях ширины экрана (по проекции углов якоря) */
export function cardScreenFrac(tracker: Tracker): number | null {
  if (!tracker.isTracking) return null;
  const a = tracker.anchor;
  a.updateMatrixWorld(true);
  const hy = 0.5 / tracker.aspect;
  corners[0].set(-0.5, -hy, 0);
  corners[1].set(0.5, -hy, 0);
  corners[2].set(0.5, hy, 0);
  corners[3].set(-0.5, hy, 0);
  let minX = Infinity, maxX = -Infinity;
  for (const c of corners) {
    c.applyMatrix4(a.matrixWorld).project(tracker.camera);
    if (c.z > 1) return null; // за камерой
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
  }
  return Math.max(0, (Math.min(1, maxX) - Math.max(-1, minX)) / 2);
}

/** средняя яркость видео на уменьшенном кадре 32×24 (дёшево: ~0,1 мс) */
export class LumaSampler {
  private c = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  constructor() {
    this.c.width = 32;
    this.c.height = 24;
    this.g = this.c.getContext('2d', { willReadFrequently: true })!;
  }
  sample(video: HTMLVideoElement | null | undefined): number | null {
    if (!video || video.readyState < 2 || !video.videoWidth) return null;
    this.g.drawImage(video, 0, 0, 32, 24);
    const d = this.g.getImageData(0, 0, 32, 24).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return s / (d.length / 4);
  }
}
