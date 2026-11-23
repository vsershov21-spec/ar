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
 * В проде на сайте полная озвучка ElevenLabs (voice/el/manifest.json) — тогда Piper-индекс и манифесты характеров
 * НЕ грузятся, а speechSynthesis не трогается вовсе (ни unlock в жесте, ни getVoices, ни cancel: на iOS синтез
 * поднимает свою аудиосессию). Для отладки: ?piper — Piper-записи как запасной голос, ?synth — синтез браузера.
 * Кэш декодированных реплик — LRU по объёму (VOICE_CACHE_BYTES, 8 МБ ≈ 45 с звука 48 кГц), предзагрузка —
 * по одному декодированию, реплика «сейчас» — без очереди. Плюс кэш сжатых mp3 (RAW_CACHE_BYTES, 6 МБ ≈
 * 250 реплик): warmEvents() качает все варианты реплик ближайших действий заранее, а декодирует только самые вероятные —
 * реплика «сейчас» тогда стоит одно декодирование (десятки мс), а не сеть (iPhone 20.11: «озвучка запаздывает»).
 * Синхронность: speak(req, { onStart }) зовёт onStart в момент, когда звук реально пошёл (с задержкой вывода) —
 * режиссёр показывает пузырь и «говорящий» клип по нему, а не до сети и декодирования. timings — разбор задержек.
 *
 *
 * Устойчивость (iPhone 22.11, показ в офисе: «со звуком опять проблемы — зависал и не грузился»): любой звук ограничен по
 * времени — не начал играть за VOICE_START_TIMEOUT_MS (сеть, декодирование, спящий контекст iOS) → пузырь без звука на
 * длину реплики, сценарий идёт дальше; запрос mp3 и decodeAudioData — с таймаутами; контекст встал во время реплики
 * (currentTime не идёт) — остаток молча, а не вечное ожидание onended. Фоновая докачка — после посадки кота
 * (holdBackground), только текущего кота, по одному варианту каждого события сначала, на медленной сети — 1 запрос и
 * только первые варианты, пока идёт реплика «сейчас» — пауза; декодирование заранее — по одному и только при живом
 * контексте. 404 записи (манифест старше файлов после пересборки) — манифест перечитывается. Причины задержек и
 * немых реплик — в аналитику (voice_issue: причина и миллисекунды, без текста и имени).
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
import { track } from '../analytics';

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
  /** реплики со слотом: префикс a + значение слота + суффикс b */
  parts: Record<string, { t?: string; slot?: string; a?: ClipEntry; b?: ClipEntry }>;
  /** значения слотов: name — имена (names.ru.txt), answer — ответы загадок */
  slots?: Record<string, Record<string, ClipEntry>>;
  /** старое поле (= slots.name) */
  names?: Record<string, ClipEntry>;
}
export interface VoiceIndex {
  version: number;
  codec?: string;
  lipsync?: string;
  personas: Record<string, { manifest: string; lines: number; names: number; answers?: number; templates: number }>;
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

/** Найти значение слота внутри итогового текста по шаблону «префикс{slot}суффикс» */
export function extractName(template: string, text: string, slot = 'name'): string | null {
  const key = `{${slot}}`;
  const i = template.indexOf(key);
  if (i < 0) return null;
  const pre = template.slice(0, i), post = template.slice(i + key.length);
  if (!text.startsWith(pre) || !text.endsWith(post)) return null;
  const n = text.slice(pre.length, text.length - post.length).trim();
  return n || null;
}

interface Prepared { buf: AudioBuffer; cues: MouthCue[]; offset: number }
/** запись ElevenLabs (voice/el/manifest.json, собирает scripts/voice/pull-server-voice.mjs) */
type ElEntry = ClipEntry & { kind?: 'line' | 'part' | 'slot'; line?: string; part?: 'a' | 'b'; slot?: string; v?: string };
type ElHit = { kind: 'line'; e: ElEntry } | { kind: 'parts'; a?: ElEntry; b?: ElEntry; v: ElEntry };
const SLOT_RE = /\{(name|answer)\}/;

/** кэш декодированных реплик: объём (декодируется в частоту контекста: 3 с ≈ 0,58 МБ) и число записей; на iPhone память
 *  нужна и коту (текстуры, движения) — 8 МБ, а не 12 */
export const VOICE_CACHE_BYTES = 8 * 1024 * 1024;
const LRU_MAX = 64;
/** кэш сжатых mp3 (байты как пришли из сети): ~25 КБ на реплику — все варианты ближайших действий */
export const RAW_CACHE_BYTES = 6 * 1024 * 1024;
/** фоновых запросов сжатых записей одновременно (медленная сеть — 1) */
const RAW_PARALLEL = 2;
/** звук не начался за столько мс от speak (после hold) — пузырь без звука, сценарий не ждёт */
export const VOICE_START_TIMEOUT_MS = 1200;
/** запрос mp3: реплика «сейчас» (докачивается и после немого пузыря — в кэш на следующий раз) и фоновый */
export const FETCH_NOW_TIMEOUT_MS = 6000;
const FETCH_BG_TIMEOUT_MS = 10_000;
/** decodeAudioData (iOS при «interrupted» контексте может не ответить вовсе) */
export const DECODE_TIMEOUT_MS = 3000;
/** через столько после старта буфера проверяем, что часы контекста идут (иначе onended не придёт никогда) */
export const STALL_CHECK_MS = 700;
/** запрос дольше — сеть медленная: фон по одному запросу и только первые варианты реплик */
const SLOW_FETCH_MS = 1500;
/** реплика началась позже — в аналитику (voice_issue reason=late) */
const VOICE_LATE_MS = 800;
/** не больше стольких voice_issue за сессию */
const ISSUE_MAX = 30;
/** контекст звука не «running» (iOS: interrupted после камеры/микрофона) — ждём resume не дольше */
const RESUME_WAIT_MS = 250;
/** конец реплики → приглушение sfx/фона снимается не сразу: следующая реплика подряд не «качает» громкость */
const DUCK_RELEASE_MS = 300;

/** разбор задержки одной реплики (мс от вызова speak): для стенда и debug-панели */
export interface VoiceTiming {
  id?: string;
  /** performance.now() вызова speak */
  t0: number;
  /** ожидание hold (ребёнок говорит) */
  holdMs: number;
  /** готовность буфера: 0 — был в кэше декодированным */
  prepMs: number;
  /** из них: сеть (0 — сжатый был в кэше) и декодирование */
  fetchMs: number;
  decodeMs: number;
  /** ожидание resume() контекста */
  resumeMs: number;
  /** от вызова speak до слышимого звука (с учётом задержки вывода); немая реплика — до пузыря */
  startMs: number;
  /** ok — звук пошёл; silent — пузырь без звука (reason) */
  outcome?: 'ok' | 'silent';
  /** почему без звука / поздно: net_slow, net_timeout, net_error, http_404, decode_slow, decode_timeout, decode_error, ctx_interrupted, ctx_suspended, ctx_stalled, no_audio */
  reason?: string;
  /** буфер был готов (декодирован) к моменту speak */
  warm: boolean;
  source: string;
}
/** одновременно декодируемых предзагрузок */
const PRELOAD_PARALLEL = 1;
const qflag = (k: string) => typeof location !== 'undefined' && new URLSearchParams(location.search).has(k);

interface BufEntry { p: Promise<AudioBuffer | null>; bytes: number; dead?: boolean; buf?: AudioBuffer | null; fetchMs?: number; decodeMs?: number }
interface RawEntry { p: Promise<ArrayBuffer | null>; bytes: number; ok?: boolean }
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** промис или null через ms (onTimeout — причина в телеметрию) */
function within<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T | null> {
  let t = 0 as unknown as ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<null>((r) => {
      t = setTimeout(() => (onTimeout?.(), r(null)), ms);
    }),
  ]);
}
/** фоновая докачка: путь и номер варианта события (сначала первые варианты всех событий) */
interface BgItem { path: string; k: number }

export class VoicePlayer {
  readonly lip = new LipSync();
  /** для debug-панели: persona → id → {text} */
  manifest: VoiceManifest = {};
  index: VoiceIndex | null = null;
  private personas = new Map<string, Promise<PersonaVoice | null>>();
  private loaded = new Map<string, PersonaVoice>();
  private byText = new Map<string, { persona: string; id: string }>();
  private buffers = new Map<string, BufEntry>();
  private cacheBytes = 0;
  private raw = new Map<string, RawEntry>();
  private rawBytes = 0;
  private duckTimer = 0;
  /** speak(req, { onStart }) зовёт onStart в момент слышимого старта (режиссёр: пузырь — по нему) */
  readonly startHook = true;
  /** последние реплики: из чего сложилась задержка (стенд scripts/bench/voice-latency.mjs, debug) */
  readonly timings: VoiceTiming[] = [];
  onTiming: ((t: VoiceTiming) => void) | null = null;
  private inflight = 0;
  private waiting = new Map<string, () => void>();
  private onsets = new WeakMap<AudioBuffer, number>();
  /** ?piper — Piper-записи как запасной голос при озвучке ElevenLabs */
  private piperFlag = qflag('piper');
  /** ?synth — синтез браузера (speechSynthesis) при озвучке ElevenLabs */
  private synthFlag = qflag('synth');
  private synthUsed = false;
  private synthPicked = false;
  private legacy: Record<string, Record<string, LegacyEntry>> = {};
  /** озвучка ElevenLabs: id → файл; приоритет выше Piper. kind: line | part (кусок реплики со слотом) | slot (имя, ответ) */
  private el: Record<string, ElEntry> = {};
  private elByText = new Map<string, string>();
  /** реплики со слотом: id → шаблон и какие куски есть (a — до слота, b — после) */
  private elTemplates: Record<string, { t: string; slot: string; parts: string[] }> = {};
  /** значения слотов: «persona:slot» → норм. значение → запись */
  private elSlots = new Map<string, Map<string, ElEntry>>();
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
  private lastSource = 'piper';
  /** последняя реплика: откуда звук (для debug) */
  last: { id?: string; source: string; text: string } | null = null;

  constructor(private audio: Audio) {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('lips') === 'amp') this.lipStrategy = 'amp';
  }

  get ctx(): AudioContext | null {
    return this.audio.ctx;
  }

  /** синтез браузера разрешён: озвучки ElevenLabs нет (локально) или ?synth */
  get synthAllowed(): boolean {
    return typeof speechSynthesis !== 'undefined' && (!this.hasRecordings || this.synthFlag);
  }

  /** голоса синтеза — лениво, при первом синтезе (не в конструкторе: getVoices на iOS будит движок синтеза) */
  private pickSynthVoice() {
    if (this.synthPicked || typeof speechSynthesis === 'undefined') return;
    this.synthPicked = true;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.synthVoice = vs.find((v) => v.lang === 'ru-RU' && /Milena|Милена|Yuri|Google/i.test(v.name)) ?? vs.find((v) => v.lang.startsWith('ru')) ?? null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  }

  /** Индекс озвучки (маленький). legacyUrl — старый манифест voice:build, если нового нет. */
  /** манифест ElevenLabs (no-cache: после пересборки — новые хэши файлов); true — прочитан */
  private async loadEl(): Promise<boolean> {
    try {
      const r = await fetch(asset('voice/el/manifest.json'), { cache: 'no-cache' });
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return false;
      const man = await r.json();
      const el: Record<string, ElEntry> = man.lines ?? {};
      const byText = new Map<string, string>(), slots = new Map<string, Map<string, ElEntry>>();
      for (const [id, e] of Object.entries(el)) {
        const persona = id.split('.')[0];
        if (e.kind === 'slot' && e.slot && e.v) {
          const k = `${persona}:${e.slot}`;
          if (!slots.has(k)) slots.set(k, new Map());
          slots.get(k)!.set(normName(e.v), e);
        } else if ((e.kind ?? 'line') === 'line' && e.t) byText.set(`${persona}:${normText(e.t)}`, id);
      }
      this.el = el;
      this.elTemplates = man.templates ?? {};
      this.elByText = byText;
      this.elSlots = slots;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Запись ElevenLabs ответила 404: вкладка открыта до пересборки (файлы с новыми хэшами, старых уже нет) — перечитать
   * манифест (не чаще раза в 30 с). Промис — пока перечитывается.
   */
  private elRefresh: Promise<boolean> | null = null;
  private elRefreshAt = -1e9;
  private manifestStale(path: string) {
    if (!path.startsWith('voice/el/') || performance.now() - this.elRefreshAt < 30_000) return;
    this.elRefreshAt = performance.now();
    this.elRefresh = this.loadEl();
  }

  async load(legacyUrl?: string) {
    await this.loadEl(); // нет — только Piper
    // озвучка ElevenLabs есть — Piper не нужен (не качаем ни индекс, ни манифесты, ни mp3); ?piper — для отладки
    if (this.hasRecordings && !this.piperFlag) return;
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

  /** основная озвучка (ElevenLabs) на сайте есть — иначе «неозвученность» не проверяем (локально, без озвучки — синтез) */
  /**
   * Есть ли на сайте живая озвучка. Раньше — Object.keys(this.el) (1600+ ключей) на каждый вызов, а зовут его на каждую
   * реплику-кандидата (строгий режим, hasVoiced для чипов кота 3 раза в секунду): в профиле QA-стенда — 5 с главного потока
   * за 14 мин (CPU ×4). Теперь — один раз на манифест.
   */
  private elChecked: object | null = null;
  private elAny = false;
  get hasRecordings(): boolean {
    if (this.elChecked !== this.el) {
      this.elChecked = this.el;
      this.elAny = false;
      for (const _ in this.el) {
        this.elAny = true;
        break;
      }
    }
    return this.elAny;
  }

  /**
   * Реплика прозвучит записью целиком (ElevenLabs, а если манифест характера уже загружен — Piper), а не синтезом.
   * template — текст со слотом, text — с подставленным именем/ответом. Синхронно: для выбора варианта реплики.
   */
  recorded(persona: string, lineId: string | undefined, template: string, text = template): boolean {
    const req = { persona, lineId, template, text, pitch: 1, rate: 1 };
    if (this.elFor(req)) return true;
    if (!this.loaded.has(persona)) return false;
    const f = this.lookup(persona, template, lineId);
    if (!f) return false;
    if (f.kind !== 'parts') return true;
    const val = extractName(template, text, f.slot);
    const m = this.loaded.get(persona);
    const dict = m?.slots?.[f.slot] ?? (f.slot === 'name' ? m?.names : undefined) ?? {};
    return !!val && Object.keys(dict).some((k) => normName(k) === normName(val));
  }

  /** есть ли запись ElevenLabs (живой голос) — Piper/синтез не в счёт */
  elRecorded(persona: string, lineId: string | undefined, template: string, text = template): boolean {
    return !!this.elFor({ persona, lineId, template, text, pitch: 1, rate: 1 });
  }

  /** есть ли запись этой реплики (после usePersona) */
  has(persona: string, template: string, lineId?: string) {
    return !!this.lookup(persona, template, lineId);
  }

  private lookup(persona: string, template: string, lineId?: string): { kind: 'line'; e: ClipEntry; id: string } | { kind: 'parts'; id: string; slot: string; a?: ClipEntry; b?: ClipEntry } | { kind: 'legacy'; e: LegacyEntry; id: string } | null {
    const m = this.loaded.get(persona);
    let id = lineId;
    // запись по id, только если её текст совпадает с репликой (текст правили, а озвучку ещё не пересобрали — не она)
    const stale = (t?: string) => !!t && normText(t) !== normText(template);
    if (id && (stale(m?.lines[id]?.t) || stale(m?.parts[id]?.t))) id = undefined;
    if (!id || !(m?.lines[id] || m?.parts[id] || this.legacy[persona]?.[id])) id = this.byText.get(`${persona}:${normText(template)}`)?.id;
    if (!id) return null;
    if (m?.lines[id]) return { kind: 'line', e: m.lines[id], id };
    if (m?.parts[id]) return { kind: 'parts', id, slot: m.parts[id].slot ?? 'name', a: m.parts[id].a, b: m.parts[id].b };
    const le = this.legacy[persona]?.[id];
    return le ? { kind: 'legacy', e: le, id } : null;
  }

  /** iOS: первый вызов speechSynthesis — из жеста (только если синтез вообще возможен) */
  unlock() {
    if (!this.synthAllowed) return;
    this.pickSynthVoice();
    this.synthUsed = true;
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
    // реплика, ждавшая hold (ребёнок говорил), — снята: её speak выходит сразу, а не через 8 с (очередь не висит)
    if (this.holdWaiters.length) {
      const w = this.holdWaiters;
      this.holdWaiters = [];
      w.forEach((f) => f());
    }
    // ничего не звучит — ни остановок, ни end() (раньше очередь и speak гасили дважды: приглушение фона «качалось»)
    if (!this.speaking && !this.src) return;
    if (this.synthUsed)
      try {
        speechSynthesis.cancel();
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
    // следующая реплика подряд (перебили реакцией) — приглушение держится, без «качелей» громкости фона
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => !this.speaking && this.audio.duck(false, 'voice'), DUCK_RELEASE_MS) as unknown as number;
    if (was) this.onSpeaking(false);
  }
  private duckOn() {
    clearTimeout(this.duckTimer);
    this.audio.duck(true, 'voice');
  }

  // ───────────── загрузка звука ─────────────

  /**
   * Декодированная реплика из кэша / сети. low — предзагрузка: в очередь (не больше PRELOAD_PARALLEL
   * декодирований сразу); реплика «сейчас» идёт без очереди и поднимает свою же предзагрузку из очереди.
   */
  private fetchBuffer(path: string, low = false): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(path);
    if (hit) {
      this.buffers.delete(path); // LRU: в конец
      this.buffers.set(path, hit);
      if (!low) this.promote(path);
      return hit.p;
    }
    const entry: BufEntry = { p: Promise.resolve(null), bytes: 0 };
    const gate = low && this.inflight >= PRELOAD_PARALLEL ? new Promise<void>((r) => this.waiting.set(path, r)) : null;
    entry.p = (async () => {
      if (gate) await gate;
      if (entry.dead) return null;
      const ctx = this.audio.ctx;
      if (!ctx) return null;
      this.inflight++;
      try {
        const t0 = performance.now();
        const had = !!this.raw.get(path)?.ok;
        const data = await this.fetchRaw(path, low);
        if (!data) return null;
        // заранее декодируем только при живом контексте (iOS: «interrupted» — decodeAudioData может не ответить);
        // сжатый остаётся в кэше — декодируется по требованию
        if (low && ctx.state !== 'running') return null;
        const t1 = performance.now();
        // decodeAudioData отдаёт (detach) свой ArrayBuffer — сжатый остаётся в кэше копией
        let decErr = false;
        const buf = await within(
          ctx.decodeAudioData(data.slice(0)).catch(() => ((decErr = true), null)),
          DECODE_TIMEOUT_MS,
          () => this.fail(path, 'decode_timeout'),
        );
        if (decErr) this.fail(path, 'decode_error');
        if (!buf) return null;
        entry.fetchMs = had ? 0 : t1 - t0;
        entry.decodeMs = performance.now() - t1;
        entry.buf = buf;
        if (!entry.dead && this.buffers.get(path) === entry) {
          entry.bytes = buf.length * buf.numberOfChannels * 4;
          this.cacheBytes += entry.bytes;
          this.evict();
        }
        return buf;
      } catch {
        return null;
      } finally {
        this.inflight--;
        this.next();
      }
    })();
    this.buffers.set(path, entry);
    this.evict();
    void entry.p.then((b) => {
      if (!b && this.buffers.get(path) === entry) this.drop(path);
    });
    return entry.p;
  }

  /** фоновая докачка сжатых: не больше RAW_PARALLEL запросов сразу (реплика «сейчас» идёт мимо очереди) */
  private rawQueue: BgItem[] = [];
  private rawInflight = 0;
  /** фон закрыт до посадки кота (holdBackground): сеть и процессор — коту, трекеру и модели распознавания */
  private bgHeld = false;
  /** реплик «сейчас» в подготовке — фон ждёт */
  private nowBusy = 0;
  /** сеть медленная (последний запрос дольше SLOW_FETCH_MS) */
  private slowNet = false;
  /** фон: чей кот и сколько байт уже скачано для него (не больше RAW_CACHE_BYTES — больше кэш не удержит) */
  private bgPersona = '';
  private bgBytes = 0;
  /**
   * Придержать фоновую докачку (true) или отпустить (false). Приложение держит её до посадки кота: на старте сеть
   * нужна модели кота, движениям и распознаванию; реплики первых шагов (decode) идут и без фона.
   */
  holdBackground(on: boolean) {
    this.bgHeld = on;
    if (!on) this.pumpRaw();
  }
  private prefetchRaw(path: string, k = 0) {
    if (this.raw.has(path) || this.buffers.has(path) || this.rawQueue.some((q) => q.path === path)) return;
    // сначала первые варианты всех событий, потом вторые… (на медленной сети до дальних может и не дойти)
    let i = this.rawQueue.length;
    while (i > 0 && this.rawQueue[i - 1].k > k) i--;
    this.rawQueue.splice(i, 0, { path, k });
    this.pumpRaw();
  }
  private pumpRaw() {
    if (this.bgHeld || this.nowBusy > 0) return;
    const par = this.slowNet ? 1 : RAW_PARALLEL;
    while (this.rawInflight < par && this.rawQueue.length) {
      if (this.bgBytes >= RAW_CACHE_BYTES) return void (this.rawQueue = []);
      const it = this.rawQueue.shift()!;
      if (this.raw.has(it.path) || this.buffers.has(it.path)) continue;
      if (this.slowNet && it.k >= 2) continue; // медленная сеть: только первые два варианта
      this.rawInflight++;
      void this.fetchRaw(it.path, true).then((b) => {
        if (b) this.bgBytes += b.byteLength;
      }).finally(() => {
        this.rawInflight--;
        // медленная сеть — между фоновыми запросами пауза (полоса — реплике «сейчас» и коту)
        if (this.slowNet) setTimeout(() => this.pumpRaw(), 400);
        else this.pumpRaw();
      });
    }
  }
  /** смена кота: фон — только для нового (очередь прежнего и его ждущие декодирования — прочь) */
  private bgFor(persona: string) {
    if (persona === this.bgPersona) return;
    this.bgPersona = persona;
    this.bgBytes = 0;
    this.rawQueue = [];
    for (const path of [...this.waiting.keys()]) this.drop(path);
  }

  /** последняя неудача записи: путь → причина (для телеметрии немой реплики) */
  private fails = new Map<string, string>();
  private fail(path: string, reason: string) {
    this.fails.delete(path);
    this.fails.set(path, reason);
    if (this.fails.size > 64) this.fails.delete(this.fails.keys().next().value!);
  }

  /** сжатый mp3 из кэша / сети (LRU по объёму RAW_CACHE_BYTES); запрос — с таймаутом (обрывается) */
  private fetchRaw(path: string, low = false): Promise<ArrayBuffer | null> {
    const hit = this.raw.get(path);
    if (hit) {
      this.raw.delete(path);
      this.raw.set(path, hit);
      return hit.p;
    }
    const e: RawEntry = { p: Promise.resolve(null), bytes: 0 };
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t0 = performance.now();
    let settled = false;
    const why = (r: string) => {
      if (!settled) this.fail(path, r);
      settled = true;
    };
    const req = fetch(asset(path), ac ? { signal: ac.signal } : undefined)
      .then((r) => {
        if (r.ok) return r.arrayBuffer();
        why(`http_${r.status}`);
        if (r.status === 404) this.manifestStale(path);
        return null;
      })
      .catch(() => (why('net_error'), null));
    e.p = within(req, low ? FETCH_BG_TIMEOUT_MS : FETCH_NOW_TIMEOUT_MS, () => {
      why('net_timeout');
      ac?.abort();
    })
      .catch(() => null)
      .then((b) => {
        settled = true;
        const ms = performance.now() - t0;
        if (b) this.slowNet = ms > SLOW_FETCH_MS;
        else if (ms > SLOW_FETCH_MS) this.slowNet = true;
        if (!b) {
          if (this.raw.get(path) === e) this.raw.delete(path);
          return null;
        }
        e.ok = true;
        if (this.raw.get(path) === e) {
          e.bytes = b.byteLength;
          this.rawBytes += e.bytes;
          while (this.raw.size > 1 && this.rawBytes > RAW_CACHE_BYTES) {
            const k = this.raw.keys().next().value!;
            this.rawBytes -= this.raw.get(k)!.bytes;
            this.raw.delete(k);
          }
        }
        return b;
      });
    this.raw.set(path, e);
    return e.p;
  }

  private promote(path: string) {
    const r = this.waiting.get(path);
    if (r) {
      this.waiting.delete(path);
      r();
    }
  }

  private next() {
    while (this.inflight < PRELOAD_PARALLEL && this.waiting.size) this.promote(this.waiting.keys().next().value!);
  }

  private drop(path: string) {
    const e = this.buffers.get(path);
    if (!e) return;
    this.buffers.delete(path);
    this.cacheBytes -= e.bytes;
    e.dead = true;
    // ждала в очереди — отпускаем (выйдет сразу, ничего не декодируя)
    this.promote(path);
  }

  /** LRU: самые давние — вон, пока не уложимся в объём и число (последнюю запись не трогаем) */
  private evict() {
    while (this.buffers.size > 1 && (this.cacheBytes > VOICE_CACHE_BYTES || this.buffers.size > LRU_MAX)) this.drop(this.buffers.keys().next().value!);
  }

  /** для debug/стенда: сколько декодированного звука держим */
  cacheStats() {
    return { entries: this.buffers.size, mb: +(this.cacheBytes / 1048576).toFixed(2), rawEntries: this.raw.size, rawMb: +(this.rawBytes / 1048576).toFixed(2), inflight: this.inflight, queued: this.waiting.size };
  }

  private clip(e: ClipEntry, low = false) {
    return this.fetchBuffer(`voice/${e.f}`, low);
  }

  /** где в декодированном буфере реально начинается звук (MP3-декодеры по-разному отрезают задержку) */
  private onsetShift(buf: AudioBuffer, e: ClipEntry) {
    const c = this.onsets.get(buf);
    if (c !== undefined) return c;
    const v = this.measureOnset(buf, e);
    this.onsets.set(buf, v);
    return v;
  }

  private measureOnset(buf: AudioBuffer, e: ClipEntry) {
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

  /** приоритет: ElevenLabs → Piper → speechSynthesis. Запись берём, только если её текст = текст реплики. */
  private elFor(req: SpeakRequest): ElHit | null {
    const tpl = normText(req.template);
    const m = req.template.match(SLOT_RE);
    if (!m) {
      let id = req.lineId && this.el[req.lineId] && (this.el[req.lineId].kind ?? 'line') === 'line' ? req.lineId : undefined;
      if (id && this.el[id].t && normText(this.el[id].t!) !== tpl) id = undefined;
      id ??= this.elByText.get(`${req.persona}:${tpl}`);
      return id ? { kind: 'line', e: this.el[id] } : null;
    }
    // реплика со слотом: кусок до + значение (имя / ответ) + кусок после
    const T = req.lineId ? this.elTemplates[req.lineId] : undefined;
    if (!T || normText(T.t) !== tpl) return null;
    const val = extractName(req.template, req.text, T.slot);
    const v = val ? this.elSlots.get(`${req.persona}:${T.slot}`)?.get(normName(val)) : undefined;
    if (!v) return null;
    const a = this.el[`${req.lineId}~a`], b = this.el[`${req.lineId}~b`];
    if ((T.parts.includes('a') && !a) || (T.parts.includes('b') && !b)) return null;
    return { kind: 'parts', a, b, v };
  }

  private async prepare(req: SpeakRequest): Promise<Prepared | null> {
    let el = this.elFor(req);
    if (el?.kind === 'line') {
      let buf = await this.clip(el.e);
      // 404: манифест старше файлов (пересборка при открытой вкладке) — перечитали; у реплики новый файл — он
      if (!buf && this.elRefresh && (await within(this.elRefresh, 2000))) {
        const again = this.elFor(req);
        if (again?.kind === 'line' && again.e.f !== el.e.f) {
          el = again;
          buf = await this.clip(again.e);
        }
      }
      if (buf && el?.kind === 'line') {
        this.lastSource = 'elevenlabs';
        return { buf, cues: this.cuesFor(buf, el.e), offset: this.lipStrategy === 'amp' ? 0 : this.onsetShift(buf, el.e) };
      }
    } else if (el?.kind === 'parts') {
      const p = await this.splice(req.persona, el.a, el.v, el.b);
      if (p) {
        this.lastSource = 'elevenlabs';
        return p;
      }
    }
    this.lastSource = 'piper';
    await this.usePersona(req.persona);
    const f = this.lookup(req.persona, req.template, req.lineId);
    if (!f) return null;
    if (f.kind === 'line') {
      const buf = await this.clip(f.e);
      return buf ? { buf, cues: this.cuesFor(buf, f.e), offset: this.lipStrategy === 'amp' ? 0 : this.onsetShift(buf, f.e) } : null;
    }
    if (f.kind === 'parts') {
      const val = extractName(req.template, req.text, f.slot);
      const m = this.loaded.get(req.persona);
      const dict = m?.slots?.[f.slot] ?? (f.slot === 'name' ? m?.names : undefined) ?? {};
      const ne = val ? dict[Object.keys(dict).find((k) => normName(k) === normName(val)) ?? ''] : undefined;
      if (!ne) return null; // значения нет в словаре — синтез всей фразы
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
      const el = this.elFor({ persona, template, text: template, pitch: 1, rate: 1, lineId });
      if (el?.kind === 'line') return void this.clip(el.e, true);
      if (el?.kind === 'parts') return void [el.a, el.v, el.b].forEach((e) => e && void this.clip(e, true));
      if (f?.kind === 'line') void this.clip(f.e, true);
      if (f?.kind === 'parts') [f.a, f.b].forEach((e) => e && void this.clip(e, true));
    });
  }

  /** предзагрузка ближайших событий: по max штук на событие (id реплик вида persona.event.NN) */
  preloadEvents(persona: string, events: string[], max = 2) {
    this.warmEvents(persona, events, { fetch: max, decode: max });
  }

  /** записи ElevenLabs (реплики целиком) характера по событию: persona → event → id (строится один раз на манифест) */
  private elByEvent: { of: object; m: Map<string, Map<string, string[]>> } | null = null;
  private elEventIds(persona: string, ev: string): string[] {
    if (this.elByEvent?.of !== this.el) {
      const m = new Map<string, Map<string, string[]>>();
      for (const [id, e] of Object.entries(this.el)) {
        if ((e.kind ?? 'line') !== 'line') continue;
        const [p, evt] = id.split('.');
        if (!m.has(p)) m.set(p, new Map());
        const pm = m.get(p)!;
        if (!pm.has(evt)) pm.set(evt, []);
        pm.get(evt)!.push(id);
      }
      for (const pm of m.values()) for (const ids of pm.values()) ids.sort();
      this.elByEvent = { of: this.el, m };
    }
    return this.elByEvent.m.get(persona)?.get(ev) ?? [];
  }

  /**
   * Прогрев реплик ближайших действий: все варианты события (до fetch штук) — сжатыми в кэш, первые decode — сразу
   * декодированными (реплика «сейчас» без сети; самые вероятные — и без декодирования). Повторный вызов бесплатен.
   */
  warmEvents(persona: string, events: string[], o: { fetch?: number; decode?: number } = {}) {
    const nf = o.fetch ?? 6, nd = o.decode ?? 1;
    this.bgFor(persona);
    const go = (m: PersonaVoice | null) => {
      if (persona !== this.bgPersona) return; // пока грузился манифест характера — кота сменили
      for (const ev of events) {
        const el = this.elEventIds(persona, ev).map((id) => this.el[id]);
        const piper = el.length ? [] : Object.keys(m?.lines ?? {}).filter((id) => id.split('.')[1] === ev).sort().map((id) => m!.lines[id]);
        [...el, ...piper].slice(0, Math.max(nf, nd)).forEach((e, i) => {
          if (i < nd) void this.clip(e, true);
          else this.prefetchRaw(`voice/${e.f}`, i);
        });
      }
    };
    if (this.hasRecordings && !this.piperFlag) return go(null);
    void this.usePersona(persona).then(go);
  }

  /** реплика уже декодирована (speak начнёт звук без ожидания) */
  isWarm(req: SpeakRequest): boolean {
    const el = this.elFor(req);
    const ok = (e?: ClipEntry) => !e || !!this.buffers.get(`voice/${e.f}`)?.buf;
    if (el?.kind === 'line') return ok(el.e);
    if (el?.kind === 'parts') return ok(el.a) && ok(el.v) && ok(el.b);
    return false;
  }

  /** подготовить реплику «сейчас» (сеть + декодирование без очереди предзагрузки); промис — когда готова */
  warmLine(req: SpeakRequest): Promise<void> {
    const el = this.elFor(req);
    const list = el?.kind === 'line' ? [el.e] : el?.kind === 'parts' ? [el.a, el.v, el.b] : [];
    return Promise.all(list.filter(Boolean).map((e) => this.clip(e!))).then(() => undefined);
  }

  /** сколько стоил буфер записи (последнее декодирование): сеть, декодирование */
  private costOf(req: SpeakRequest): { fetchMs: number; decodeMs: number } {
    const el = this.elFor(req);
    const list = el?.kind === 'line' ? [el.e] : el?.kind === 'parts' ? [el.a, el.v, el.b] : [];
    let fetchMs = 0, decodeMs = 0;
    for (const e of list) {
      const b = e && this.buffers.get(`voice/${e.f}`);
      if (b) (fetchMs = Math.max(fetchMs, b.fetchMs ?? 0)), (decodeMs += b.decodeMs ?? 0);
    }
    return { fetchMs, decodeMs };
  }

  private record(t: VoiceTiming) {
    this.timings.push(t);
    if (this.timings.length > 64) this.timings.shift();
    this.onTiming?.(t);
    if (t.outcome === 'silent' || t.startMs > VOICE_LATE_MS) this.issue(t);
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
  /** есть готовая запись повтора (VoiceEngine): без неё ветке «*» повторялки нечего повторять */
  echoReady: () => boolean = () => false;
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
    if (!text || text === '…' || !this.synthAllowed) return;
    await this.speak({ persona: o.persona, template: `echo:${text}`, text, pitch: Math.min(2, Math.max(0.5, Math.pow(2, o.pitchSemitones / 12))), rate: o.rate });
  }

  /**
   * Сказать реплику. hooks.onStart — в момент, когда звук реально пошёл (запись: старт буфера + задержка вывода;
   * синтез — onstart; без звука/без записи — сразу): по нему режиссёр показывает пузырь (пузырь = голос).
   */
  async speak(req: SpeakRequest, hooks: { onStart?: () => void } = {}): Promise<void> {
    this.cancel();
    const gen = this.gen;
    const t0 = performance.now();
    let started = false;
    const start = () => {
      if (started || gen !== this.gen) return;
      started = true;
      hooks.onStart?.();
    };
    if (this.held) await new Promise<void>((r) => this.holdWaiters.push(r));
    if (gen !== this.gen) return;
    const holdMs = performance.now() - t0;
    // звук выключен: реплика «звучит» молча столько же, сколько запись, — пузырь успевают прочитать.
    // Раньше speak возвращался сразу и пузырь гас через 250 мс (QA-стенд, docs/qa/BUGS.md)
    if (this.muted) {
      start();
      return await this.silentLine(req, gen);
    }
    const warm = this.isWarm(req);
    // живая запись есть — реплика не пропадает молча и не висит: не вышло со звуком — пузырь без звука
    const recorded = this.hasRecordings && !!this.elFor(req);
    const tp = performance.now();
    this.nowBusy++;
    const prepP = this.prepare(req)
      .catch(() => null)
      .finally(() => {
        this.nowBusy--;
        this.pumpRaw();
      });
    // звук не готов за VOICE_START_TIMEOUT_MS — не ждём (запись докачается в кэш на следующий раз)
    const res = await within(prepP.then((p) => ({ p })), VOICE_START_TIMEOUT_MS);
    if (gen !== this.gen) return;
    const prepMs = performance.now() - tp;
    const timing: VoiceTiming = { id: req.lineId, t0, holdMs, prepMs, fetchMs: 0, decodeMs: 0, resumeMs: 0, startMs: 0, warm, source: this.lastSource, outcome: 'ok' };
    if (!res) return await this.silentFallback(req, gen, start, timing, this.pendingReason(req));
    const prep = res.p;
    const ctx = this.audio.ctx;
    // iOS: контекст «interrupted»/«suspended» (камера, микрофон, звонок) — буфер стартует, а звука нет до resume
    if (prep && ctx && ctx.state !== 'running') {
      const tr = performance.now();
      await Promise.race([ctx.resume().catch(() => undefined), wait(RESUME_WAIT_MS)]);
      timing.resumeMs = performance.now() - tr;
      if (gen !== this.gen) return;
      // не проснулся (вне жеста iOS может не пустить) — пузырь без звука; будим дальше (касание, возврат на вкладку, таймер)
      if ((ctx.state as AudioContextState) !== 'running') {
        this.wakeLater();
        return await this.silentFallback(req, gen, start, timing, `ctx_${ctx.state}`);
      }
    }
    const out = this.audio.voiceOut();
    if (prep && ctx && out) {
      this.last = { id: req.lineId, source: `${this.lastSource}${this.lipStrategy === 'amp' ? '+amp' : ''}`, text: req.text };
      const { fetchMs, decodeMs } = warm ? { fetchMs: 0, decodeMs: 0 } : this.costOf(req);
      Object.assign(timing, { fetchMs, decodeMs, source: this.lastSource });
      return await this.playPrepared(
        ctx,
        out,
        prep,
        gen,
        'file',
        (leadMs) => {
          timing.startMs = performance.now() - t0 + leadMs;
          this.record(timing);
          if (leadMs > 12) setTimeout(start, leadMs);
          else start();
        },
        () => {
          // контекст встал посреди реплики: остаток — молча (пузырь уже на экране)
          this.wakeLater();
          this.issue({ ...timing, outcome: 'silent', reason: 'ctx_stalled' });
        },
      );
    }
    if (recorded) return await this.silentFallback(req, gen, start, timing, this.pendingReason(req, true));
    if (!this.synthAllowed) {
      // записи нет, синтез на сайте с живой озвучкой не используем — молчим
      this.last = { id: req.lineId, source: 'none', text: req.text };
      return;
    }
    this.last = { id: req.lineId, source: 'synth', text: req.text };
    return await this.synth(req, gen, start);
  }

  /** пузырь без звука на длину реплики (запись не успела / не скачалась / контекст спит) — сценарий идёт дальше */
  private async silentFallback(req: SpeakRequest, gen: number, start: () => void, timing: VoiceTiming, reason: string) {
    timing.outcome = 'silent';
    timing.reason = reason;
    timing.startMs = performance.now() - timing.t0;
    this.record(timing);
    start();
    await this.silentLine(req, gen, `silent:${reason}`);
  }

  /** почему реплика «сейчас» не готова: сеть ещё идёт / упала, декодирование — по записям реплики */
  private pendingReason(req: SpeakRequest, failed = false): string {
    const el = this.elFor(req);
    const list = (el?.kind === 'line' ? [el.e] : el?.kind === 'parts' ? [el.a, el.v, el.b] : []).filter(Boolean) as ClipEntry[];
    for (const e of list) {
      const path = `voice/${e.f}`;
      const f = this.fails.get(path);
      if (f) return f;
      if (this.buffers.get(path)?.buf) continue;
      const r = this.raw.get(path);
      if (r && !r.ok) return 'net_slow';
      if (r?.ok) return failed ? 'decode_error' : 'decode_slow';
    }
    return failed ? 'no_audio' : 'net_slow';
  }

  /** контекст не «running»: будим ещё (вне жеста — может и не выйти; касание будит в Audio) */
  private wakeTimer = 0;
  private wakeLater() {
    if (this.wakeTimer) return;
    let n = 0;
    const tick = () => {
      const ctx = this.audio.ctx;
      if (!ctx || ctx.state === 'running' || ++n > 5) return void (this.wakeTimer = 0);
      void ctx.resume?.().catch(() => undefined);
      this.wakeTimer = setTimeout(tick, 1500) as unknown as number;
    };
    this.wakeTimer = setTimeout(tick, 500) as unknown as number;
  }

  /** немые и поздние реплики — в аналитику: причина и мс (без текста, имени и id реплики — только событие) */
  private issues = 0;
  private issue(t: VoiceTiming) {
    if (this.issues >= ISSUE_MAX) return;
    this.issues++;
    const ev = t.id?.split('.')[1]?.replace(/@.*$/, '');
    track('voice_issue', { reason: t.reason ?? 'late', ms: t.startMs, net: t.fetchMs, dec: t.decodeMs, warm: t.warm ? 1 : 0, ev, ctx: this.audio.ctx?.state });
  }

  /** длина реплики, с: по записи (манифест), иначе — как живая речь (0,45 с + 1 с на 14 символов), не меньше 1,2 с */
  lineSeconds(req: SpeakRequest): number {
    const el = this.elFor(req);
    let d = 0;
    if (el?.kind === 'line') d = el.e.d ?? 0;
    else if (el?.kind === 'parts') d = (el.a?.d ?? 0) + (el.v?.d ?? 0) + (el.b?.d ?? 0);
    return Math.max(1.2, d || 0.45 + req.text.length / 14);
  }

  /** реплика без звука (кнопка «Без звука»): ждём её длину; cancel/новая реплика обрывают ожидание */
  private silentLine(req: SpeakRequest, gen: number, source = 'muted'): Promise<void> {
    this.last = { id: req.lineId, source, text: req.text };
    const end = Date.now() + this.lineSeconds(req) * 1000;
    return new Promise<void>((resolve) => {
      const tick = () => (gen !== this.gen || Date.now() >= end ? resolve() : setTimeout(tick, 100));
      tick();
    });
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

  private playPrepared(ctx: AudioContext, out: AudioNode, p: Prepared, gen: number, mode: 'file' | 'echo', onStart?: (leadMs: number) => void, onStall?: () => void) {
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
      this.duckOn();
      this.onSpeaking(true);
      const startAt = ctx.currentTime + 0.01;
      // часы cues идут от вызова playCues; звук начнётся через delay (+ задержка декодера MP3)
      const delay = startAt - ctx.currentTime + p.offset;
      this.lip.playCues(delay ? p.cues.map((c) => ({ start: c.start + delay, end: c.end + delay, value: c.value })) : p.cues, () => ctx.currentTime);
      const lenMs = (p.buf.duration + p.offset) * 1000;
      let done = false;
      let stallT = 0, guardT = 0;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(stallT);
        clearTimeout(guardT);
        // узлы реплики — из графа (иначе на iOS копятся подключёнными к выходу голоса)
        try {
          s.disconnect();
          g.disconnect();
        } catch {
          /* ignore */
        }
        if (gen === this.gen && this.src === s) {
          this.src = null;
          this.gain = null;
          this.end();
        }
        resolve();
      };
      s.onended = finish;
      // часы контекста стоят (iOS: interrupted/suspended посреди реплики, «running» без вывода) — onended не придёт
      // никогда: источник — прочь, остаток реплики — молча (пузырь читается), cancel обрывает ожидание
      const stallAt = performance.now();
      const ct0 = ctx.currentTime;
      stallT = setTimeout(() => {
        if (done || ctx.currentTime - ct0 > 0.05) return;
        try {
          s.stop();
        } catch {
          /* ignore */
        }
        if (gen === this.gen && this.src === s) {
          this.src = null;
          this.gain = null;
          this.end();
        }
        onStall?.();
        const end = stallAt + lenMs;
        const tick = () => (done ? undefined : gen !== this.gen || performance.now() >= end ? finish() : void setTimeout(tick, 100));
        tick();
      }, STALL_CHECK_MS) as unknown as number;
      // страховка: onended не пришёл и через 2 с после конца реплики — заканчиваем сами
      guardT = setTimeout(finish, lenMs + 2000) as unknown as number;
      s.start(startAt);
      // слышно через: до startAt + задержка декодера MP3 (offset) + задержка вывода (iOS — десятки мс)
      const outLat = Math.min(0.2, Math.max(0, (ctx as AudioContext & { outputLatency?: number }).outputLatency || ctx.baseLatency || 0));
      onStart?.(Math.max(0, (startAt - ctx.currentTime + p.offset + outLat) * 1000));
    });
  }

  private synth(req: SpeakRequest, gen: number, onStart?: () => void) {
    if (typeof speechSynthesis === 'undefined') return Promise.resolve();
    this.pickSynthVoice();
    this.synthUsed = true;
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
        this.duckOn();
        this.onSpeaking(true);
        this.lip.playCues(cuesFromText(req.text, estimateSpeechSec(req.text, req.rate)), () => performance.now() / 1000);
        onStart?.();
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
