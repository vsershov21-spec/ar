/**
 * ?nocard — «кот на столе» без карты (страница тестовых флоу /test): кот сразу стоит на виртуальной площадке перед
 * камерой, поза фиксированная (как карта, лежащая на столе в 30 см). Камера — фоном (?nocard или ?nocard=cam),
 * без камеры (?nocard=off) — фирменный фон. Нужен, чтобы продакт и команды проверяли сценарий, реплики, мини-игры
 * и касания без поиска карты. Карта «найдена» сразу после «Открыть камеру»; потеря карты — только кнопками debug.
 */
import { DebugTracker } from './debugTracker';

export class NoCardTracker extends DebugTracker {
  /** App.wake: камера и микрофон одним запросом (iOS) */
  withAudio = false;
  audioStream: MediaStream | null = null;
  video: HTMLVideoElement | null = null;

  constructor(cardImageUrl: string, private root: HTMLElement, private camera_ = true) {
    super(cardImageUrl);
    this.card.visible = false;
    // площадка ближе и ниже, чем карта в ?debug: кот крупно, лапы у нижней трети экрана
    this.distance = 2.6;
    this.tilt = 1.05;
  }

  /** камера фоном; не открылась (запрет, нет камеры) — фирменный фон, кот всё равно выходит */
  async startVideo() {
    if (!this.camera_ || !navigator.mediaDevices?.getUserMedia) return this.background();
    const v = document.createElement('video');
    v.className = 'camera-video';
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.autoplay = true;
    Object.assign(v.style, { inset: '0', width: '100%', height: '100%' });
    this.root.prepend(v);
    try {
      const video = { facingMode: 'environment', width: { ideal: 960 }, height: { ideal: 540 } };
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video, audio: this.withAudio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 } : false });
      } catch {
        s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      }
      const at = s.getAudioTracks();
      this.audioStream = at.length ? new MediaStream(at) : null;
      v.srcObject = new MediaStream(s.getVideoTracks());
      await v.play().catch(() => undefined);
      this.video = v;
    } catch {
      v.remove();
      this.background();
    }
  }

  private background() {
    if (this.root.querySelector('.debug-bg')) return;
    const bg = document.createElement('div');
    bg.className = 'debug-bg';
    this.root.prepend(bg);
  }
}
