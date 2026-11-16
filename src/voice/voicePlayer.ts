/**
 * Проигрыватель реплик кота.
 *
 *  1) Записанная реплика (voice/manifest.json + voice/<persona>.<hash>.json, собирается `npm run voice:piper`):
 *     Web Audio → категория voice; рот — по готовым русским cues (фонемы espeak-ng + выравнивание),
 *     либо `?lips=amp` — по огибающей самого звука (стратегия «амплитуда»).
 *     Манифест характера грузится лениво — при первой реплике этого характера (или usePersona()).
 *  2) Реплика с {name}: «префикс» + имя (отдельный файл из словаря names.ru.txt) + «суффикс» склеиваются
 *     в один буфер. Имени нет в словаре → синтез всей фразы.
 *  3) Нет записи → speechSynthesis ru-RU с pitch/rate персоны, рот — по буквам. Только фоллбэк.
 *
 * Перебивание (barge-in): fadeOut(120) — реплика затухает, очередь DialogQueue сохраняется.
 * Самопрослушивание: onSpeaking(true/false) — VoiceEngine глушит распознавание на время реплики + 250 мс.
 */
import { asset } from '../core/util';
import type { Audio } from '../audio/audio';
import { LipSync } from '../lipsync/lipsync';
import { cuesFromText, estimateSpeechSec, type MouthCue } from '../lipsync/visemes';
import { cuesFromAmplitude } from '../lipsync/ru';
import { frames } from '../audio/dsp';

/** Один файл озвучки в манифесте характера */
export interface ClipEntry {
  /** путь относительно voice/ */
  f: string;
  /** длительность, с */
  d: number;
  /** начало звука (первый громкий кадр), с — для компенсации задержки декодера MP3 */
  o: number;
  /** cues: «X0 D120 B210 …» — визема + начало в мс */
  c: string;
  /** текст (для поиска по тексту) */
  t?: string;
  /** знаки перед суффиксом («! Погнали» → «!») */
  lead?: string;
}
export interface PersonaVoice {
  persona: string;
  format: string;
  lines: Record<string, ClipEntry>;
  parts: Record<string, { t?: string; a?: ClipEntry; b?: ClipEntry }>;
  names: Record<string, ClipEntry>;
}
export interface VoiceIndex {
  version: number;
  codec?: string;
  lipsync?: string;
  personas: Record<string, { manifest: string; lines: number; names: number; templates: number }>;
}
/** Старый формат (public/sounds/voice/manifest.json, npm run voice:build) */
export interface LegacyEntry { text: string; emotion: string; event: string; duration: number; src: string[]; cues?: string; lipsync?: string }
export type VoiceManifest = Record<string, Record<string, { text: string }>>;

export interface SpeakRequest {
  persona: string;
  /** шаблон реплики (как в persona JSON, с {name}) — по нему ищется запись */
  template: string;
  /** итоговый текст (для синтеза/субтитров) */
  text: string;
  pitch: number;
  rate: number;
  /** id реплики (hooligan.tap_cat.02) — точнее, чем поиск по тексту */
  lineId?: string;
}

export type LipStrategy = 'phon' | 'amp';

export const normText = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9{}]/g, '');
export const normName = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е');

export function unpackCues(c: string, total: number): MouthCue[] {
  const out: MouthCue[] = [];
  for (const tok of c.split(' ')) {
    if (!tok) continue;
    const start = Number(tok.slice(1)) / 1000;
    if (out.length) out[out.length - 1].end = start;
    out.push({ start, end: total, value: tok[0] });
  }
  return out;
}

/** Найти имя внутри итогового текста по шаблону «префикс{name}суффикс» */
export function extractName(template: string, text: string): string | null {
  const i = template.indexOf('{name}');
  if (i < 0) return null;
  const pre = template.slice(0, i), post = template.slice(i + 6);
  if (!text.startsWith(pre) || !text.endsWith(post)) return null;
  const n = text.slice(pre.length, text.length - post.length).trim();
  return n || null;
}

interface Prepared { buf: AudioBuffer; cues: MouthCue[]; offset: number }

const LRU_MAX = 48;

export class VoicePlayer {
  readonly lip = new LipSync();
  /** для debug-панели: persona → id → {text} */
  manifest: VoiceManifest = {};
  index: VoiceIndex | null = null;
  private personas = new Map<string, Promise<PersonaVoice | null>>();
  private loaded = new Map<string, PersonaVoice>();
  private byText = new Map<string, { persona: string; id: string }>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private legacy: Record<string, Record<string, LegacyEntry>> = {};
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private synthVoice: SpeechSynthesisVoice | null = null;
  private gen = 0;
  speaking = false;
  muted = false;
  /** что сейчас звучит: 'file' | 'synth' | 'echo' */
  mode: 'file' | 'synth' | 'echo' | null = null;
  /** стратегия липсинка для записей: ?lips=amp — по амплитуде */
  lipStrategy: LipStrategy = 'phon';
  /** колбэк начала/конца любой речи кота (VoiceEngine глушит микрофон) */
  onSpeaking: (on: boolean) => void = () => {};
  /** последняя реплика: откуда звук (для debug) */
  last: { id?: string; source: string; text: string } | null = null;

  constructor(private audio: Audio) {
    if (typeof speechSynthesis !== 'undefined') {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.synthVoice = vs.find((v) => v.lang === 'ru-RU' && /Milena|Милена|Yuri|Google/i.test(v.name)) ?? vs.find((v) => v.lang.startsWith('ru')) ?? null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('lips') === 'amp') this.lipStrategy = 'amp';
  }

  get ctx(): AudioContext | null {
    return this.audio.ctx;
  }

  /** Индекс озвучки (маленький). legacyUrl — старый манифест voice:build, если нового нет. */
  async load(legacyUrl?: string) {
    try {
      const r = await fetch(asset('voice/manifest.json'), { cache: 'no-cache' });
      if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) this.index = await r.json();
    } catch {
      /* нет озвучки — синтез */
    }
    if (!this.index && legacyUrl) {
      try {
        const r = await fetch(asset(legacyUrl));
        if (r.ok) this.legacy = await r.json();
        for (const [p, lines] of Object.entries(this.legacy)) {
          this.manifest[p] = {};
          for (const [id, e] of Object.entries(lines)) {
            this.byText.set(`${p}:${normText(e.text)}`, { persona: p, id });
            this.manifest[p][id] = { text: e.text };
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** Подгрузить манифест характера (лениво; повторные вызовы бесплатны) */
  usePersona(persona: string): Promise<PersonaVoice | null> {
    if (!this.index?.personas[persona]) return Promise.resolve(null);
    if (!this.personas.has(persona)) {
      this.personas.set(persona, (async () => {
        try {
          const r = await fetch(asset(`voice/${this.index!.personas[persona].manifest}`));
          if (!r.ok) return null;
          const m = (await r.json()) as PersonaVoice;
          this.loaded.set(persona, m);
          this.manifest[persona] = {};
          for (const [id, e] of Object.entries(m.lines)) {
            this.byText.set(`${persona}:${normText(e.t ?? '')}`, { persona, id });
            this.manifest[persona][id] = { text: e.t ?? '' };
          }
          for (const [id, p] of Object.entries(m.parts)) {
            if (p.t) this.byText.set(`${persona}:${normText(p.t)}`, { persona, id });
            this.manifest[persona][id] = { text: p.t ?? '' };
          }
          return m;
        } catch {
          return null;
        }
      })());
    }
    return this.personas.get(persona)!;
  }

  /** есть ли запись этой реплики (после usePersona) */
  has(persona: string, template: string, lineId?: string) {
    return !!this.lookup(persona, template, lineId);
  }

  private lookup(persona: string, template: string, lineId?: string): { kind: 'line'; e: ClipEntry; id: string } | { kind: 'parts'; id: string; a?: ClipEntry; b?: ClipEntry } | { kind: 'legacy'; e: LegacyEntry; id: string } | null {
    const m = this.loaded.get(persona);
    let id = lineId;
    if (!id || !(m?.lines[id] || m?.parts[id] || this.legacy[persona]?.[id])) id = this.byText.get(`${persona}:${normText(template)}`)?.id;
    if (!id) return null;
    if (m?.lines[id]) return { kind: 'line', e: m.lines[id], id };
    if (m?.parts[id]) return { kind: 'parts', id, a: m.parts[id].a, b: m.parts[id].b };
    const le = this.legacy[persona]?.[id];
    return le ? { kind: 'legacy', e: le, id } : null;
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
    this.gain = null;
    this.end();
  }

  /** Перебили: реплика затухает за ms и останавливается (очередь не трогаем — это делает DialogQueue) */
  fadeOut(ms = 120) {
    const ctx = this.audio.ctx;
    if (this.src && this.gain && ctx) {
      const g = this.gain.gain, t = ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + ms / 1000);
      const s = this.src;
      this.gen++;
      setTimeout(() => {
        try {
          s.stop();
        } catch {
          /* ignore */
        }
      }, ms + 10);
      this.src = null;
      this.gain = null;
      this.end();
      return;
    }
    this.cancel();
  }

  private end() {
    const was = this.speaking;
    this.speaking = false;
    this.mode = null;
    this.lip.stop();
    this.audio.duck(false, 'voice');
    if (was) this.onSpeaking(false);
  }

  // ───────────── загрузка звука ─────────────

  private fetchBuffer(path: string): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(path);
    if (hit) {
      this.buffers.delete(path); // LRU: в конец
      this.buffers.set(path, hit);
      return hit;
    }
    const p = (async () => {
      const ctx = this.audio.ctx;
      if (!ctx) return null;
      try {
        const data = await fetch(asset(path)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))));
        return await ctx.decodeAudioData(data);
      } catch {
        return null;
      }
    })();
    this.buffers.set(path, p);
    while (this.buffers.size > LRU_MAX) this.buffers.delete(this.buffers.keys().next().value!);
    void p.then((b) => b || this.buffers.delete(path));
    return p;
  }

  private clip(e: ClipEntry) {
    return this.fetchBuffer(`voice/${e.f}`);
  }

  /** где в декодированном буфере реально начинается звук (MP3-декодеры по-разному отрезают задержку) */
  private onsetShift(buf: AudioBuffer, e: ClipEntry) {
    const x = buf.getChannelData(0);
    const step = Math.round(buf.sampleRate * 0.01);
    let mx = 0;
    const rms: number[] = [];
    for (let i = 0; i + step <= Math.min(x.length, buf.sampleRate * 1.5); i += step) {
      let s = 0;
      for (let j = i; j < i + step; j++) s += x[j] * x[j];
      const r = Math.sqrt(s / step);
      rms.push(r);
      mx = Math.max(mx, r);
    }
    const k = rms.findIndex((r) => r > mx * 0.1);
    const actual = k < 0 ? e.o : k * 0.01;
    return Math.min(0.12, Math.max(0, actual - e.o));
  }

  private cuesFor(buf: AudioBuffer, e: ClipEntry): MouthCue[] {
    if (this.lipStrategy === 'amp') {
      const f = frames(buf.getChannelData(0), buf.sampleRate);
      return cuesFromAmplitude(f, buf.duration);
    }
    return unpackCues(e.c, e.d);
  }

  /** Склейка a + имя + b в один буфер; cues — со смещениями */
  private async splice(persona: string, a: ClipEntry | undefined, name: ClipEntry, b: ClipEntry | undefined): Promise<Prepared | null> {
    const ctx = this.audio.ctx;
    if (!ctx) return null;
    const list = [a, name, b].filter(Boolean) as ClipEntry[];
    const bufs = await Promise.all(list.map((e) => this.clip(e)));
    if (bufs.some((x) => !x)) return null;
    const gap = Math.round(0.04 * bufs[0]!.sampleRate);
    const sr = bufs[0]!.sampleRate;
    const segs = bufs.map((x, i) => {
      const s = this.onsetShift(x!, list[i]);
      return { x: x!, s: Math.round(s * sr) };
    });
    const len = segs.reduce((n, g) => n + g.x.length - g.s, 0) + gap * (segs.length - 1);
    const out = ctx.createBuffer(1, len, sr);
    const d = out.getChannelData(0);
    const cues: MouthCue[] = [];
    let at = 0;
    segs.forEach((g, i) => {
      d.set(g.x.getChannelData(0).subarray(g.s), at);
      const t0 = at / sr;
      for (const c of this.cuesFor(g.x, list[i])) cues.push({ start: t0 + c.start, end: t0 + c.end, value: c.value });
      at += g.x.length - g.s + gap;
    });
    void persona;
    return { buf: out, cues, offset: 0 };
  }

  private async prepare(req: SpeakRequest): Promise<Prepared | null> {
    await this.usePersona(req.persona);
    const f = this.lookup(req.persona, req.template, req.lineId);
    if (!f) return null;
    if (f.kind === 'line') {
      const buf = await this.clip(f.e);
      return buf ? { buf, cues: this.cuesFor(buf, f.e), offset: this.lipStrategy === 'amp' ? 0 : this.onsetShift(buf, f.e) } : null;
    }
    if (f.kind === 'parts') {
      const nm = extractName(req.template, req.text);
      const m = this.loaded.get(req.persona);
      const ne = nm ? m?.names[Object.keys(m.names).find((k) => normName(k) === normName(nm)) ?? ''] : undefined;
      if (!ne) return null; // имени нет в словаре — синтез
      return this.splice(req.persona, f.a, ne, f.b);
    }
    // старый формат
    const e = f.e;
    for (const s of e.src) {
      const buf = await this.fetchBuffer(s);
      if (!buf) continue;
      let cues: MouthCue[] | null = null;
      if (e.cues) cues = await fetch(asset(e.cues)).then((r) => r.json()).then((j) => j.mouthCues as MouthCue[]).catch(() => null);
      return { buf, cues: cues ?? cuesFromAmplitude(frames(buf.getChannelData(0), buf.sampleRate), buf.duration), offset: 0 };
    }
    return null;
  }

  /** предзагрузка реплики (буфер декодируется заранее) */
  preload(persona: string, template: string, lineId?: string) {
    void this.usePersona(persona).then(() => {
      const f = this.lookup(persona, template, lineId);
      if (f?.kind === 'line') void this.clip(f.e);
      if (f?.kind === 'parts') [f.a, f.b].forEach((e) => e && void this.clip(e));
    });
  }

  /** предзагрузка ближайших событий: по max штук на событие (id реплик вида persona.event.NN) */
  preloadEvents(persona: string, events: string[], max = 2) {
    void this.usePersona(persona).then((m) => {
      if (!m) return;
      for (const ev of events) {
        const ids = Object.keys(m.lines).filter((id) => id.split('.')[1] === ev).slice(0, max);
        ids.forEach((id) => void this.clip(m.lines[id]));
      }
    });
  }

  // ───────────── перебивание: пауза перед следующей репликой ─────────────
  private holdUntil = 0;
  private holdWaiters: (() => void)[] = [];
  /** ребёнок говорит: новые реплики ждут release() (но не дольше ms). Очередь (её приоритеты) не трогаем. */
  hold(ms = 8000) {
    this.holdUntil = performance.now() + ms;
    setTimeout(() => performance.now() >= this.holdUntil - 5 && this.release(), ms);
  }
  release() {
    this.holdUntil = 0;
    const w = this.holdWaiters;
    this.holdWaiters = [];
    w.forEach((f) => f());
  }
  get held() {
    return performance.now() < this.holdUntil;
  }

  // ───────────── повтор ─────────────
  /** источник готовой записи для повтора (VoiceEngine): забирает буфер, повторно не отдаёт */
  echoSource: (() => AudioBuffer | null) | null = null;
  /** конец проигрыша повтора (VoiceEngine снова слушает) */
  onEchoDone: () => void = () => {};
  /**
   * Повтор фразы ребёнка (director.echo): если есть запись — играем её (тон/темп уже сдвинуты),
   * иначе (чип/текст без записи) — синтез текста выше тоном.
   */
  async echo(text: string, o: { persona: string; pitchSemitones: number; rate: number }): Promise<void> {
    const buf = this.echoSource?.() ?? null;
    if (buf) {
      try {
        await this.playBuffer(buf);
      } finally {
        buf.getChannelData(0).fill(0); // запись не храним
        this.onEchoDone();
      }
      return;
    }
    if (!text || text === '…') return;
    await this.speak({ persona: o.persona, template: `echo:${text}`, text, pitch: Math.min(2, Math.max(0.5, Math.pow(2, o.pitchSemitones / 12))), rate: o.rate });
  }

  async speak(req: SpeakRequest): Promise<void> {
    this.cancel();
    const gen = this.gen;
    if (this.held) await new Promise<void>((r) => this.holdWaiters.push(r));
    if (gen !== this.gen || this.muted) return;
    const prep = await this.prepare(req).catch(() => null);
    if (gen !== this.gen) return;
    const ctx = this.audio.ctx;
    const out = this.audio.voiceOut();
    if (prep && ctx && out) {
      this.last = { id: req.lineId, source: this.lipStrategy === 'amp' ? 'file+amp' : 'file', text: req.text };
      return this.playPrepared(ctx, out, prep, gen, 'file');
    }
    this.last = { id: req.lineId, source: 'synth', text: req.text };
    return this.synth(req, gen);
  }

  /** Сыграть готовый буфер (повтор «эхо»): рот — по амплитуде, cues считаются здесь же */
  playBuffer(buf: AudioBuffer, cues?: MouthCue[]): Promise<void> {
    this.cancel();
    const gen = this.gen;
    const ctx = this.audio.ctx, out = this.audio.voiceOut();
    if (!ctx || !out || this.muted) return Promise.resolve();
    const c = cues ?? cuesFromAmplitude(frames(buf.getChannelData(0), buf.sampleRate), buf.duration);
    return this.playPrepared(ctx, out, { buf, cues: c, offset: 0 }, gen, 'echo');
  }

  private playPrepared(ctx: AudioContext, out: AudioNode, p: Prepared, gen: number, mode: 'file' | 'echo') {
    return new Promise<void>((resolve) => {
      const s = ctx.createBufferSource();
      s.buffer = p.buf;
      const g = ctx.createGain();
      s.connect(g);
      g.connect(out);
      this.src = s;
      this.gain = g;
      this.speaking = true;
      this.mode = mode;
      this.audio.duck(true, 'voice');
      this.onSpeaking(true);
      const startAt = ctx.currentTime + 0.01;
      // часы cues идут от вызова playCues; звук начнётся через delay (+ задержка декодера MP3)
      const delay = startAt - ctx.currentTime + p.offset;
      this.lip.playCues(delay ? p.cues.map((c) => ({ start: c.start + delay, end: c.end + delay, value: c.value })) : p.cues, () => ctx.currentTime);
      s.onended = () => {
        if (gen === this.gen) {
          this.src = null;
          this.gain = null;
          this.end();
        }
        resolve();
      };
      s.start(startAt);
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
        if (gen !== this.gen || this.speaking) return;
        this.speaking = true;
        this.mode = 'synth';
        this.audio.duck(true, 'voice');
        this.onSpeaking(true);
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
