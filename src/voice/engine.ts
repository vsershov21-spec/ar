/**
 * VoiceEngine — «уши» кота: микрофон, распознавание, режимы, повтор, громкость, перебивание.
 * Связь с режиссёром — только событиями и колбэками (связывает app.ts):
 *
 *   text  {text, match, source} — ребёнок сказал/нажал чип → director.text(text)
 *   event {id, data}            — loud / whisper / clap → director.interaction(id);
 *                                 echo_start / echo_done / echo_stop / barge_in / listen_timeout — для лога и debug
 *   clip  {name}                — кот играет клип (echo_speak во время повтора)
 *   state                       — для UI/debug
 *
 * Director → engine:
 *   listenFor(ms, mode)  — окно ответа (DirectorDeps.listen). mode 'echo' — режим повтора (запись без ASR).
 *   stopListen()         — закрыть окно (DirectorDeps.stopListen)
 *   listen({windowMs, expect, expectName}) — то же объектом (для своих сценариев)
 *
 * Режимы микрофона:
 *   'ptt'  (по умолчанию) — «держи и говори» (pttDown/pttUp); нажал, пока кот говорит, — перебил.
 *          Окна ответа director открывает сам (кот спросил → слушаем 5 с).
 *   'auto' («слушаю всегда», по умолчанию с 17.11; ?mic=ptt — по кнопке) — микрофон открыт постоянно:
 *          ребёнок заговорил (VAD) — распознаём фразу целиком (с началом из кольца 400 мс), замолчал — отдаём текст;
 *          голосом можно перебить кота; после реплики-вопроса — окно ответа.
 * Кот не слушает себя: пока он говорит (и 250 мс после), распознавание/VAD/повтор не получают звук.
 * Перебивание: реплика затухает за 120 мс, новые реплики ждут (VoicePlayer.hold), очередь со своими
 * приоритетами остаётся как была; отпускаем, когда пришёл ответ или ребёнок замолчал.
 */
import { Emitter } from '../core/emitter';
import type { Audio } from '../audio/audio';
import type { VoicePlayer } from './voicePlayer';
import { MicInput, type MicEvent } from './mic';
import { makeAsr, VoskAsr, type Asr, type AsrState } from './asr';
import { EchoMode, type EchoPreset } from './echo';
import { SoundEvents, Vad, db } from './vad';
import { answerWords, grammarPhrases, intentContext, isNameLead, matchIntent, setIntentContext, type IntentMatch } from './intents';
import { classifyUtterance, type ListenReason } from './utterance';
import { turn } from './turn';

export type MicMode = 'ptt' | 'auto';
export type VoiceEventId = 'echo_start' | 'echo_done' | 'echo_stop' | 'loud' | 'whisper' | 'clap' | 'barge_in' | 'listen_timeout'
  /** офлайн-модели нет (health-проверка, загрузка не удалась): один раз за сессию — «Голос пока не работает» */
  | 'asr_down'
  /** доступ к микрофону запрещён: один раз за сессию */
  | 'mic_denied';

/** голосовой вход доступен: распознавание (модель) и микрофон — для режиссёра (не предлагать голосовые занятия) */
export interface VoiceAvailability { asr: boolean; mic: boolean }

export type EngineEvents = {
  text: { text: string; match: IntentMatch; source: 'asr' | 'chip' | 'api' | 'echo' };
  interim: string;
  event: { id: VoiceEventId; data?: Record<string, unknown> };
  clip: { name: string };
  state: EngineState;
};

export interface EngineState {
  mode: MicMode;
  asr: string;
  asrState: AsrState;
  listening: boolean;
  listenReason: 'ptt' | 'window' | 'barge' | 'vad' | null;
  level: number;
  floorDb: number;
  modelProgress: number;
  echo: EchoMode['phase'];
  catSpeaking: boolean;
  lastText: string;
  lastIntent: string;
  lastConfidence: number;
  lastEvent: string;
  question: boolean;
  micError: string | null;
  /** здоровье офлайн-модели (asr.ts ModelHealth) */
  asrHealth: string;
  micDenied: boolean;
}

export interface ListenOpts {
  windowMs?: number;
  /** ожидаемые интенты ('yes','no'…) — бонус уверенности */
  expect?: string[];
  expectName?: boolean;
  /** 'echo' — режим повтора */
  mode?: string;
}

const SELF_MUTE_TAIL_MS = 250;
/** окно имени: конец фразы — после такой паузы (VAD сам ждёт 400 мс тишины, остальное — здесь): «Меня зовут… Маша» */
export const NAME_END_PAUSE_MS = 1100;
/** уверенность Vosk в слове-имени ниже порога — переспрашиваем «Тебя зовут X?» */
export const NAME_WORD_CONF = 0.6;
/** окно ответа после реплики-вопроса в «слушаю всегда» (ребёнку 6–13 лет нужно время подумать) */
export const QUESTION_WINDOW_MS = 8000;
/** ребёнок заговорил — новые реплики кота ждут (release — когда фраза разобрана) */
const USER_HOLD_MS = 5000;
/** заглушка текста для сценария: «ребёнок что-то сказал» в режиме повтора (распознавания нет) */
export const ECHO_HEARD = '…';

export class VoiceEngine extends Emitter<EngineEvents> {
  readonly mic: MicInput;
  readonly asr: Asr;
  readonly echo: EchoMode;
  private sound: SoundEvents;
  private vad: Vad;
  mode: MicMode = 'ptt';
  private catSpeaking = false;
  private muteUntil = 0;
  private listening = false;
  private listenReason: EngineState['listenReason'] = null;
  private windowTimer = 0;
  private echoStopTimer = 0;
  /** окно повтора открыто сценарием (между фразами сценарий его закрывает — тогда не пишем) */
  private echoWindow = false;
  private bargeMs = 0;
  private ring: Float32Array[] = [];
  private ringLen = 0;
  private autoMicHeld = false;
  /** текущая фраза: почему слушали, сколько длился голос (VAD), — для classifyUtterance */
  private utter = { reason: null as ListenReason, speechMs: 0 };
  private lastUnknownAt = -1e9;
  /** энергия: в окне ответа звук идёт в распознаватель, только пока в микрофоне есть голос (до этой отметки, мс) */
  private voiceUntil = 0;
  private readonly asrGate = () => this.vad.speaking || performance.now() < this.voiceUntil;
  /** окно имени: таймер конца фразы (NAME_END_PAUSE_MS) */
  private nameEndTimer = 0;
  /** «Тебя зовут X?» — ждём «да»/«нет» или другое имя */
  private nameCandidate: string | null = null;
  private asrDownFired = false;
  private st = { asrState: 'idle' as AsrState, modelProgress: 0, lastText: '', lastIntent: '', lastConfidence: 0, lastEvent: '' };
  /** пресет повтора текущего характера (app.ts: из persona.voice) */
  echoPreset: () => EchoPreset = () => ({ echoPitchSemitones: 5, echoRate: 1.05 });

  constructor(private audio: Audio, private voice: VoicePlayer, opts: { asr?: string | null; mode?: string | null; grammar?: boolean } = {}) {
    super();
    this.mic = new MicInput(audio);
    this.asr = makeAsr(opts.asr ?? null, this.mic);
    if (opts.grammar !== false) this.asr.setGrammar?.(grammarPhrases());
    this.sound = new SoundEvents(this.mic.floor);
    this.vad = new Vad(this.mic.floor);
    this.echo = new EchoMode(this.mic, voice, () => this.echoPreset());
    this.echo.gated = () => this.selfMuted || (this.echo.delivery === 'deferred' && !this.echoWindow);
    if (this.asr instanceof VoskAsr) {
      const a = this.asr;
      this.echo.checkStop = (pcm, sr, g) => (a.ready ? a.recognizeOnce(pcm, sr, g) : Promise.resolve(null));
      this.echo.canCheck = () => a.ready;
    }
    this.echo.onFiltered = (why) => {
      this.st.lastEvent = why === 'bad' ? 'повтор: грубое слово — не повторяю' : 'повтор: модели нет — длинную фразу не повторяю';
      this.pushState();
    };
    this.echo.onEvent = (e) => {
      switch (e.id) {
        case 'echo_speaking':
          this.emit('clip', { name: e.clip });
          return;
        case 'echo_ready':
          if (!this.echoWindow) return this.echo.discard();
          // запись готова → сценарию «ребёнок сказал» (распознавания нет — это повтор)
          this.echoWindow = false;
          this.emit('text', { text: ECHO_HEARD, match: { intent: 'unknown', confidence: 1, text: ECHO_HEARD }, source: 'echo' });
          return;
        case 'echo_stopword':
          this.handleText(e.text, 'echo');
          return;
        case 'echo_listening':
          return;
        case 'echo_start':
        case 'echo_stop':
          this.audio.duck(e.id === 'echo_start', 'mic');
          break;
      }
      this.fire(e.id, 'count' in e ? { count: e.count } : 'reason' in e ? { reason: e.reason } : undefined);
    };
    // проигрыш повтора через сценарий: VoicePlayer.echo() забирает готовую запись
    voice.echoSource = () => {
      const b = this.echo.take();
      if (b) this.emit('clip', { name: 'echo_speak' });
      return b;
    };
    voice.onEchoDone = () => {
      this.echo.played();
      this.fire('echo_done', { count: this.echo.count });
    };
    voice.onSpeaking = (on) => this.onCatSpeaking(on);
    // есть ли готовая запись повтора: без неё ветка «*» повторялки молчит (director: нет «мой голос круче» без повтора)
    voice.echoReady = () => this.echo.phase === 'ready';
    this.mic.onDenied = (why) => {
      if (this.echo.active) this.echo.stop('api');
      this.fire('mic_denied', { why });
    };
    this.asr.onResult = (t) => this.onAsrResult(t);
    this.asr.onInterim = (t) => this.emit('interim', t);
    this.asr.onState = (s, m) => {
      this.st.asrState = s;
      if (s === 'idle' || s === 'error') {
        this.listening = false;
        this.listenReason = null;
        // повторялка слушает сама (EchoMode) — её приглушение снимет echo_stop, а не конец фразы распознавания
        if (!this.echo.active) this.audio.duck(false, 'mic');
        turn.userEnd();
        // ребёнок замолчал — коту можно продолжать
        setTimeout(() => !this.listening && this.voice.release(), 400);
      }
      if (s === 'error') this.st.lastEvent = `asr: ${m}`;
      // модели нет — один раз за сессию (вторая попытка — тихо, по MODEL_RETRY_MS)
      if (s === 'error' && /no-model/.test(m ?? '') && !this.asrDownFired) {
        this.asrDownFired = true;
        this.fire('asr_down', { why: m, health: this.asr.health });
      }
      this.pushState();
    };
    this.asr.onProgress = (p) => {
      this.st.modelProgress = p;
      this.pushState();
    };
    this.mic.on((c) => this.onAudio(c));
    if (opts.mode === 'auto') this.setMode('auto');
    // iOS: после звонка/сворачивания дорожка микрофона закрыта — «слушаю всегда» открывает её снова
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.mode === 'auto' && this.autoMicHeld && !this.mic.isOpen)
          setTimeout(() => void this.mic.ensureOpen().then(() => this.pushState()), 300);
      });
    if (typeof window !== 'undefined') (window as any).__voice = this.api();
  }

  /** голосовой вход: распознавание (модель есть или ещё может загрузиться) и микрофон (доступ не запрещён) */
  get available(): VoiceAvailability {
    const h = this.asr.health;
    return { asr: !!this.asr.supported && h !== 'dead' && h !== 'down', mic: this.mic.supported && !this.mic.denied };
  }

  /** DirectorDeps.voiceIn: доступность голоса и готовность модели */
  voiceIn() {
    return { ...this.available, ready: !!this.asr.ready || this.asr.health === undefined };
  }

  /** DirectorDeps.whenAsrReady: модель в памяти — сразу true; нет/пауза перед повтором — false; иначе ждём ≤ ms */
  whenAsrReady(ms: number): Promise<boolean> {
    const a = this.asr;
    if (a.ready || a.health === undefined) return Promise.resolve(true); // Web Speech — без модели
    if (a.unavailable || a.health === 'dead' || !a.preload) return Promise.resolve(false);
    if (ms <= 0) return Promise.resolve(false);
    return Promise.race([a.preload(), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  }

  get selfMuted() {
    return this.catSpeaking || performance.now() < this.muteUntil;
  }

  // ───────────── push-to-talk ─────────────
  /** нажали микрофон. Если кот говорит — перебили. */
  pttDown() {
    if (this.echo.active) return; // в повторе микрофон и так слушает
    if (this.catSpeaking) this.bargeIn('ptt');
    this.startListening('ptt');
  }
  pttUp() {
    if (this.listenReason === 'ptt') this.asr.stop();
  }

  private startListening(reason: 'ptt' | 'window' | 'barge' | 'vad') {
    if (this.listening) {
      if (reason === 'ptt') this.listenReason = 'ptt';
      return;
    }
    // микрофон запрещён / модели нет (и повторять рано): не открываем — без повторных запросов доступа и загрузок 45 МБ
    if (this.mic.denied || this.asr.unavailable) {
      if (reason === 'ptt') this.emit('interim', this.mic.denied ? 'Нет доступа к микрофону — жми кнопки' : 'Голос пока не работает — жми кнопки');
      return;
    }
    this.listening = true;
    this.listenReason = reason;
    // VAD уже насчитал начало фразы (120 мс) до старта распознавания
    this.utter = { reason, speechMs: reason === 'vad' || reason === 'barge' ? this.vad.durMs : 0 };
    this.asr.paused = this.selfMuted;
    // окно ответа (кот спросил и ждёт до 8 с): тишину в Vosk не гоним — распознавание только с голосом
    this.asr.gate = reason === 'window' ? this.asrGate : null;
    this.audio.duck(true, 'mic');
    this.asr.start(reason === 'barge' || reason === 'vad' ? this.ring.slice() : undefined);
    this.pushState();
  }

  // ───────────── окно ответа (director) ─────────────
  /** DirectorDeps.listen(ms, mode): окно ответа ms; mode 'echo' — режим повтора */
  listenFor(ms: number, mode?: string) {
    this.listen({ windowMs: ms, mode });
  }

  listen(o: ListenOpts = {}) {
    const windowMs = o.windowMs ?? 5000;
    clearTimeout(this.windowTimer);
    if (o.mode === 'echo') {
      if (this.mic.denied) return; // без микрофона повторялки нет (director её и не запускает)
      clearTimeout(this.echoStopTimer);
      this.echoWindow = true;
      if (this.listening) this.asr.abort();
      void this.echo.start('deferred');
      void this.asr.preload?.(); // для стоп-слов «хватит»
      this.pushState();
      return;
    }
    if (this.echo.active) this.echo.stop('api');
    // контекст ответа — сразу (кот ещё договаривает вопрос): «да» в паузе между репликами — ответ, а не шум
    this.expect(o.mode, windowMs, o.expect, o.expectName);
    const open = () => {
      this.expect(o.mode, windowMs, o.expect, o.expectName);
      this.startListening('window');
      this.windowTimer = window.setTimeout(() => {
        if (this.listenReason === 'window') {
          this.asr.stop();
          this.fire('listen_timeout');
        }
      }, windowMs);
    };
    const wait = () => (this.selfMuted ? (this.windowTimer = window.setTimeout(wait, 60)) : open());
    wait();
  }

  /**
   * Диалог ждёт ответа (вход в узел с listen, ещё до того, как кот договорил — DirectorDeps.expect): короткие
   * «да», «нет», «сдаюсь», ответы загадок с этой минуты — ответ, а не шум. Окно микрофона откроет listen() после реплики.
   */
  expect(mode?: string, windowMs = 8000, expect?: string[], expectName?: boolean) {
    if (mode === 'echo') return;
    const name = expectName ?? mode === 'name';
    const answers = mode && mode !== 'intent' && mode !== 'name' ? answerWords() : undefined;
    setIntentContext({ question: true, expect, expectName: name, answers, until: performance.now() + windowMs + 30_000 });
  }

  /** DirectorDeps.stopListen */
  stopListen() {
    clearTimeout(this.windowTimer);
    clearTimeout(this.nameEndTimer);
    this.nameCandidate = null;
    this.echoWindow = false;
    if (this.listenReason === 'window' || this.listenReason === 'barge') this.asr.stop();
    // повтор: между фразами диалог закрывает и снова открывает окно — останавливаемся, только если за 6 с не открыл снова
    if (this.echo.active) {
      clearTimeout(this.echoStopTimer);
      this.echoStopTimer = window.setTimeout(() => this.echo.stop("api"), 6000);
    }
  }

  /** после жеста (iOS): режим «слушаю всегда» должен заново открыть микрофон — до жеста AudioContext спит */
  resumeAuto() {
    if (this.mode !== 'auto') return;
    if (this.autoMicHeld) this.mic.release();
    this.autoMicHeld = true;
    void this.mic.acquire();
  }

  setMode(m: MicMode) {
    this.mode = m;
    try {
      localStorage.setItem('ar.micMode', m);
    } catch {
      /* приватный режим */
    }
    if (m === 'auto' && !this.autoMicHeld) {
      this.autoMicHeld = true;
      void this.mic.acquire();
    } else if (m === 'ptt' && this.autoMicHeld) {
      this.autoMicHeld = false;
      this.mic.release();
    }
    this.pushState();
  }

  // ───────────── кот говорит ─────────────
  private onCatSpeaking(on: boolean) {
    this.catSpeaking = on;
    this.asr.paused = on || this.selfMuted;
    if (!on) {
      this.muteUntil = performance.now() + SELF_MUTE_TAIL_MS;
      setTimeout(() => (this.asr.paused = this.selfMuted), SELF_MUTE_TAIL_MS + 5);
      // «слушаю сам»: реплика кончилась вопросом — окно ответа (в 'ptt' окна открывает director)
      const t = this.voice.last?.text ?? '';
      const question = /\?\s*[»"]?\s*$/.test(t);
      if (question) turn.catQuestion();
      if (this.mode === 'auto' && !this.echo.active && question && !this.listening) this.listen({ windowMs: QUESTION_WINDOW_MS });
    }
    this.pushState();
  }

  /** ребёнок перебил: реплика затухает 120 мс, следующие ждут, пока он говорит */
  bargeIn(how: 'ptt' | 'voice' = 'voice') {
    this.voice.fadeOut(120);
    this.voice.hold(6000);
    this.catSpeaking = false;
    this.muteUntil = 0;
    this.asr.paused = false;
    this.fire('barge_in', { how });
  }

  // ───────────── звук микрофона ─────────────
  private onAudio(c: MicEvent) {
    const frames = c.list;
    // кольцо 400 мс (16 кГц, формат распознавателя) — начало фразы при перебивании; без копий: буфер ничей
    const buf = c.asr, sr = this.mic.asrRate;
    this.ring.push(buf);
    this.ringLen += buf.length;
    while (this.ring.length > 1 && this.ringLen - this.ring[0].length > sr * 0.4) this.ringLen -= this.ring.shift()!.length;
    for (const f of frames) {
      if (this.catSpeaking) {
        // голосом перебиваем только в 'auto' и не во время повтора (эхоподавление не идеально)
        if (this.mode === 'auto' && this.voice.mode !== 'echo' && db(f.rms) > this.mic.floor.floorDb + 22 && db(f.rms) > -40) {
          this.bargeMs += 10;
          if (this.bargeMs >= 200) {
            this.bargeMs = 0;
            this.bargeIn('voice');
            this.startListening('barge');
          }
        } else this.bargeMs = Math.max(0, this.bargeMs - 10);
        continue;
      }
      if (this.selfMuted) continue;
      // лёгкий порог для распознавания в окне ответа: ниже порога VAD (+6 дБ над шумом), чтобы тихое «да» не терялось
      const fd = db(f.rms);
      if (fd > this.mic.floor.floorDb + 6 && fd > -58) this.voiceUntil = performance.now() + 700;
      this.mic.floor.push(f, this.vad.speaking);
      const ev = this.vad.push(f);
      if (ev?.type === 'start' && !this.echo.active) {
        clearTimeout(this.nameEndTimer); // окно имени: ребёнок продолжил («меня зовут… Маша»)
        turn.userStart();
        // ребёнок заговорил — кот не начинает новую реплику, пока фраза не разобрана
        if (this.mode === 'auto' || this.listening) this.voice.hold(USER_HOLD_MS);
        // «слушаю всегда»: заговорили — сразу распознаём (начало фразы — из кольца)
        if (this.mode === 'auto' && !this.listening) this.startListening('vad');
      }
      if (ev?.type === 'end') {
        turn.userEnd();
        if (this.listening) this.utter.speechMs = Math.max(this.utter.speechMs, ev.durMs);
        const w = this.sound.phraseEnded(ev.durMs, this.vad.stats);
        if (w && !this.echo.active) this.fire('whisper', { meanDb: +(this.vad.stats.sumDb / Math.max(1, this.vad.stats.n)).toFixed(1) });
        if (this.listenReason === 'window' && intentContext().expectName) {
          // окно имени: пауза конца фразы длиннее (дети делают паузу перед именем)
          clearTimeout(this.nameEndTimer);
          this.nameEndTimer = window.setTimeout(() => this.listenReason === 'window' && !this.vad.speaking && this.asr.stop(), NAME_END_PAUSE_MS - this.vad.opts.endSilenceMs);
        } else if (this.listenReason === 'window' || this.listenReason === 'barge' || this.listenReason === 'vad') this.asr.stop(); // фраза кончилась — не ждём таймаута
      }
      const s = this.sound.push(f);
      // в повторе громкость — часть игры (кот повторит и крик), хлопки/шёпот не отвлекают; в окне ответа — без хлопков
      // тап пальцем по телефону микрофон слышит как хлопок — сразу после касания «хлопки» не считаем
      const tapNoise = s === 'clap' && performance.now() - turn.get().lastTouchAt < 1000;
      if (s && !this.echo.active && !tapNoise && !(this.listening && s === 'clap')) this.fire(s, { db: +db(f.rms).toFixed(1) });
    }
  }

  // ───────────── текст ─────────────
  /**
   * Результат распознавания → ответ кота. Каждая настоящая фраза получает ответ (команда или «не понял»),
   * шум и обрывки — нет (правила — utterance.ts). Важно: Vosk сообщает «idle» раньше результата, поэтому
   * причина слушания берётся из this.utter, а не из listenReason (тот уже сброшен).
   */
  private onAsrResult(t: string) {
    const now = performance.now();
    const unk = this.asr.lastUnk ?? 0;
    const v = classifyUtterance({ text: t, unk, speechMs: this.utter.speechMs, reason: this.utter.reason, ctx: intentContext(), now, lastUnknownAt: this.lastUnknownAt });
    this.st.lastText = t || (unk ? '[unk]' : '');
    if (v.kind === 'noise') {
      this.st.lastIntent = `ignored:${v.why}`;
      this.st.lastEvent = `шум/обрывок (${v.why}, голос ${Math.round(this.utter.speechMs)} мс)`;
      if (this.utter.reason === 'ptt' || this.utter.reason === 'window') this.emit('interim', 'Не расслышал — скажи ещё раз');
      this.pushState();
      setTimeout(() => !this.listening && this.voice.release(), 50);
      return;
    }
    if (v.kind === 'unknown') this.lastUnknownAt = now;
    if (this.nameStep(t, v.match)) return;
    // слова вне словаря: в подсказке «…», затем честно — «слышу, но не разобрал»
    this.handleText(t || ECHO_HEARD, 'asr');
    if (!t) this.emit('interim', 'Слышу тебя, но слова не разобрал');
  }

  /**
   * Окно имени (кот спросил «Как тебя зовут?»):
   *  - «меня зовут» / «я» / «это» без имени — слушаем дальше (ребёнок задумался);
   *  - одно слово не из словаря имён или слово, в котором Vosk не уверен, — переспрашиваем «Тебя зовут X?»
   *    (подсказкой), «да» — имя, «нет» — слушаем заново.
   * true — фраза обработана здесь (режиссёру не уходит).
   */
  private nameStep(t: string, m: IntentMatch): boolean {
    const ctx = intentContext();
    if (!ctx.expectName) {
      this.nameCandidate = null;
      return false;
    }
    const reopen = (hint: string) => {
      this.emit('interim', hint);
      this.voice.hold(USER_HOLD_MS);
      // окно ещё открыто (таймер окна идёт) — продолжаем слушать
      setTimeout(() => !this.listening && intentContext().expectName && this.startListening('window'), 0);
      this.pushState();
      return true;
    };
    const cand = this.nameCandidate;
    if (cand) {
      this.nameCandidate = null;
      if (m.intent === 'yes') {
        this.handleText(`меня зовут ${cand}`, 'asr');
        return true;
      }
      if (m.intent === 'no') return reopen('Скажи ещё раз, как тебя зовут');
    }
    if (isNameLead(t)) {
      this.st.lastEvent = 'имя: жду продолжения';
      return reopen('Слушаю…');
    }
    const lowConf = m.intent === 'name' && !!m.name && (this.asr.wordConf?.(m.name) ?? 1) < NAME_WORD_CONF;
    const ask = m.confirmName ?? (lowConf ? m.name : undefined);
    if (ask) {
      this.nameCandidate = ask;
      this.st.lastEvent = `имя: переспрашиваю ${ask}`;
      return reopen(`Тебя зовут ${ask}? Скажи «да» или «нет»`);
    }
    return false;
  }

  /** распознанный текст или чип → событие text (app → director.text) */
  handleText(text: string, source: 'asr' | 'chip' | 'api' | 'echo' = 'api') {
    const ctx = intentContext();
    const match = matchIntent(text, ctx);
    this.st.lastText = text;
    this.st.lastIntent = match.intent === 'name' ? `name:${match.name}` : match.intent;
    this.st.lastConfidence = +match.confidence.toFixed(2);
    this.voice.release();
    // «хватит» в повторялке — сразу тишина: не пишем и не повторяем, пока сценарий отвечает (раньше — через 6 с)
    if (match.intent === 'echo_stop' && this.echo.active) this.echo.stop('intent');
    this.emit('text', { text, match, source });
    if (ctx.question && source !== 'echo') setIntentContext({});
    this.pushState();
  }

  private fire(id: VoiceEventId, data?: Record<string, unknown>) {
    this.st.lastEvent = data ? `${id} ${JSON.stringify(data)}` : id;
    this.emit('event', { id, data });
    this.pushState();
  }

  state(): EngineState {
    return {
      mode: this.mode, asr: this.asr.name, asrState: this.st.asrState, listening: this.listening, listenReason: this.listenReason,
      level: this.mic.level, floorDb: +this.mic.floor.floorDb.toFixed(1), modelProgress: this.st.modelProgress, echo: this.echo.phase,
      catSpeaking: this.catSpeaking, lastText: this.st.lastText, lastIntent: this.st.lastIntent, lastConfidence: this.st.lastConfidence,
      lastEvent: this.st.lastEvent, question: !!intentContext().question, micError: this.mic.error,
      asrHealth: this.asr.health ?? 'ok', micDenied: this.mic.denied,
    };
  }

  private pushState() {
    this.emit('state', this.state());
  }

  /** window.__voice — для debug, скриншотов и проверки на устройстве */
  api() {
    return {
      engine: this,
      state: () => this.state(),
      /** как будто ребёнок сказал */
      text: (t: string) => this.handleText(t, 'api'),
      listen: (o?: ListenOpts) => this.listen(o),
      mode: (m: MicMode) => this.setMode(m),
      /** повтор без сценария: кот сам повторяет каждую фразу */
      echo: { start: () => this.echo.start('direct'), stop: () => this.echo.stop('api') },
      ptt: { down: () => this.pttDown(), up: () => this.pttUp() },
      preloadModel: () => this.asr.preload?.(),
      available: () => this.available,
      thresholds: { vad: this.vad.opts, sound: this.sound.opts },
      lips: (s: 'phon' | 'amp') => (this.voice.lipStrategy = s),
      /** звуковой стек на устройстве: контекст, аудиосессия, узел микрофона, кэш реплик */
      audio: () => {
        const ctx = this.audio.ctx;
        return {
          ctx: ctx ? { state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: (ctx as AudioContext & { outputLatency?: number }).outputLatency } : null,
          session: this.audio.sessionType, micOpen: this.mic.isOpen, micNode: this.mic.nodeKind, micError: this.mic.error,
          voiceCache: this.voice.cacheStats(), synth: this.voice.synthAllowed,
        };
      },
    };
  }
}
