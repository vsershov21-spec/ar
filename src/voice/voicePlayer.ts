/**
 * Проигрыватель реплик.
 *  1) Записанная реплика (public/sounds/voice/manifest.json, собирается `npm run voice:build`):
 *     Web Audio → категория voice (Howler masterGain) + липсинк по готовым cues Rhubarb,
 *     если cues нет — рантайм-анализ wawa-lipsync.
 *  2) Нет записи (или реплика с {name}) → speechSynthesis ru-RU с pitch/rate персоны,
 *     липсинк — cues из текста. Это только фоллбэк до записи голоса.
 * Во время реплики sfx приглушаются (ducking −8 дБ).
 */
import { asset } from '../core/util';
import type { Audio } from '../audio/audio';
import { LipSync } from '../lipsync/lipsync';
import { cuesFromText, estimateSpeechSec, type MouthCue } from '../lipsync/visemes';

export interface VoiceEntry { text: string; emotion: string; event: string; duration: number; src: string[]; cues?: string; lipsync?: string }
export type VoiceManifest = Record<string, Record<string, VoiceEntry>>;

export interface SpeakRequest {
  persona: string;
  /** шаблон реплики (как в persona JSON, с {name}) — по нему ищется запись */
  template: string;
  /** итоговый текст (для синтеза/субтитров) */
  text: string;
  pitch: number;
  rate: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9{}]/g, '');

export class VoicePlayer {
  readonly lip = new LipSync();
  manifest: VoiceManifest = {};
  private index = new Map<string, { id: string; e: VoiceEntry }>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private cues = new Map<string, Promise<MouthCue[] | null>>();
  private src: AudioBufferSourceNode | null = null;
  private synthVoice: SpeechSynthesisVoice | null = null;
  private gen = 0;
  speaking = false;
  muted = false;
  /** что сейчас звучит: 'file' | 'synth' */
  mode: 'file' | 'synth' | null = null;

  constructor(private audio: Audio) {
    if (typeof speechSynthesis !== 'undefined') {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.synthVoice = vs.find((v) => v.lang === 'ru-RU' && /Milena|Милена|Yuri|Google/i.test(v.name)) ?? vs.find((v) => v.lang.startsWith('ru')) ?? null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  async load(url: string) {
    try {
      const r = await fetch(asset(url));
      if (r.ok) this.manifest = await r.json();
    } catch {
      /* нет записанных реплик — только синтез */
    }
    for (const [p, lines] of Object.entries(this.manifest)) for (const [id, e] of Object.entries(lines)) this.index.set(`${p}:${norm(e.text)}`, { id, e });
  }

  find(persona: string, template: string) {
    if (template.includes('{')) return null; // реплики с именем пока синтезируем
    return this.index.get(`${persona}:${norm(template)}`) ?? null;
  }

  /** iOS: первый вызов speechSynthesis — из жеста */
  unlock() {
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }

  cancel() {
    this.gen++;
    try {
      speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.src?.stop();
    } catch {
      /* ignore */
    }
    this.src = null;
    this.end();
  }

  private end() {
    this.speaking = false;
    this.mode = null;
    this.lip.stop();
    this.audio.duck(false);
  }

  private buffer(e: VoiceEntry): Promise<AudioBuffer | null> {
    const key = e.src[0];
    if (!this.buffers.has(key)) {
      this.buffers.set(key, (async () => {
        const ctx = this.audio.ctx;
        if (!ctx) return null;
        for (const s of e.src) {
          try {
            const data = await fetch(asset(s)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()));
            return await ctx.decodeAudioData(data);
          } catch {
            /* следующий формат */
          }
        }
        return null;
      })());
    }
    return this.buffers.get(key)!;
  }

  private loadCues(e: VoiceEntry): Promise<MouthCue[] | null> {
    if (!e.cues) return Promise.resolve(null);
    if (!this.cues.has(e.cues)) this.cues.set(e.cues, fetch(asset(e.cues)).then((r) => r.json()).then((j) => j.mouthCues as MouthCue[]).catch(() => null));
    return this.cues.get(e.cues)!;
  }

  /** предзагрузка (например, реплик сценария) */
  preload(persona: string, template: string) {
    const f = this.find(persona, template);
    if (f) {
      void this.buffer(f.e);
      void this.loadCues(f.e);
    }
  }

  async speak(req: SpeakRequest): Promise<void> {
    this.cancel();
    const gen = this.gen;
    if (this.muted) return;
    const rec = this.find(req.persona, req.template);
    if (rec) {
      const [buf, cues] = await Promise.all([this.buffer(rec.e), this.loadCues(rec.e)]);
      if (gen !== this.gen) return;
      const ctx = this.audio.ctx;
      const out = this.audio.voiceOut();
      if (buf && ctx && out) return this.playBuffer(ctx, out, buf, cues, gen);
    }
    return this.synth(req, gen);
  }

  private playBuffer(ctx: AudioContext, out: AudioNode, buf: AudioBuffer, cues: MouthCue[] | null, gen: number) {
    return new Promise<void>((resolve) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(out);
      this.src = s;
      this.speaking = true;
      this.mode = 'file';
      this.audio.duck(true);
      if (cues) this.lip.playCues(cues, () => ctx.currentTime);
      else this.lip.playAnalyser(ctx, s);
      s.onended = () => {
        if (gen === this.gen) this.end();
        resolve();
      };
      s.start();
    });
  }

  private synth(req: SpeakRequest, gen: number) {
    if (typeof speechSynthesis === 'undefined') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(req.text);
      u.lang = 'ru-RU';
      if (this.synthVoice) u.voice = this.synthVoice;
      u.pitch = req.pitch;
      u.rate = req.rate;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (gen === this.gen) this.end();
        resolve();
      };
      u.onstart = () => {
        if (gen !== this.gen) return;
        this.speaking = true;
        this.mode = 'synth';
        this.audio.duck(true);
        this.lip.playCues(cuesFromText(req.text, estimateSpeechSec(req.text, req.rate)), () => performance.now() / 1000);
      };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
      // страховка: на части устройств onstart/onend не приходят (или нет голосов) —
      // показываем липсинк по тексту и завершаем по оценке длительности
      const est = estimateSpeechSec(req.text, req.rate);
      setTimeout(() => {
        if (!this.speaking && !done && gen === this.gen) u.onstart?.(new Event('start') as any);
      }, 400);
      setTimeout(finish, (est + 1.2) * 1000);
    });
  }

  update(dt: number) {
    this.lip.update(dt);
  }
}
