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
import { resolveTrigger, type ListenMode } from './scenario/dialogs';
import type { ContentBundle } from './persona/content';
import { PersonaContext } from './persona/context';
import { LineQueue } from './persona/lineQueue';
import type { PickedLine } from './persona/picker';
import type { FxName, PersonaId, Riddle } from './persona/types';
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
  private quietT = 0;
  private idleT = 0;
  private blinkT = 0;
  private lostTimer = 0;
  private lastSwipe: { x: number; y: number } | null = null;
  private busyUntil = 0;
  private paused = false;
  private ctx: { x?: number; y?: number; from?: { x: number; y: number }; path?: { x: number; y: number }[] } = {};

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
    const r = step(this.state, e, this.cfg);
    if (r.state.phase !== this.state.phase) this.emit('phase', r.state.phase);
    this.state = r.state;
    if (e.type !== 'timer' || e.id !== 'pause_end')
      this.log(`${e.type}${'kind' in e ? ':' + e.kind : ''}${'intent' in e ? ':' + e.intent.type : ''}${'result' in e ? ':' + e.result : ''} → ${r.state.phase}${r.state.dialog ? ` [${r.state.dialog.id}.${r.state.dialog.node}]` : ''}`);
    for (const a of r.actions) this.exec(a);
  }

  /** ввод голосом/чипом/текстом. Разбор — src/voice/intents.ts по content/intents.ru.json */
  text(t: string) {
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
        void this.signature();
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
      case 'open_sberkids': {
        // из голоса (не из жеста) браузер может заблокировать окно — тогда остаётся кнопка
        let w: Window | null = null;
        try {
          w = window.open(ASSETS.sberKidsUrl, '_blank', 'noopener');
        } catch {
          /* ignore */
        }
        if (!w) d.ui.toast('Нажми кнопку «В СберKids» внизу', 4000);
        break;
      }
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
    // чавк → хлопок → кот выскакивает из карты
    d.stage.resetPosition();
    d.audio.play('gum_chew');
    await wait(900);
    d.audio.play('gum_pop');
    const { w, h } = d.size();
    d.stage.show(true);
    this.character.play('appear');
    d.audio.play('pop_appear');
    await wait(80);
    const p = d.stage.headScreen(w, h, 0.4);
    d.fx.burst(p.x, p.y, this.persona.palette.fx, 30);
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

  private async signature() {
    await wait(250);
    const sig = this.personas.signature;
    this.playVisual({ clip: sig.clip, fx: sig.fx, sound: sig.sound });
    this.speakEvent(sig.event, { visuals: false });
  }

  /** реакция на ввод: эффект/звук/клип сразу, реплика — через очередь */
  private react(event: string) {
    if (this.paused && this.picker.event(event).priority < 3) return;
    const pk = this.personas.line(event, { name: this.state.name });
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
    const r = this.currentRiddle();
    const pk = this.personas.line(event, { name: this.state.name, vars: r ? { answer: r.answer } : {}, force: o.force });
    if (!pk) {
      this.log(`реплика «${event}» не выбрана (${this.picker.coolingDown(event) ? 'cooldown' : 'нет подходящих'})`);
      return false;
    }
    return this.enqueue(pk, o.visuals !== false);
  }

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
    const prevClip = this.character.currentClip;
    const talk = prevClip === 'idle' && !this.d.stage.walking;
    if (talk) this.character.play('talk', { loop: true });
    const v = p.voice;
    const req: SpeakRequest & { lineId: string; piperVoice: string; pitchSemitones: number; emotion: string } = {
      persona: p.id, template: pk.line.text, text: pk.text, pitch: semis(v.pitchSemitones), rate: v.rate,
      lineId: pk.line.id, piperVoice: v.piperVoice, pitchSemitones: v.pitchSemitones, emotion: pk.line.emotion,
    };
    await this.d.voice.speak(req);
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
        const byTouch = this.ctx.x !== undefined;
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
    // «заполнитель» паузы: в свободной игре, если давно тихо и никто не ждёт ответа
    if (playing && !this.paused && !this.state.dialog && !this.queue.busy && !this.d.stage.walking) {
      this.quietT += dt;
      if (this.quietT > 7 + Math.random() * 3) {
        this.quietT = -6;
        this.speakEvent('filler');
      }
    } else this.quietT = 0;
  }

  /** любая активность пользователя сбрасывает таймер «заполнителя» */
  activity() {
    this.quietT = 0;
  }

  static readonly kidsUrl = ASSETS.sberKidsUrl;
}

/** полутоны → pitch speechSynthesis (0.5…2) */
const semis = (st: number) => Math.max(0.5, Math.min(2, Math.pow(2, st / 12)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
