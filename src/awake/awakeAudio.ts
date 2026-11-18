/**
 * Звуки пробуждения: отдельный аудиоспрайт public/sounds/awake.{mp3,m4a} (scripts/gen_awake_sounds.py —
 * синтез оффлайн, лицензионно чистый): фанфары каждого образа (2,5–3 с и короткие ~1 с), «пуф/дзынь» выхода,
 * подъём портала, хлопки салюта. На том же AudioContext, что и всё приложение (Howler.ctx), громкость категории
 * sfx и приглушение под голос — как у Audio. Грузится после основного спрайта; не успел — фанфары синтезом
 * (Audio.fanfare), остальное молча.
 */
import { Howl } from 'howler';
import { asset } from '../core/util';
import type { Audio } from '../audio/audio';

export class AwakeAudio {
  private howl: Howl | null = null;
  private sprite: Record<string, [number, number]> = {};
  ready = false;

  constructor(private audio: Audio) {}

  async load(url = 'sounds/awake.json') {
    try {
      const r = await fetch(asset(url));
      const j = (await r.json()) as { src: string[]; sprite: Record<string, [number, number]> };
      this.sprite = j.sprite;
      const dir = url.replace(/[^/]+$/, '');
      // iOS/Safari — AAC (m4a) первым: декодируется аппаратно; остальным — mp3
      const ios = typeof navigator !== 'undefined' && /iP(hone|ad|od)|Macintosh.*Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Android/.test(navigator.userAgent);
      const src = [...j.src].sort((a, b) => (ios ? +b.endsWith('.m4a') - +a.endsWith('.m4a') : 0)).map((s) => asset(dir + s));
      await new Promise<void>((resolve) => {
        this.howl = new Howl({
          src,
          sprite: j.sprite,
          preload: true,
          html5: false,
          onload: () => {
            this.ready = true;
            resolve();
          },
          onloaderror: (_id, e) => {
            console.warn('[awake] звуки не загрузились', e);
            resolve();
          },
        });
      });
    } catch (e) {
      console.warn('[awake] awake.json', e);
    }
  }

  has(id: string) {
    return this.ready && id in this.sprite;
  }

  play(id: string, vol = 1, rate = 1) {
    if (!this.howl || !this.has(id) || this.audio.muted) return false;
    const a = this.audio as unknown as { volume: { sfx: number }; duckK?: number };
    const sid = this.howl.play(id);
    this.howl.volume(vol * a.volume.sfx * (a.duckK ?? 1), sid);
    if (rate !== 1) this.howl.rate(rate, sid);
    return true;
  }

  stopAll() {
    this.howl?.stop();
  }
}
