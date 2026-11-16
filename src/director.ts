/**
 * Director — «режиссёр»: принимает события (ввод, трекер, голос), прогоняет через автомат сценария
 * и исполняет команды: реплики, звуки, эффекты, клипы, интерфейс, таймеры.
 * Все модули доступны только через интерфейсы — технологию каждого можно заменить.
 */
import * as THREE from 'three';
import { Emitter } from './core/emitter';
import { initialState, step, type Action, type ScenarioEvent, type ScenarioState, type InteractionKind } from './scenario/machine';
import { loadMemory, saveMemory } from './scenario/memory';
import { NoRepeatPicker } from './persona/linePicker';
import { fill } from './persona/loader';
import { normLine, type FxName, type Persona, type Reaction } from './persona/types';
import { isClip, type Character, type ClipName } from './character/types';
import type { Stage } from './stage';
import type { FxLayer } from './fx/fxLayer';
import type { Audio } from './audio/audio';
import type { Speaker } from './voice/speech';
import type { UI } from './ui/ui';
import type { Tracker } from './tracker/types';
import { parseIntent, type Intent } from './voice/intents';
import { ASSETS } from './config';
import { rand } from './core/util';

export type DirectorEvents = { log: string; phase: string };

export interface DirectorDeps {
  tracker: Tracker;
  stage: Stage;
  fx: FxLayer;
  audio: Audio;
  voice: Speaker;
  ui: UI;
  personas: Map<string, Persona>;
  glCanvas: HTMLCanvasElement;
  size: () => { w: number; h: number };
}

export class Director extends Emitter<DirectorEvents> {
  state: ScenarioState;
  character!: Character;
  persona: Persona;
  private picker = new NoRepeatPicker(2);
  private timers = new Map<string, number>();
  private speechChain: Promise<void> = Promise.resolve();
  private speechGen = 0;
  private lostTimer = 0;
  private lastSwipe: { x: number; y: number } | null = null;
  private busyUntil = 0;

  constructor(private d: DirectorDeps) {
    super();
    const mem = loadMemory();
    this.state = initialState(mem);
    this.persona = d.personas.get(mem.persona ?? 'hooligan') ?? [...d.personas.values()][0];
    d.fx.palette = this.persona.palette;
    d.fx.onGlitch = (on) => d.glCanvas.classList.toggle('glitch', on);
    d.fx.onSlap = () => d.audio.play('sticker_slap', 0.7);
    d.tracker.onFound(() => this.dispatch({ type: 'card_found' }));
    d.tracker.onLost(() => this.dispatch({ type: 'card_lost' }));
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
    const r = step(this.state, e);
    if (r.state.phase !== this.state.phase) this.emit('phase', r.state.phase);
    this.state = r.state;
    this.log(`${e.type}${'kind' in e ? ':' + e.kind : ''}${'intent' in e ? ':' + e.intent.type : ''} → ${r.state.phase}`);
    for (const a of r.actions) this.exec(a, e);
  }

  /** ввод голосом/чипом/текстом */
  text(t: string) {
    const intent = parseIntent(t, { expectName: this.state.phase === 'ask_name' });
    this.log(`«${t}» → ${intent.type}`);
    this.dispatch({ type: 'intent', intent });
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
          // считаем как взаимодействие, но без реакции «стук»
          if (this.state.phase === 'play' || this.state.phase === 'free') {
            const st = { ...this.state, interactions: this.state.interactions + 1 };
            this.state = st;
            if (st.phase === 'play' && st.interactions >= 3 && !st.outroShown) this.exec({ type: 'timer', id: 'outro', ms: 2600 });
          }
          return;
        }
      }
    }
    this.dispatch(kind === 'shake' ? { type: 'shake' } : { type: 'interaction', kind });
  }
  private ctx: { x?: number; y?: number; from?: { x: number; y: number }; path?: { x: number; y: number }[] } = {};

  private canWalk() {
    return this.state.phase === 'play' || this.state.phase === 'free' || this.state.phase === 'ask_name';
  }
  private isOnSurface(p: THREE.Vector2) {
    if (this.d.tracker.capabilities.worldTracking) return p.length() <= this.d.stage.cfg.worldWalkRadius;
    return Math.abs(p.x) <= 0.5 && Math.abs(p.y) <= 0.5 / this.d.tracker.aspect;
  }

  chooseSticker(x: number, y: number) {
    const s = this.d.fx.stickerAt(x, y);
    if (s?.choice) this.dispatch({ type: 'choose', persona: s.choice });
  }

  // ───────────── исполнение команд ─────────────
  private exec(a: Action, e?: ScenarioEvent) {
    const d = this.d;
    switch (a.type) {
      case 'say':
        this.say(a.key, a.vars);
        break;
      case 'react':
        this.react(a.event);
        break;
      case 'intent_reply':
        this.react(a.intent);
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
      case 'appear':
        void this.appear();
        break;
      case 'offer_choice':
        void this.offerChoice();
        break;
      case 'hide_choice':
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
        saveMemory({ ...a.patch, visits: this.state.visits });
        break;
      case 'cover_stickers': {
        const p = d.personas.get(a.persona)!;
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
    }
    void e;
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
    await this.speechChain;
    this.character.play('sticker');
    const { w, h } = d.size();
    const ids: number[] = [];
    let i = 0;
    for (const p of d.personas.values()) {
      const spec = p.id === 'glitter' ? { kind: 'holo' as const } : { kind: 'tag' as const, text: 'ЙО!' };
      const s = d.fx.addSticker(spec, w * (i === 0 ? 0.28 : 0.72), h * 0.56, {
        size: Math.min(w * 0.38, 190), rot: i === 0 ? -0.12 : 0.12, mirrored: false, choice: p.id, label: p.title, palette: p.palette,
      });
      ids.push(s.id);
      i++;
      await wait(450);
    }
    void ids;
    this.dispatch({ type: 'choice_shown' });
  }

  setPersona(id: string) {
    const p = this.d.personas.get(id);
    if (!p) return;
    this.persona = p;
    this.d.fx.palette = p.palette;
    this.character?.setPersona(p);
    this.picker.reset();
    this.log(`persona → ${id}`);
  }

  private async signature() {
    await wait(250);
    await this.runReaction(this.persona.signature, 'signature');
  }

  private react(event: string) {
    const r = this.persona.reactions[event];
    if (!r) {
      this.log(`нет реакции «${event}» у ${this.persona.id}`);
      return;
    }
    void this.runReaction(r, event);
  }

  private async runReaction(r: Reaction, key: string) {
    const d = this.d;
    d.audio.play(r.sound);
    if (r.hideMs) {
      d.stage.hideFor(r.hideMs);
    }
    if (r.clip && isClip(r.clip) && !d.stage.walking) this.character.play(r.clip as ClipName);
    const fxs = (Array.isArray(r.fx) ? r.fx : r.fx ? [r.fx] : []) as FxName[];
    for (const f of fxs) void this.runFx(f);
    if (r.lines?.length) this.speakLine(key, r.lines, {}, true);
  }

  async runFx(f: FxName) {
    const d = this.d;
    const { w, h } = d.size();
    const pal = this.persona.palette;
    const at = this.ctx.x !== undefined ? { x: this.ctx.x, y: this.ctx.y! } : d.stage.headScreen(w, h, 0.6);
    switch (f) {
      case 'glitter_burst':
        d.fx.burst(at.x, at.y, pal.fx);
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
        await d.fx.gumBubble(m.x, m.y, pal.accent);
        d.audio.play('gum_pop');
        d.audio.play('gum_splat', 0.8);
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
          // спрайт-режим: прижатый к стеклу кадр; сам кот на карте прячется
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

  private say(key: string, vars?: Record<string, string>) {
    const lines = this.persona.lines[key];
    if (!lines?.length) return;
    this.speakLine(key, lines, vars ?? { name: this.state.name ?? '' }, false);
  }

  /** interrupt=true — реакция перебивает текущую реплику (отклик важнее), иначе — в очередь */
  private speakLine(key: string, lines: Reaction['lines'] & {}, vars: Record<string, string>, interrupt: boolean) {
    const p = this.persona;
    const line = normLine(this.picker.pick(`${p.id}:${key}`, lines)!);
    const text = fill(line.text, { name: this.state.name ?? '', ...vars });
    const gen = interrupt ? ++this.speechGen : this.speechGen;
    if (interrupt) this.d.voice.cancel();
    const run = async () => {
      if (gen !== this.speechGen) return;
      this.d.ui.say(text, p.name, p.id);
      const prevClip = this.character.currentClip;
      const talk = prevClip === 'idle' && !this.d.stage.walking;
      if (talk) this.character.play('talk', { loop: true });
      await this.d.voice.speak(text, { pitch: p.voice.pitch, rate: p.voice.rate, audio: line.audio });
      if (talk && this.character.currentClip === 'talk') this.character.play('idle');
    };
    this.speechChain = interrupt ? run() : this.speechChain.then(run);
  }

  /** каждый кадр */
  update() {
    this.character?.setMouth(this.d.voice.mouth());
  }

  static readonly kidsUrl = ASSETS.sberKidsUrl;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type { Intent };
