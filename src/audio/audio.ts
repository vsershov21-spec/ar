/**
 * Звук: Howler.js.
 *  - категории: sfx (аудиоспрайт), voice (реплики, Web Audio), ambience (петли) — у каждой своя громкость;
 *  - ducking: пока звучит реплика, sfx и ambience приглушаются на −8 дБ;
 *  - вариации: play('glass_knock') выбирает случайный из glass_knock_1..N и меняет pitch ±5%;
 *  - iOS: unlock() в первом жесте; на старых iOS Web Audio молчит при включённом переключателе «Без звука» —
 *    UI показывает подсказку.
 *  - ОДИН AudioContext на всё приложение: его создаём сами (latencyHint 'playback' — крупнее буфер, реже будим
 *    поток звука) и отдаём Howler; микрофон, голос, фанфары, повтор — на нём же. Howler сам по себе на iOS
 *    (48 кГц ≠ 44.1) закрывал первый контекст и создавал второй, а на первом жесте плодил 10 HTML-Audio.
 *  - Аудиосессия iOS (navigator.audioSession, Safari 17+) выставляется ОДИН раз в unlock() и больше не трогается:
 *    смена playback ↔ play-and-record при открытии микрофона рвала камеру (чёрный фон). Если микрофон будет —
 *    сразу 'play-and-record' (то же, что iOS включает сама при захвате микрофона; не глушится «Без звука»).
 *    ?session=playback|play-and-record|auto|off — для проверки на устройстве.
 */
import { Howl, Howler } from 'howler';
import { asset } from '../core/util';

export type Category = 'sfx' | 'voice' | 'ambience';
const DUCK = Math.pow(10, -8 / 20); // −8 дБ ≈ 0.4
const DUCK_MIC = Math.pow(10, -14 / 20); // −14 дБ ≈ 0.2

export class Audio {
  private howl: Howl | null = null;
  private ambience: Howl | null = null;
  private sprite: Record<string, [number, number]> = {};
  private variants = new Map<string, string[]>();
  private lastVariant = new Map<string, string>();
  readonly volume: Record<Category, number> = { sfx: 0.9, voice: 1, ambience: 0.35 };
  private duckK = 1;
  private voiceGain: GainNode | null = null;
  muted = false;

  private sessionSet = false;
  /** был жест (unlock): до него микрофон не открываем — ни запроса доступа на старте, ни getUserMedia раньше камеры */
  unlocked = false;

  constructor() {
    const H = Howler as any;
    // Howler на iOS (контекст 48 кГц) закрывал свой первый AudioContext и создавал новый («баг iOS 9»)
    H._mobileUnloaded = true;
    // пул HTML5 Audio (10 элементов на первом жесте) не нужен: всё на Web Audio
    H.html5PoolSize = 0;
    // Howler сам усыпляет AudioContext через 30 с тишины — микрофон на том же контексте тогда замолкает
    H.autoSuspend = false;
    if (typeof window !== 'undefined' && !H.ctx) {
      try {
        const q = new URLSearchParams(location.search).get('latency');
        const AC = window.AudioContext ?? (window as any).webkitAudioContext;
        const ctx: AudioContext = new AC({ latencyHint: (q as AudioContextLatencyCategory) || 'playback' });
        H.ctx = ctx;
        H.usingWebAudio = true;
        H.masterGain = ctx.createGain();
        H.masterGain.gain.setValueAtTime(H._muted ? 0 : H._volume ?? 1, ctx.currentTime);
        H.masterGain.connect(ctx.destination);
        H._setup?.();
      } catch {
        /* Howler создаст свой */
      }
    }
    // iOS: после звонка/сворачивания контекст «interrupted» — будим при возврате
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        const ctx = this.ctx;
        if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
      });
    // iOS: камера/микрофон/звонок переводят контекст в «interrupted», а resume вне жеста может не сработать —
    // каждое касание (после первого unlock) будит контекст заранее: реплика на это касание звучит без задержки
    if (typeof document !== 'undefined')
      document.addEventListener(
        'pointerdown',
        () => {
          const ctx = this.ctx;
          if (this.unlocked && ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
        },
        { capture: true, passive: true },
      );
  }

  async load(url: string) {
    const r = await fetch(asset(url));
    const j = (await r.json()) as { src: string[]; sprite: Record<string, [number, number]> };
    this.sprite = j.sprite;
    for (const key of Object.keys(j.sprite)) {
      const base = key.replace(/_\d+$/, '');
      if (!this.variants.has(base)) this.variants.set(base, []);
      this.variants.get(base)!.push(key);
      if (base !== key) {
        if (!this.variants.has(key)) this.variants.set(key, [key]);
      }
    }
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

  /**
   * Вызывать синхронно внутри обработчика жеста. willRecord — микрофон будет (поддерживается): тогда
   * аудиосессия сразу 'play-and-record', и открытие микрофона её уже не переключает.
   */
  unlock(willRecord = false) {
    this.initSession(willRecord);
    this.unlocked = true;
    try {
      const ctx = Howler.ctx;
      if (ctx && ctx.state !== 'running') void ctx.resume();
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

  /** true — iOS без audioSession API: возможно, мешает беззвучный режим (показываем подсказку) */
  get maybeSilentSwitch() {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios && !(navigator as any).audioSession;
  }

  get ctx(): AudioContext | null {
    return (Howler.ctx as AudioContext) ?? null;
  }

  /** узел, куда подключать голос (громкость категории voice) */
  voiceOut(): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (!this.voiceGain) {
      this.voiceGain = ctx.createGain();
      this.voiceGain.gain.value = this.volume.voice;
      this.voiceGain.connect((Howler as any).masterGain ?? ctx.destination);
    }
    return this.voiceGain;
  }

  has(name: string) {
    return this.variants.has(name) || name in this.sprite;
  }

  play(name: string | string[] | undefined, volume = 1, opts: { pitchJitter?: number } = {}) {
    if (!name || !this.howl) return;
    const base = Array.isArray(name) ? name[Math.floor(Math.random() * name.length)] : name;
    const vars = this.variants.get(base);
    if (!vars?.length) {
      console.warn('[audio] нет звука', base);
      return;
    }
    // случайный вариант, не повторяя предыдущий
    let key = vars[Math.floor(Math.random() * vars.length)];
    if (vars.length > 1 && key === this.lastVariant.get(base)) key = vars[(vars.indexOf(key) + 1) % vars.length];
    this.lastVariant.set(base, key);
    const id = this.howl.play(key);
    this.howl.volume(volume * this.volume.sfx * this.duckK, id);
    const j = opts.pitchJitter ?? 0.05;
    this.howl.rate(1 + (Math.random() * 2 - 1) * j, id);
  }

  /** вход для синтеза Web Audio (шипение баллончика, src/card/paintSound.ts): громкость sfx и приглушение; выкл. звук — null */
  synthOut(volume = 1): GainNode | null {
    const ctx = this.ctx;
    if (!ctx || this.muted) return null;
    const out = ctx.createGain();
    out.gain.value = volume * this.volume.sfx * this.duckK;
    out.connect((Howler as any).masterGain ?? ctx.destination);
    return out;
  }

  /**
   * Фанфары «та-да-да-дам!» (~1,2 с) — когда кот впервые выскочил из карты. Синтез Web Audio (файла в спрайте нет):
   * «медные» пилы через фильтр, восходящее арпеджио до-ми-соль и аккорд до мажор, сверху — звёздочки.
   */
  fanfare(volume = 0.5) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const out = ctx.createGain();
    out.gain.value = volume * this.volume.sfx * this.duckK;
    out.connect((Howler as any).masterGain ?? ctx.destination);
    const t0 = ctx.currentTime + 0.02;
    const note = (f: number, at: number, dur: number, g = 0.22, type: OscillatorType = 'sawtooth') => {
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), env = ctx.createGain();
      o.type = o2.type = type;
      o.frequency.value = f;
      o2.frequency.value = f * 1.004; // лёгкий хорус — «труба», а не писк
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t0 + at);
      lp.frequency.linearRampToValueAtTime(3200, t0 + at + 0.06);
      lp.frequency.exponentialRampToValueAtTime(1400, t0 + at + dur);
      env.gain.setValueAtTime(0.0001, t0 + at);
      env.gain.exponentialRampToValueAtTime(g, t0 + at + 0.025);
      env.gain.setValueAtTime(g, t0 + at + dur * 0.7);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(lp);
      o2.connect(lp);
      lp.connect(env).connect(out);
      for (const x of [o, o2]) {
        x.start(t0 + at);
        x.stop(t0 + at + dur + 0.05);
      }
    };
    // C5 E5 G5 — C6 + аккорд
    note(523.25, 0, 0.13);
    note(659.25, 0.12, 0.13);
    note(783.99, 0.24, 0.13);
    for (const f of [523.25, 659.25, 783.99, 1046.5]) note(f, 0.38, 0.75, 0.13);
    for (let i = 0; i < 6; i++) note(2093 * (1 + i * 0.12), 0.42 + i * 0.07, 0.12, 0.05, 'triangle');
    setTimeout(() => out.disconnect(), 1600);
  }

  playAmbience(url: string) {
    this.ambience?.unload();
    this.ambience = new Howl({ src: [asset(url)], loop: true, volume: this.volume.ambience * this.duckK });
    this.ambience.play();
  }

  setVolume(cat: Category, v: number) {
    this.volume[cat] = v;
    if (cat === 'voice' && this.voiceGain) this.voiceGain.gain.value = v;
    this.applyDuck();
  }

  private duckReasons = new Set<string>();
  /**
   * Приглушить sfx/ambience. Причины складываются: 'voice' — говорит кот (−8 дБ),
   * 'mic' — слушаем ребёнка (−14 дБ: меньше своего звука в микрофоне и распознавании).
   */
  duck(on: boolean, reason: 'voice' | 'mic' = 'voice') {
    if (on) this.duckReasons.add(reason);
    else this.duckReasons.delete(reason);
    this.duckK = this.duckReasons.has('mic') ? DUCK_MIC : this.duckReasons.size ? DUCK : 1;
    this.applyDuck();
  }

  /**
   * iOS/Safari 17+: тип аудиосессии — ОДИН раз за страницу. 'playback' — звук и при «Без звука»;
   * 'play-and-record' — то же плюс микрофон. Переключение туда-обратно (раньше — при каждом открытии/закрытии
   * микрофона) на iOS прерывает захват камеры и уводит звук. Повторные вызовы ничего не делают.
   */
  initSession(willRecord: boolean) {
    if (this.sessionSet) return;
    this.sessionSet = true;
    try {
      const nav = navigator as any;
      if (!nav.audioSession) return;
      const q = new URLSearchParams(location.search).get('session');
      if (q === 'off') return;
      const type = q && ['playback', 'play-and-record', 'auto', 'ambient'].includes(q) ? q : willRecord ? 'play-and-record' : 'playback';
      if (nav.audioSession.type !== type) nav.audioSession.type = type;
    } catch {
      /* ignore */
    }
  }

  /** тип аудиосессии сейчас (debug) */
  get sessionType(): string {
    return (navigator as any).audioSession?.type ?? '—';
  }

  private applyDuck() {
    const h = this.howl as any;
    // уже играющие звуки — плавно
    if (h?._sounds) for (const s of h._sounds) if (!s._paused && !s._ended) this.howl!.fade(s._volume, this.volume.sfx * this.duckK, 120, s._id);
    this.ambience?.fade(this.ambience.volume(), this.volume.ambience * this.duckK, 200);
  }

  setMuted(m: boolean) {
    this.muted = m;
    Howler.mute(m);
  }
}
