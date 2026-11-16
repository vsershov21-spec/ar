/**
 * Звук: Howler.js, один аудиоспрайт (sfx.json) — минимальная задержка (Web Audio, всё в памяти).
 * iOS: звук разблокируется только из жеста — unlock() вызывается в обработчике «Разбудить кота».
 */
import { Howl, Howler } from 'howler';
import { asset } from '../core/util';

export class Audio {
  private howl: Howl | null = null;
  private sprite: Record<string, [number, number]> = {};
  muted = false;

  async load(url: string) {
    const r = await fetch(asset(url));
    const j = (await r.json()) as { src: string[]; sprite: Record<string, [number, number]> };
    this.sprite = j.sprite;
    const dir = url.replace(/[^/]+$/, '');
    await new Promise<void>((resolve) => {
      this.howl = new Howl({
        src: j.src.map((s) => asset(dir + s)),
        sprite: j.sprite,
        preload: true,
        html5: false,
        onload: () => resolve(),
        onloaderror: (_id, e) => {
          console.warn('[audio] load error', e);
          resolve();
        },
      });
    });
  }

  /** вызывать синхронно внутри обработчика жеста */
  unlock() {
    try {
      const ctx = Howler.ctx;
      if (ctx && ctx.state !== 'running') void ctx.resume();
      // короткий беззвучный буфер — классический способ «разбудить» аудио в iOS Safari
      if (ctx) {
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
      }
    } catch {
      /* ignore */
    }
  }

  get ctx(): AudioContext | null {
    return (Howler.ctx as AudioContext) ?? null;
  }

  has(name: string) {
    return name in this.sprite;
  }

  play(name: string | string[] | undefined, volume = 1) {
    if (!name || this.muted || !this.howl) return;
    const n = Array.isArray(name) ? name[Math.floor(Math.random() * name.length)] : name;
    if (!this.has(n)) {
      console.warn('[audio] нет звука', n);
      return;
    }
    const id = this.howl.play(n);
    this.howl.volume(volume, id);
  }

  setMuted(m: boolean) {
    this.muted = m;
    Howler.mute(m);
  }
}
