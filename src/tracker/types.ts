import type * as THREE from 'three';

/** Что умеет конкретная технология распознавания. */
export interface TrackerCapabilities {
  /** распознаёт изображение карты */
  imageTarget: boolean;
  /** знает движение телефона в мире (SLAM / WebXR): якорь живёт, когда карта ушла из кадра */
  worldTracking: boolean;
  /** только поворот телефона (DeviceOrientation, 3DoF) — фоллбэк при потере карты */
  orientationFallback: boolean;
}

/**
 * Адаптер распознавания. Реализации:
 *  - MindARTracker   — карта (image target) + фоллбэк 3DoF при потере;
 *  - EighthWallTracker — карта задаёт якорь, дальше мировой трекинг (SLAM) — опционально;
 *  - WebXRTracker    — Android Chrome, hit-test по поверхности (без карты);
 *  - DebugTracker    — ?debug, без камеры.
 *
 * Соглашения (одинаковы для всех реализаций):
 * - anchor и camera — в одной «мировой» системе. У MindAR/Debug мир = пространство камеры
 *   (камера в начале координат, смотрит в -Z); у WebXR/8th Wall камера движется по миру.
 * - anchor.matrix — поза центра карты (или точки на поверхности); 1 единица = ширина карты;
 *   плоскость XY — плоскость карты/стола, +X вправо по картинке, +Y к верхнему краю, +Z — нормаль вверх.
 * - anchorValid=true — позой якоря можно пользоваться (карта видна ИЛИ её держит мировой трекинг/3DoF).
 */
export interface Tracker {
  readonly name: string;
  readonly capabilities: TrackerCapabilities;
  readonly anchor: THREE.Group;
  readonly camera: THREE.PerspectiveCamera;
  /** карта прямо сейчас в кадре */
  readonly isTracking: boolean;
  /** якорю можно доверять (карта видна или удерживается мировым трекингом) */
  readonly anchorValid: boolean;
  /** соотношение сторон маркера (ширина/высота) */
  readonly aspect: number;
  start(): Promise<void>;
  stop(): void;
  onFound(cb: () => void): () => void;
  onLost(cb: () => void): () => void;
  /** вызывать каждый кадр: сглаживание, удержание позы */
  update(dt: number, t: number): void;
  resize(w: number, h: number): void;
  setSmoothing(minCutoff: number, beta: number): void;
  /** для трекеров, которым нужен рендерер (WebXR) */
  attachRenderer?(renderer: THREE.WebGLRenderer): void;
}
