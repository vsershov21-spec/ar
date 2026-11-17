/**
 * Director — «режиссёр»: принимает события (ввод, трекер, голос), прогоняет через автомат сценария
 * и исполняет команды: реплики, звуки, эффекты, клипы, интерфейс, таймеры, окна ответа микрофона.
 * Кто сейчас кот — знает только PersonaContext: реплики, голос, idle, трюк, наклейки берутся оттуда.
 */
import * as THREE from 'three';
import { Emitter } from './core/emitter';
import { initialState, makeScenarioConfig, step, type Action, type Heard, type ScenarioConfig, type ScenarioEvent, type ScenarioState, type InteractionKind } from './scenario/machine';
import { loadMemory, saveMemory } from './scenario/memory';
import { contextEvent } from './scenario/session';
import { answerMatches } from './scenario/intentMatch';
import { matchIntent } from './voice/intents';
import { turn } from './voice/turn';
import { InitiativeGate } from './scenario/initiative';
import { resolveTrigger, type ListenMode } from './scenario/dialogs';
import type { ContentBundle } from './persona/content';
import { PersonaContext } from './persona/context';
import { LineQueue } from './persona/lineQueue';
import type { PickedLine } from './persona/picker';
import type { ContentLine, FxName, PersonaId, Riddle } from './persona/types';
import { isPersonaId, PERSONA_IDS } from './persona/types';
import { runtimeClip, runtimeFx, runtimeSound } from './persona/runtimeMap';
import type { Character, Emote } from './character/types';
import type { Stage } from './stage';
import type { FxLayer } from './fx/fxLayer';
import type { Audio } from './audio/audio';
import type { VoicePlayer, SpeakRequest } from './voice/voicePlayer';
import type { UI } from './ui/ui';
import type { Tracker } from './tracker/types';
import { ASSETS } from './config';
import { rand } from './core/util';
import { emotionFor } from './character/emotions';
import { ACTION_ROUTE, SLEEP_WAKE_MS, isActionId, type ActionId } from './scenario/actions';

export type DirectorEvents = { log: string; phase: string; persona: PersonaId };

export interface DirectorDeps {
  tracker: Tracker;
  stage: Stage;
  fx: FxLayer;
  audio: Audio;
  voice: VoicePlayer;
  ui: UI;
  content: ContentBundle;
  glCanvas: HTMLCanvasElement;
  size: () => { w: number; h: number };
  /** открыть микрофон на ms (окно ответа после вопроса кота) */
  /** mode — какой ответ ждём ('echo' — режим повтора: VoiceEngine пишет звук без распознавания) */
  listen?: (ms: number, mode?: string) => void;
  stopListen?: () => void;
  /** заполняется сам: для старых вкладок debug, читающих d.personas */
  personas?: ContentBundle['personas'];
}

/** эмоции новых событий (знакомство, угощение), которых ещё нет в character/emotions.ts */
const EXTRA_EMOTION: Record<string, [string, number, number]> = {
  meet_card: ['surprised', 1, 1500], meet_congrats: ['happy', 1, 1800], meet_self: ['happy', 0.9, 1500], meet_skills: ['happy', 0.8, 1500],
  treat: ['happy', 1, 2200], welcome_back: ['happy', 1, 1600], help: ['happy', 0.7, 1200],
  // каталог «Что умеет кот»: удивить (хлоп), подразнить, засмущать
  clap: ['surprised', 1, 1300], compliment: ['shy', 1, 2600],
};

/**
 * Эффекты, которые закрывают экран (туман, снежный шар, жвачка на стекле, наклейки, конфетти…): только сразу после
 * действия ребёнка и не чаще раза в COVER_GAP_MS. Сами по себе (мысли вслух, приветствие, тишина) — нет.
 */
const COVER_FX = new Set(['snow_globe', 'steam', 'steam_draw', 'steam_heart', 'kiss_print', 'glass_cat', 'gum_splat', 'glitch', 'confetti', 'tag_spray', 'stickers_cover', 'holo_shine']);
const COVER_GAP_MS = 10_000;
const USER_ACT_MS = 2500;

/** панель действий и каталог «Что умеет кот»: кнопка → событие режиссёра (таблица — scenario/actions.ts) */
export { ACTIONS, type ActionId } from './scenario/actions';

/** пресет лица (face.json) → простая эмоция текущих персонажей */
const FACE_EMOTE: Record<string, Emote> = { happy: 'happy', excited: 'happy', proud: 'smirk', smirk: 'smirk', wink: 'wink', annoyed: 'angry', offended: 'angry' };

export class Director extends Emitter<DirectorEvents> {
  state: ScenarioState;
  character!: Character;
  readonly personas: PersonaContext;
  readonly queue: LineQueue;
  readonly cfg: ScenarioConfig;
  private timers = new Map<string, number>();
  private listenTimer = 0;
  /** когда коту можно заговорить самому (filler, silence) — редко и не перебивая ребёнка */
  readonly initiative = new InitiativeGate(undefined, Math.random, performance.now());
  /** событие тишины от Input пришло, когда говорить было нельзя, — скажем, когда станет можно */
  private pendingSilence = false;
  private idleT = 0;
  private blinkT = 0;
  private lostTimer = 0;
  private lastSwipe: { x: number; y: number } | null = null;
  private busyUntil = 0;
  private paused = false;
  private ctx: { x?: number; y?: number; from?: { x: number; y: number }; path?: { x: number; y: number }[] } = {};
  /** последнее касание экрана (жвачка липнет к стеклу только сразу после тапа по стеклу) */
  private lastTouch: { kind: string; at: number } | null = null;
  /** последнее действие ребёнка (касание, голос, кнопка) и последний «закрывающий экран» эффект */
  private lastUserAct = -1e9;
  private lastCoverAt = -1e9;
  private coachTimer = 0;
  /** обучалка ждёт реплику meet_skills (палец и панель — вместе с «погладь меня…», а не раньше) */
  private coachPending = false;
  /** ?synth — разрешить синтез браузера для неозвученных реплик (по умолчанию: есть озвучка — без синтеза, только пузырь) */
  private allowSynth = typeof location !== 'undefined' && new URLSearchParams(location.search).has('synth');

  constructor(private d: DirectorDeps) {
    super();
    const mem = loadMemory();
    const ctxEv = contextEvent(new Date(), mem.lastVisitAt);
    this.state = initialState(mem, ctxEv);
    this.personas = new PersonaContext(d.content, mem.persona);
    this.cfg = makeScenarioConfig(d.content.dialogs);
    d.personas = d.content.personas;
    this.queue = new LineQueue({ stop: (soft) => this.stopVoice(soft) });
    d.fx.palette = this.persona.palette;
    d.fx.onGlitch = (on) => d.glCanvas.classList.toggle('glitch', on);
    d.fx.onSlap = () => d.audio.play('sticker_slap', 0.7);
    d.tracker.onFound(() => this.dispatch({ type: 'card_found' }));
    d.tracker.onLost(() => this.dispatch({ type: 'card_lost' }));
  }

  get persona() {
    return this.personas.persona;
  }
  /** совместимость: debug-панель и др. читают d.personas как Map */
  get personaMap() {
    return this.d.content.personas;
  }

  setCharacter(ch: Character) {
    this.character = ch;
    ch.setPersona(this.persona);
    this.d.stage.setCharacter(ch);
  }

  log(s: string) {
    this.emit('log', s);
  }

  // ───────────── вход событий ─────────────
  dispatch(e: ScenarioEvent) {
    // «ты тут?» — инициатива кота: только когда правила тишины разрешают (scenario/initiative.ts)
    if (e.type === 'silence' && !this.initiativeAllowed()) {
      this.pendingSilence = true;
      return;
    }
    if (e.type === 'silence') {
      this.pendingSilence = false;
      this.initiative.fired(performance.now());
    }
    const r = step(this.state, e, this.cfg);
    if (r.state.phase !== this.state.phase) this.emit('phase', r.state.phase);
    this.state = r.state;
    if (e.type !== 'timer' || e.id !== 'pause_end')
      this.log(`${e.type}${'kind' in e ? ':' + e.kind : ''}${'intent' in e ? ':' + e.intent.type : ''}${'result' in e ? ':' + e.result : ''} → ${r.state.phase}${r.state.dialog ? ` [${r.state.dialog.id}.${r.state.dialog.node}]` : ''}`);
    for (const a of r.actions) this.exec(a);
  }

  /** ввод голосом/чипом/текстом. Разбор — src/voice/intents.ts по content/intents.ru.json */
  text(t: string) {
    this.lastUserAct = performance.now();
    this.coachDone();
    const st = this.state;
    const listening: ListenMode | null = st.dialog?.listening ?? null;
    const expectName = listening === 'name' || (st.phase === 'ask_name' && !listening);
    const expect = st.dialog ? Object.keys(this.cfg.dialogs.dialogs[st.dialog.id]?.nodes[st.dialog.node]?.on ?? {}) : [];
    const m = matchIntent(t, { question: !!listening, expectName, expect });
    const type = m.intent === 'switch' ? 'change_persona' : m.intent;
    const h: Heard = m.intent === 'name' ? { type: 'name', name: m.name, known: !!m.known, text: t } : { type, text: t };
    this.log(`«${t}» → ${h.type}${h.name ? ` ${h.name}${h.known ? '' : ' (нет в словаре)'}` : ''} ${m.confidence.toFixed(2)}${listening ? ` (ждём: ${listening})` : ''}`);
    if (this.cfg.dialogs.interrupts.includes(h.type)) return this.dispatch({ type: 'intent', intent: h });
    if (listening === 'riddle') {
      const r = this.currentRiddle();
      if (r && answerMatches(t, r.keywords)) return this.dispatch({ type: 'answer', result: 'right', text: t });
      if (['giveup', 'no', 'skip'].includes(h.type)) return this.dispatch({ type: 'answer', result: 'giveup', text: t });
      if (h.type !== 'riddle' && h.type !== 'unknown' && resolveTrigger(this.cfg.dialogs, h.type)) return this.dispatch({ type: 'intent', intent: h });
      return this.dispatch({ type: 'answer', result: 'wrong', text: t });
    }
    this.dispatch({ type: 'intent', intent: h });
  }

  interaction(kind: InteractionKind, ctx: { x?: number; y?: number; from?: { x: number; y: number }; path?: { x: number; y: number }[] } = {}) {
    if (kind === 'swipe' && ctx.from) this.lastSwipe = ctx.from;
    this.ctx = ctx;
    this.lastTouch = { kind, at: Date.now() };
    if (!/^(card_|low_light|loud|whisper|clap|stickers_all_gone)/.test(kind)) {
      this.lastUserAct = performance.now();
      if (/^(stroke|tap_cat|poke|double_tap|treat)/.test(kind)) this.coachDone();
    }
    // тап по поверхности карты (не по коту) → кот идёт в эту точку (локомоция)
    if (kind === 'tap_screen' && ctx.x !== undefined && this.state.appeared && !this.d.stage.atGlass && this.canWalk()) {
      const { w, h } = this.d.size();
      const p = this.d.stage.screenToCard(ctx.x, ctx.y!, w, h);
      if (p && this.isOnSurface(p)) {
        if (this.d.stage.walkTo(p, () => this.character.play('idle'))) {
          this.character.play('walk', { loop: true });
          this.d.audio.play('bleep', 0.3);
          this.log(`walk → (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
          if (!this.paused) this.speakEvent('walk_to');
          return;
        }
      }
    }
    this.dispatch(kind === 'shake' ? { type: 'shake' } : { type: 'interaction', kind });
  }

  private canWalk() {
    return this.state.phase === 'play' || this.state.phase === 'free' || this.state.phase === 'ask_name';
  }
  private isOnSurface(p: THREE.Vector2) {
    if (this.d.tracker.capabilities.worldTracking) return p.length() <= this.d.stage.cfg.worldWalkRadius;
    return Math.abs(p.x) <= 0.5 && Math.abs(p.y) <= 0.5 / this.d.tracker.aspect;
  }

  /**
   * Кнопка панели действий или каталога «Что умеет кот» (scenario/actions.ts). Касательные действия (погладить,
   * пощекотать, угостить, фокус, усыпить…) — как жест по коту, остальные — как сказанная команда (танец, сальто, загадка…).
   */
  action(id: ActionId | string) {
    if (!isActionId(id)) return this.log(`нет действия «${id}»`);
    this.lastUserAct = performance.now();
    this.coachDone();
    this.activity();
    clearTimeout(this.sleepTimer);
    const r = ACTION_ROUTE[id];
    if ('say' in r) return this.dispatch({ type: 'intent', intent: { type: r.say, text: r.text } });
    if (r.touch === 'swipe') {
      // «Порисуй на стекле»: палец как будто провёл по экрану рядом с котом
      const { w, h } = this.d.size();
      const path = Array.from({ length: 9 }, (_, i) => ({ x: w * (0.22 + i * 0.07), y: h * (0.5 - Math.sin((i / 8) * Math.PI) * 0.08) }));
      return this.interaction('swipe', { from: path[0], path, x: path[8].x, y: path[8].y });
    }
    this.interaction(r.touch as InteractionKind);
    if (r.touch === 'sleep') {
      // «Усыпи»: подремлет и проснётся сам, если ребёнок ничего не нажал
      const at = this.lastUserAct;
      this.sleepTimer = window.setTimeout(() => {
        if (this.lastUserAct === at) this.interaction('wake_up' as InteractionKind);
      }, SLEEP_WAKE_MS);
    }
  }
  private sleepTimer = 0;

  private startCoach() {
    if (!this.coachPending) return;
    this.coachPending = false;
    this.d.ui.show('chips', true);
    this.d.ui.show('mic', true);
    this.d.ui.coach?.(true);
    clearTimeout(this.coachTimer);
    this.coachTimer = window.setTimeout(() => this.coachDone(), 9000);
  }

  /** подсказка «погладь меня» показана — убрать по первому действию ребёнка или через 9 с */
  private coachDone() {
    if (this.coachPending) this.startCoach();
    if (!this.coachTimer) return;
    clearTimeout(this.coachTimer);
    this.coachTimer = 0;
    this.d.ui.coach?.(false);
  }

  chooseSticker(x: number, y: number) {
    const s = this.d.fx.stickerAt(x, y);
    if (s?.choice && isPersonaId(s.choice)) this.dispatch({ type: 'choose', persona: s.choice });
  }

  // ───────────── исполнение команд ─────────────
  private exec(a: Action) {
    const d = this.d;
    switch (a.type) {
      case 'say':
        this.speakEvent(a.key, { force: a.force });
        break;
      case 'say_riddle':
        this.sayRiddle(a.part);
        break;
      case 'react':
        this.react(a.event);
        break;
      case 'ui':
        if (a.ui === 'chips' && a.show && this.coachPending) break; // панель покажет обучалка
        if (a.ui === 'name_prompt' && a.show && this.state.dialog?.id === 'intro') {
          // лист «Как тебя зовут?» — когда кот договорил вопрос, а не поверх поздравления
          void this.queue.whenIdle().then(() => {
            if (this.state.phase === 'ask_name' && this.state.dialog?.listening === 'name') {
              d.ui.show('name_prompt', true);
              d.ui.show('mic', true);
            }
          });
          break;
        }
        d.ui.show(a.ui, a.show);
        if (a.ui === 'chips') d.ui.show('mic', a.show);
        if (a.ui === 'name_prompt' && a.show) d.ui.show('mic', true);
        break;
      case 'timer':
        clearTimeout(this.timers.get(a.id));
        this.timers.set(a.id, window.setTimeout(() => this.dispatch({ type: 'timer', id: a.id }), a.ms));
        break;
      case 'cancel_timer':
        clearTimeout(this.timers.get(a.id));
        break;
      case 'listen':
        void this.openListen(a.mode, a.ms, a.token);
        break;
      case 'stop_listen':
        clearTimeout(this.listenTimer);
        d.stopListen?.();
        break;
      case 'echo':
        this.echo(a.text);
        break;
      case 'appear':
        void this.appear();
        break;
      case 'offer_choice':
        void this.offerChoice();
        break;
      case 'hide_choice':
        d.ui.hideChoice();
        d.fx.stickers.filter((s) => s.choice).forEach((s) => {
          s.flying = true;
          s.vx = rand(-500, 500);
          s.vy = -700;
          s.vr = rand(-5, 5);
        });
        break;
      case 'set_persona':
        this.setPersona(a.persona);
        break;
      case 'signature':
        void this.signature(a.silent);
        break;
      case 'coach':
        // первое знакомство: палец «погладь меня» у кота и подсвеченная панель действий — когда кот начнёт meet_skills
        this.coachPending = true;
        clearTimeout(this.coachTimer);
        this.coachTimer = window.setTimeout(() => this.startCoach(), 15_000); // запасной: реплику отбросили
        break;
      case 'remember':
        saveMemory({ ...a.patch, visits: this.state.visits, lastVisitAt: Date.now() });
        break;
      case 'cover_stickers': {
        const p = this.personas.get(a.persona)!;
        d.audio.play('sticker_slap');
        void d.fx.cover(p.stickers, p.palette, 3400).then(() => this.dispatch({ type: 'covered' }));
        break;
      }
      case 'blow_stickers':
        d.fx.blowStickers();
        d.audio.play('fly_away');
        this.character.play('jump');
        break;
      case 'hold_pose':
        // поза уже заморожена трекером (экранные координаты / 3DoF). Через lostHoldMs — к стеклу.
        clearTimeout(this.lostTimer);
        if (!d.tracker.capabilities.worldTracking)
          this.lostTimer = window.setTimeout(() => {
            if (!d.tracker.isTracking) d.stage.setMode('glass');
          }, d.stage.cfg.lostHoldMs);
        break;
      case 'resume_pose':
        clearTimeout(this.lostTimer);
        d.stage.setMode('card');
        break;
      case 'open_sberkids':
        // из голоса окно браузер может заблокировать, а уводить ребёнка из AR без взрослого не нужно:
        // лист «Брат живёт в СберKids» с кнопкой (ссылка — из config)
        if (d.ui.showKids) d.ui.showKids(true, ASSETS.sberKidsUrl);
        else d.ui.toast('Нажми кнопку «В СберKids» внизу', 4000);
        break;
      case 'adult_hint':
        d.ui.toast(this.cfg.dialogs.adultHint ?? 'Позови взрослого.', 10_000);
        break;
      case 'goodbye':
        this.character.play('run_home');
        window.setTimeout(() => {
          if (this.state.phase === 'gone') d.stage.show(false);
        }, 1500);
        break;
      case 'pause':
        this.paused = a.on;
        if (a.on) this.queue.clear();
        break;
    }
  }

  /** окно ответа: ждём, пока кот договорит, затем микрофон слушает ms */
  private async openListen(mode: ListenMode, ms: number, token: number) {
    await this.queue.whenIdle();
    if (this.state.listenToken !== token || this.state.dialog?.listening !== mode) return;
    this.d.ui.show('mic', true);
    this.d.listen?.(ms, mode);
    this.log(`🎤 слушаю ${ms / 1000} с (${mode})`);
    clearTimeout(this.listenTimer);
    this.listenTimer = window.setTimeout(() => {
      this.d.stopListen?.();
      this.dispatch({ type: 'listen_timeout', token });
    }, ms);
  }

  private async appear() {
    const d = this.d;
    // хлопок → кот выскакивает из карты; первая встреча — под фанфары и конфетти
    const first = !this.state.met;
    d.stage.resetPosition();
    d.audio.play('gum_chew');
    await wait(300);
    d.audio.play('gum_pop');
    const { w, h } = d.size();
    d.stage.show(true);
    this.character.play('appear');
    d.audio.play('pop_appear');
    if (first) (d.audio as Audio & { fanfare?: () => void }).fanfare?.();
    await wait(80);
    const p = d.stage.headScreen(w, h, 0.4);
    d.fx.burst(p.x, p.y, this.persona.palette.fx, first ? 48 : 30);
    if (first) {
      this.lastCoverAt = performance.now();
      (d.fx as FxLayer & { play?: (id: string, o?: Record<string, unknown>) => unknown }).play?.('confetti', { palette: this.persona.palette });
    }
  }

  private async offerChoice() {
    const d = this.d;
    // ждём, пока договорит «Выбирай, каким мне быть»
    for (let i = 0; i < 80 && this.queue.busy; i++) await wait(100);
    if (this.state.phase !== 'choose') return; // выбор уже сделан (голосом/таймером) — наклейки не нужны
    this.character.play('sticker');
    // выбор — лист внизу экрана (превью и цвет каждого характера), кот остаётся открытым
    const opts = PERSONA_IDS.map((id) => {
      const p = this.personas.get(id)!;
      return { id: p.id, title: p.title, palette: p.palette };
    });
    d.ui.showChoice(opts, (id) => {
      if (this.state.phase === 'choose' && isPersonaId(id)) this.dispatch({ type: 'choose', persona: id });
    });
    this.dispatch({ type: 'choice_shown' });
  }

  setPersona(id: string) {
    if (!isPersonaId(id)) return;
    const changed = this.personas.set(id);
    if (changed) this.queue.switchPersona(id);
    const p = this.persona;
    this.d.fx.palette = p.palette;
    this.character?.setPersona(p);
    const vp = this.d.voice as VoicePlayer & { usePersona?: (p: string) => Promise<unknown>; preloadEvents?: (p: string, ev: string[], max?: number) => void };
    void vp.usePersona?.(id);
    vp.preloadEvents?.(id, ['hello_new', 'invite', 'tap_cat', 'tap_screen', 'swipe', 'double_tap'], 1);
    if (changed) {
      this.emit('persona', id);
      this.log(`persona → ${id} (голос ${p.voice.piperVoice}, +${p.voice.pitchSemitones} пт)`);
    }
  }

  private async signature(silent = false) {
    await wait(250);
    const sig = this.personas.signature;
    // сам по себе (приветствие) — без пятен на стекле: жвачку на экран ребёнок «заслуживает» двойным тапом
    this.playVisual({ clip: sig.clip, fx: sig.fx.filter((f) => f !== 'gum_splat'), sound: sig.sound });
    if (!silent) this.speakEvent(sig.event, { visuals: false });
  }

  /** реакция на ввод: эффект/звук/клип сразу, реплика — через очередь */
  private react(event: string) {
    if (this.paused && this.picker.event(event).priority < 3) return;
    this.emotion(event);
    const prefer = this.prefer;
    let pk = this.personas.line(event, { name: this.state.name, prefer });
    // не понял: «переспроси» и «я пока умею…» подменяют друг друга, если одно ещё остывает, — ребёнок всегда слышит ответ
    // «что ты умеешь» — отвечаем всегда (без cooldown; варианты всё равно не повторяются подряд)
    if (!pk && event === 'unknown') pk = this.personas.line('help', { name: this.state.name, prefer }) ?? this.personas.line('unknown', { name: this.state.name, force: true, prefer });
    else if (!pk && event === 'help') pk = this.personas.line('help', { name: this.state.name, force: true, prefer });
    if (!pk) {
      if (this.picker.coolingDown(event)) return;
      const def = this.persona.reactions[event];
      if (def) this.playVisual({ clip: def.clip, fx: def.fx ? [def.fx] : [], sound: def.sound });
      else this.log(`нет реакции «${event}» у ${this.persona.id}`);
      return;
    }
    this.playVisual({ clip: pk.clip, fx: pk.fx ? [pk.fx] : [], sound: pk.sound, face: pk.face });
    this.enqueue(pk, false);
  }

  private get picker() {
    return this.personas.picker;
  }

  /** реплика сценария/диалога: визуал вместе с речью */
  speakEvent(event: string, o: { force?: boolean; visuals?: boolean } = {}): boolean {
    this.emotion(event);
    const r = this.currentRiddle();
    const pk = this.personas.line(event, { name: this.state.name, vars: r ? { answer: r.answer } : {}, force: o.force, prefer: this.prefer });
    if (!pk) {
      this.log(`реплика «${event}» не выбрана (${this.picker.coolingDown(event) ? 'cooldown' : 'нет подходящих'})`);
      return false;
    }
    return this.enqueue(pk, o.visuals !== false);
  }

  /** вариант реплики прозвучит записью (а не синтезом) — такие picker выбирает в первую очередь */
  private prefer = (l: ContentLine, text: string): boolean => {
    const v = this.d.voice as VoicePlayer & { recorded?: (p: string, id: string | undefined, t: string, x?: string) => boolean; hasRecordings?: boolean };
    if (!v.recorded || !v.hasRecordings) return true;
    const p = this.persona.id;
    const r = this.currentRiddle();
    if (r && l.text.includes('{answer}') && v.recorded(p, `${l.id}@${r.id}`, text, text)) return true;
    return v.recorded(p, l.id, l.text, text);
  };

  private currentRiddle(): Riddle | null {
    const rs = this.persona.riddles;
    if (!rs?.length || this.state.riddleSeq <= 0) return null;
    return rs[(this.state.riddleSeq - 1) % rs.length];
  }

  private sayRiddle(part: 'q' | 'hint') {
    const r = this.currentRiddle();
    if (!r) return;
    const p = this.persona;
    const text = part === 'q' ? r.q : r.hint;
    const pk: PickedLine = {
      persona: p.id, event: `riddle_${part}`, text, face: part === 'q' ? 'think' : 'caring',
      line: { id: `${p.id}.riddle.${r.id}.${part}`, text, emotion: 'neutral', face: 'neutral' },
      clip: 'think', priority: 2, interruptible: true,
    };
    this.enqueue(pk, true);
  }

  private enqueue(pk: PickedLine, visuals: boolean): boolean {
    const ok = this.queue.say({
      persona: pk.persona, event: pk.event, priority: pk.priority, interruptible: pk.interruptible,
      run: () => this.perform(pk, visuals),
    });
    if (!ok) this.log(`реплика «${pk.line.id}» отброшена очередью`);
    return ok;
  }

  private async perform(pk: PickedLine, visuals: boolean) {
    const p = this.personas.get(pk.persona)!;
    if (visuals) this.playVisual({ clip: pk.clip, fx: pk.fx ? [pk.fx] : [], sound: pk.sound, face: pk.face });
    else this.face(pk.face);
    this.d.ui.say(pk.text, p.name, p.id);
    this.emit('log', `🗨 ${pk.line.id}: ${pk.text}`);
    if (pk.event === 'meet_skills') this.startCoach();
    const prevClip = this.character.currentClip;
    const talk = prevClip === 'idle' && !this.d.stage.walking;
    if (talk) this.character.play('talk', { loop: true });
    const v = p.voice;
    const req: SpeakRequest & { lineId: string; piperVoice: string; pitchSemitones: number; emotion: string } = {
      persona: p.id, template: pk.line.text, text: pk.text, pitch: semis(v.pitchSemitones), rate: v.rate,
      lineId: pk.line.id, piperVoice: v.piperVoice, pitchSemitones: v.pitchSemitones, emotion: pk.line.emotion,
    };
    const vp = this.d.voice as VoicePlayer & { recorded?: (p: string, id: string | undefined, t: string, x?: string) => boolean; hasRecordings?: boolean; usePersona?: (p: string) => Promise<unknown> };
    // ответ загадки целиком одной записью («Ответ — огурец.»), а не склейкой «Ответ —» + «огурец»
    const r = this.currentRiddle();
    if (r && pk.line.text.includes('{answer}') && vp.recorded?.(p.id, `${pk.line.id}@${r.id}`, pk.text, pk.text)) {
      req.lineId = `${pk.line.id}@${r.id}`;
      req.template = pk.text;
    }
    // записи нет, а озвучка на сайте есть — не говорим синтезом браузера («неозвученные фрагменты»): только пузырь
    if (vp.recorded && vp.hasRecordings && !this.allowSynth) {
      await vp.usePersona?.(p.id);
      if (!vp.recorded(p.id, req.lineId, req.template, req.text)) {
        this.log(`🔇 нет записи ${req.lineId} — без синтеза, только текст`);
        await wait(Math.min(4500, 900 + pk.text.length * 45));
        this.initiative.catLine(performance.now());
        if (talk && this.character.currentClip === 'talk') this.character.play('idle');
        return;
      }
    }
    await this.d.voice.speak(req);
    this.initiative.catLine(performance.now());
    if (talk && this.character.currentClip === 'talk') this.character.play('idle');
  }

  /** повторялка: фраза ребёнка голосом характера (выше тоном) */
  private echo(text: string) {
    const p = this.persona;
    const v = p.voice;
    const t = text.trim().slice(0, 120);
    if (!t) return;
    this.queue.say({
      persona: p.id, event: 'echo', priority: 2, interruptible: true,
      run: async () => {
        this.d.ui.say(t, p.name, p.id);
        const voice = this.d.voice as VoicePlayer & { echo?: (t: string, o: { persona: string; pitchSemitones: number; rate: number }) => Promise<void> };
        if (voice.echo) return voice.echo(t, { persona: p.id, pitchSemitones: v.echoPitchSemitones, rate: v.echoRate });
        await this.d.voice.speak({ persona: p.id, template: `echo:${t}`, text: t, pitch: semis(v.echoPitchSemitones), rate: v.echoRate });
      },
    });
  }

  /** мягкая остановка: дождаться закрытого рта (граница слога), максимум 300 мс */
  private stopVoice(soft: boolean): Promise<void> | void {
    const v = this.d.voice as VoicePlayer & { fadeOut?: (ms?: number) => void };
    const stop = (ms: number) => (v.fadeOut ? v.fadeOut(ms) : v.cancel());
    if (!soft || !v.speaking) return stop(120);
    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const dom = v.lip.dominant;
        if (!v.speaking || dom === 'X' || dom === 'A' || performance.now() - t0 > 300) {
          stop(60);
          setTimeout(resolve, 70);
        } else setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** эмоция события поверх лица реплики (src/character/emotions.ts): радость при тапе, удивление при находке карты… */
  private emotion(event: string) {
    const cue = emotionFor(event, this.persona.id) ?? EXTRA_EMOTION[event] ?? null;
    const ch = this.character as Character & { setEmotion?: (n: string, w?: number, ms?: number) => void };
    if (cue && ch?.setEmotion) ch.setEmotion(cue[0], cue[1], cue[2]);
  }

  private face(preset: string | undefined) {
    if (!preset || !this.character) return;
    const ch = this.character as Character & { setFace?: (p: string) => void };
    if (ch.setFace) ch.setFace(preset);
    else if (FACE_EMOTE[preset]) ch.emote(FACE_EMOTE[preset], 1400);
  }

  private playVisual(v: { clip?: string; fx?: string[]; sound?: string; face?: string }) {
    const d = this.d;
    const snd = runtimeSound(v.sound, (s) => d.audio.has(s));
    if (snd) d.audio.play(snd);
    const clip = runtimeClip(v.clip);
    if (clip && !d.stage.walking) this.character.play(clip);
    for (const f of v.fx ?? []) void this.runFx(f);
    this.face(v.face);
  }

  /** контентный эффект: сначала родной API FxLayer (если научится), иначе запасной из runtimeMap */
  async runFx(id: string) {
    const d = this.d;
    // заклеивание экрана при смене образа делает команда cover_stickers — второй раз из реплики не нужен
    if (id === 'stickers_cover') return;
    if (id === 'sticker' || id === 'tag_spray') {
      // наклейки не копятся: на стекле не больше трёх, старая улетает
      const own = d.fx.stickers.filter((x) => !x.flying && !x.choice && !x.cover);
      for (const x of own.slice(0, Math.max(0, own.length - 2))) {
        x.flying = true;
        x.vx = rand(-500, 500);
        x.vy = -700;
        x.vr = rand(-5, 5);
      }
    }
    if (COVER_FX.has(id)) {
      // закрывающий экран эффект — только по действию ребёнка и не чаще раза в 10 с (смена образа — по просьбе ребёнка)
      const now = performance.now();
      const byUser = now - this.lastUserAct < USER_ACT_MS || this.state.phase === 'switching';
      if (!byUser || now - this.lastCoverAt < COVER_GAP_MS) {
        this.log(`[fx] ${id} пропущен (${byUser ? 'слишком часто' : 'не по действию ребёнка'})`);
        return;
      }
      this.lastCoverAt = now;
    }
    const { w, h } = d.size();
    const pal = this.persona.palette;
    const tune = this.personas.fxTuning(id);
    const at = this.ctx.x !== undefined ? { x: this.ctx.x, y: this.ctx.y! } : d.stage.headScreen(w, h, 0.6);
    const generic = (d.fx as FxLayer & { play?: (id: string, o: Record<string, unknown>) => boolean | void }).play;
    if (generic && generic.call(d.fx, id, { at, palette: pal, tuning: tune, from: this.ctx.from ?? this.lastSwipe, path: this.ctx.path }) !== false) return;
    const f: FxName | null = runtimeFx(id);
    switch (f) {
      case 'glitter_burst':
        d.fx.burst(at.x, at.y, pal.fx, tune.count ?? 36);
        break;
      case 'glitter_trail':
        d.fx.trail(this.ctx.path ?? [at], pal.fx);
        break;
      case 'snow_globe':
        d.fx.snowGlobe(pal.fx);
        break;
      case 'knock':
        d.fx.knock(at.x, at.y);
        break;
      case 'claws':
        d.fx.claws(this.ctx.from ?? this.lastSwipe ?? { x: w * 0.2, y: h * 0.4 }, at);
        break;
      case 'glitch':
        d.fx.glitch(550);
        break;
      case 'gum_bubble': {
        if (Date.now() < this.busyUntil) return;
        this.busyUntil = Date.now() + 2500;
        const m = d.stage.headScreen(w, h, 0.62);
        const lt = this.lastTouch;
        const byTouch = !!lt && /tap|spam|longpress/.test(lt.kind) && Date.now() - lt.at < 1500;
        await d.fx.gumBubble(m.x, m.y, pal.accent, byTouch);
        d.audio.play('gum_pop');
        if (byTouch) d.audio.play('gum_splat', 0.8);
        break;
      }
      case 'steam_heart':
        if (d.fx.fogActive) return;
        await d.fx.steamHeart();
        d.audio.play('chime');
        break;
      case 'glass_cat': {
        const poster = this.character.posterImage();
        if (poster) {
          d.fx.glassCatShow(poster, 2600);
          d.stage.hideFor(2600);
        } else {
          d.stage.setMode('glass');
          await wait(2600);
          if (d.tracker.isTracking || d.tracker.capabilities.worldTracking) d.stage.setMode('card');
        }
        break;
      }
      case 'sticker': {
        const s = this.persona.stickers;
        d.fx.addSticker(s[Math.floor(Math.random() * s.length)], at.x, at.y);
        break;
      }
    }
  }

  // ───────────── debug / API ─────────────
  /** проиграть реплику по id («kind.intro.02») — характер переключается на владельца реплики */
  sayLine(id: string): boolean {
    const pk = this.picker.byId(this.d.content.personas, id, { name: this.state.name });
    if (!pk) return false;
    if (pk.persona !== this.personas.id) this.setPersona(pk.persona);
    this.queue.clear();
    return this.enqueue({ ...pk, priority: 2, interruptible: true }, true);
  }

  /** проиграть событие активным характером (без cooldown) */
  playEvent(event: string): boolean {
    this.queue.clear();
    return this.speakEvent(event, { force: true });
  }

  /** совместимость со старой debug-панелью: произнести текст голосом характера */
  speakText(personaId: string, text: string) {
    const p = this.personas.get(personaId as PersonaId) ?? this.persona;
    this.d.ui.say(text, p.name, p.id);
    this.queue.clear();
    this.queue.say({ persona: p.id, event: 'debug', priority: 2, interruptible: true, run: () => this.d.voice.speak({ persona: p.id, template: text, text, pitch: semis(p.voice.pitchSemitones), rate: p.voice.rate }) });
  }

  /** каждый кадр */
  update(dt: number) {
    const v = this.d.voice;
    v.update(dt);
    const lip = v.lip;
    this.character?.setMouth(lip.dominant, lip.weights[lip.dominant], lip.shape);
    // моргание чаще во время речи
    if (v.speaking && (this.blinkT += dt) > 2.2 + Math.random() * 2) {
      this.blinkT = 0;
      this.character?.emote('blink', 150);
    }
    const playing = this.state.phase === 'play' || this.state.phase === 'free';
    // idle-набор характера с весами
    if (playing && !v.speaking && this.character?.currentClip === 'idle' && !this.d.stage.walking) {
      if ((this.idleT += dt) > 8 + Math.random() * 4) {
        this.idleT = 0;
        const clip = runtimeClip(this.personas.pickIdle());
        if (clip && clip !== 'idle') this.character.play(clip);
      }
    } else this.idleT = 0;
    // инициатива кота: мысль вслух (filler) или отложенное «ты тут?» (silence) — не чаще раза в 15–20 с,
    // не пока ребёнок говорит, не сразу после его фразы или вопроса кота (scenario/initiative.ts)
    if (playing && this.initiativeAllowed()) {
      if (this.pendingSilence) this.dispatch({ type: 'silence' });
      else if (this.speakEvent('filler')) this.initiative.fired(performance.now());
      else this.initiative.fired(performance.now() - 10_000); // реплика остывает — попробуем чуть позже
    }
  }

  private initiativeAllowed(): boolean {
    const t = turn.get();
    const playing = this.state.phase === 'play' || this.state.phase === 'free';
    return this.initiative.allowed({
      now: performance.now(), userSpeaking: t.userSpeaking, lastUserAt: t.lastUserAt, lastQuestionAt: t.lastQuestionAt,
      busy: this.queue.busy || this.d.voice.speaking || this.d.stage.walking,
      blocked: !playing || this.paused || this.state.paused || !!this.state.dialog,
    });
  }

  /** любая активность пользователя (касание, голос) откладывает инициативу кота */
  activity() {
    turn.userActivity();
  }

  static readonly kidsUrl = ASSETS.sberKidsUrl;
}

/** полутоны → pitch speechSynthesis (0.5…2) */
const semis = (st: number) => Math.max(0.5, Math.min(2, Math.pow(2, st / 12)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
