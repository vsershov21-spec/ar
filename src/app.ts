/** Сборка приложения: выбирает реализации модулей по параметрам URL и связывает их. */
import * as THREE from 'three';
import { ASSETS, loadStage } from './config';
import { asset } from './core/util';
import type { Tracker } from './tracker/types';
import { DebugTracker } from './tracker/debugTracker';
import { MindARTracker } from './tracker/mindarTracker';
import { Stage } from './stage';
import type { Character, TouchZone } from './character/types';
import type { InteractionKind } from './scenario/machine';
import { SpriteCharacter } from './character/spriteCharacter';
import { RigCat } from './character/rigCat';
import { isClip } from './character/types';
import { FxLayer } from './fx/fxLayer';
import { Audio } from './audio/audio';
import { VoicePlayer } from './voice/voicePlayer';
import { VoiceEngine } from './voice/engine';
import { loadContent } from './persona/content';
import { Input } from './input/input';
import { UI, posterUrl } from './ui/ui';
import { Director } from './director';
import { personaMeta } from './character/personaMeta';

export type CharacterMode = 'sprite' | 'rig' | 'glb';
export type TrackerKind = 'mindar' | 'debug' | '8thwall' | 'webxr';

export interface AppParams {
  debug: boolean;
  tracker: TrackerKind;
  character: CharacterMode;
  asr: string | null;
  /** ?mic=auto — «слушаю сам» (по умолчанию push-to-talk) */
  mic: string | null;
}

export function readParams(search = location.search): AppParams {
  const q = new URLSearchParams(search);
  const debug = q.has('debug');
  const t = (q.get('tracker') as TrackerKind) || (debug ? 'debug' : 'mindar');
  const c = (q.get('char') as CharacterMode) || 'sprite';
  return { debug, tracker: t, character: ['sprite', 'rig', 'glb'].includes(c) ? c : 'sprite', asr: q.get('asr'), mic: q.get('mic') };
}

/** GLB-режим грузится лениво: GLTFLoader (и Draco, если модель сжата) не попадают в основной бандл */
export async function makeCharacter(mode: CharacterMode): Promise<Character> {
  if (mode === 'rig') return new RigCat();
  if (mode === 'glb') {
    const { GlbCharacter } = await import('./character/glbCharacter');
    return new GlbCharacter(ASSETS.glb);
  }
  return new SpriteCharacter(ASSETS.spriteManifest);
}

/** зона → клип тычка (если у характера нет реакции на эту зону) */
const POKE_CLIP: Record<string, string> = {
  tap_cat_head: 'poke_head', tap_cat_cheek: 'poke_cheek', tap_cat_belly: 'poke_belly', tap_cat_paw: 'poke_paw', tap_cat_tail: 'poke_tail',
  poke_combo: 'offended', poke_hard: 'flinch', stroke: 'purr_stroke', stroke_long: 'hug_screen',
};
const POKE_FACE: Record<string, string> = { tap_cat_cheek: 'squished', poke_hard: 'offended', poke_combo: 'annoyed', stroke: 'purr', stroke_long: 'purr' };

export class App {
  readonly root: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  tracker!: Tracker;
  stage!: Stage;
  fx!: FxLayer;
  audio = new Audio();
  voice!: VoicePlayer;
  /** голосовой вход: микрофон, Vosk, повтор, громкость (src/voice/engine.ts) */
  engine!: VoiceEngine;
  input!: Input;
  ui!: UI;
  director!: Director;
  character!: Character;
  private clock = new THREE.Clock();
  private elapsed = 0;
  fps = 0;
  private frames = 0;
  private fpsT = 0;
  onFrame: (dt: number) => void = () => {};

  constructor(root: HTMLElement, readonly params: AppParams) {
    this.root = root;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.debug });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'gl';
  }

  async init() {
    const p = this.params;
    if (p.debug) {
      const bg = document.createElement('div');
      bg.className = 'debug-bg';
      this.root.appendChild(bg);
    }
    this.root.appendChild(this.renderer.domElement);
    this.tracker = await this.makeTracker(p.tracker);
    this.tracker.attachRenderer?.(this.renderer);
    this.scene.add(this.tracker.anchor);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(0.5, 1, 1);
    this.scene.add(dir);

    this.stage = new Stage(this.scene, this.tracker, loadStage());
    this.stage.constrainToCard = !this.tracker.capabilities.worldTracking;
    this.fx = new FxLayer(this.root);
    this.fx.attachScene(this.renderer.domElement);
    this.voice = new VoicePlayer(this.audio);
    this.engine = new VoiceEngine(this.audio, this.voice, { asr: p.asr, mode: p.mic, grammar: new URLSearchParams(location.search).get('grammar') !== '0' });
    const [content] = await Promise.all([loadContent(), this.audio.load(ASSETS.sfx), this.voice.load(ASSETS.voice)]);

    this.ui = new UI(this.root, {
      onWake: () => void this.wake(),
      onMicDown: () => this.engine.pttDown(),
      onMicUp: () => this.engine.pttUp(),
      onChip: (t) => {
        this.input.activity();
        this.engine.handleText(t, 'chip');
      },
      onName: (n) => this.director.dispatch({ type: 'name', name: n }),
      onSkipName: () => this.director.dispatch({ type: 'skip_name' }),
      onShakeButton: () => this.input.simulateShake(),
      onKids: () => window.open(ASSETS.sberKidsUrl, '_blank', 'noopener'),
      onMute: (m) => {
        this.audio.setMuted(m);
        this.voice.muted = m;
        if (m) this.voice.cancel();
      },
    }, { micSupported: this.engine.asr.supported, posterUrl: posterUrl() });

    this.bindVoice();

    this.director = new Director({
      tracker: this.tracker, stage: this.stage, fx: this.fx, audio: this.audio, voice: this.voice, ui: this.ui,
      content, glCanvas: this.renderer.domElement, size: () => ({ w: this.root.clientWidth, h: this.root.clientHeight }),
      // окно ответа: кот спросил — микрофон слушает сам ms (mode 'echo' — повтор: запись без распознавания)
      listen: (ms, mode) => this.engine.listenFor(ms, mode),
      stopListen: () => this.engine.stopListen(),
    });
    await this.setCharacterMode(p.character);
    this.wireFx();
    // озвучка: манифест текущего характера и первые реплики сценария — заранее
    this.voice.preloadEvents(this.director.persona.id, ['point_camera', 'intro', 'ask_name', 'nice_name', 'no_name']);

    this.input = new Input(this.fx.canvas, {
      zoneAt: (x, y) => this.zoneAt(x, y),
      tryPeel: (x, y) => this.fx.beginPeel(x, y),
      fxDown: (x, y) => this.fx.pointerDown(x, y),
      fxMove: (x, y, px, py) => this.fx.pointerMove(x, y, px, py),
      fxUp: (x, y) => this.fx.pointerUp(x, y),
      isChoiceSticker: (x, y) => !!this.fx.stickerAt(x, y)?.choice,
    });
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** слой эффектов: звук, точки кота, лог, характер (палитра, fxTuning, наклейки из content/src/*.meta.json) */
  private wireFx() {
    const fx = this.fx;
    fx.onSound = (id, v) => this.audio.play(id, v ?? 1);
    fx.onLog = (m) => this.director.log(m);
    fx.anchorFn = (n) => this.stage.anchorScreen(n, this.root.clientWidth, this.root.clientHeight);
    fx.glassCatHook = (ms) => {
      const poster = this.character.posterImage();
      if (poster) {
        this.stage.hideFor(ms);
        return poster;
      }
      if (!this.stage.atGlass) {
        this.stage.setMode('glass');
        setTimeout(() => {
          if (this.tracker.isTracking || this.tracker.capabilities.worldTracking) this.stage.setMode('card');
        }, ms);
      }
      return null;
    };
    fx.onStickerSeries = () => {
      if (!this.stage.walking) this.character.play('sticker');
    };
  }
  private lastPersona = '';
  /** смена характера (её делает director) → графика: эффекты и скин */
  private syncPersona() {
    const p = this.director.persona;
    if (p.id === this.lastPersona) return;
    this.lastPersona = p.id;
    const meta = personaMeta(p.id);
    this.fx.setPersona({ palette: p.palette ?? meta.palette, fxTuning: meta.fxTuning, stickers: p.stickers?.length ? p.stickers : meta.stickers });
  }

  /** голосовой вход ↔ интерфейс и режиссёр (только события) */
  private bindVoice() {
    const e = this.engine;
    let lastState = '';
    e.on('interim', (t) => this.ui.micHintText(t));
    e.on('state', (s) => {
      const k = `${s.asrState}|${s.listening}|${Math.round(s.modelProgress * 20)}|${s.echo}`;
      if (k === lastState) return;
      lastState = k;
      if (s.asrState === 'loading') this.ui.micHintText(`Загружаю распознавание… ${Math.round(s.modelProgress * 100)}%`);
      else if (s.asrState === 'listening') this.ui.micHintText(s.echo !== 'off' ? 'Говори — повторю!' : 'Слушаю…');
      else if (s.asrState === 'error')
        this.ui.micHintText(s.micError === 'not-allowed' ? 'Нет доступа к микрофону — жми подсказки' : /no-model/.test(s.lastEvent) ? 'Офлайн-модель не найдена — жми подсказки' : 'Не расслышал, попробуй ещё');
      else if (s.echo === 'waiting') this.ui.micHintText('Говори — повторю!');
      if (s.asrState === 'idle' && !s.listening && s.echo === 'off') this.ui.micLevel(0);
    });
    // уровень микрофона — плавно, по кадрам
    const lvl = () => {
      requestAnimationFrame(lvl);
      if (e.mic.isOpen) this.ui.micLevel(e.mic.level);
    };
    lvl();
    e.on('text', ({ text, source }) => {
      if (source === 'asr') this.ui.micHintText(`«${text}»`);
      this.input?.activity();
      this.director.text(text);
    });
    e.on('event', ({ id, data }) => {
      this.director.log(`🎙 ${id}${data ? ' ' + JSON.stringify(data) : ''}`);
      // громкость без распознавания → реакции кота (events.json: loud, whisper, clap)
      if ((id === 'loud' || id === 'whisper' || id === 'clap') && this.director.state.appeared) this.director.interaction(id);
    });
    e.on('clip', ({ name }) => {
      if (isClip(name) && !this.stage.walking) this.character.play(name);
    });
    e.echoPreset = () => {
      const v = this.director.persona.voice;
      return { echoPitchSemitones: v.echoPitchSemitones ?? 5, echoRate: v.echoRate ?? 1 };
    };
  }

  private async makeTracker(kind: TrackerKind): Promise<Tracker> {
    if (kind === 'debug') return new DebugTracker(asset(ASSETS.cardImage));
    if (kind === '8thwall') {
      const { EighthWallTracker } = await import('./tracker/eighthWallTracker');
      const c = document.createElement('canvas');
      c.className = 'camera-video';
      c.style.inset = '0';
      this.root.prepend(c);
      return new EighthWallTracker(c, ASSETS.eighthWallTarget);
    }
    if (kind === 'webxr') {
      const { WebXRTracker } = await import('./tracker/webxrTracker');
      const t = new WebXRTracker(this.root);
      this.scene.add(t.reticle);
      return t;
    }
    return new MindARTracker(this.root, asset(ASSETS.target));
  }

  async setCharacterMode(mode: CharacterMode) {
    const ch = await makeCharacter(mode);
    try {
      await ch.load();
    } catch (e) {
      console.error('[character] load failed', e);
    }
    this.character?.dispose();
    this.character = ch;
    this.director.setCharacter(ch);
  }

  /** зона кота под пальцем (head, cheek, belly, paw, tail, body) или null — мимо кота */
  zoneAt(x: number, y: number): TouchZone | null {
    if (!this.stage.root.visible) return null;
    const ray = new THREE.Raycaster();
    const w = this.root.clientWidth, h = this.root.clientHeight;
    ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.tracker.camera);
    this.stage.root.updateMatrixWorld(true);
    if (this.character.hitZone) return this.character.hitZone(ray);
    return this.character.hitTest(ray) ? 'body' : null;
  }

  /**
   * Событие касания кота → режиссёр. Если у характера нет реакции на это событие (старые persona-файлы),
   * — ближайшая общая реакция + клип/лицо из таблицы, чтобы тычки по зонам были видны всегда.
   */
  private touchCat(event: string, p: { x?: number; y?: number } = {}, fallback = 'tap_cat') {
    const d = this.director;
    const has = !!d.persona.reactions?.[event];
    d.interaction((has ? event : fallback) as InteractionKind, p);
    if (!has) {
      if (POKE_CLIP[event] && !this.stage.walking) this.character.play(POKE_CLIP[event], { loop: event === 'stroke' });
      if (POKE_FACE[event]) this.character.face(POKE_FACE[event], event === 'stroke' ? 0 : 2000);
    }
  }
  private purrT = 0;

  private bindInput() {
    const i = this.input, d = this.director;
    i.on('tap_cat', (p) => this.touchCat(p.event, p));
    i.on('poke_combo', (p) => this.touchCat('poke_combo', p));
    i.on('poke_hard', (p) => this.touchCat('poke_hard', p));
    i.on('stroke', (p) => {
      this.purrT = 1.7; // первое «мрр» — звук реакции stroke
      this.touchCat('stroke', p);
    });
    i.on('stroke_long', (p) => this.touchCat('stroke_long', p));
    i.on('stroke_end', () => {
      // перестали гладить: мурчание и прищур уходят
      if (/purr_stroke|hug_screen/.test(this.character.currentClip)) this.character.play('idle');
      this.character.face('neutral');
    });
    i.on('double_tap', (p) => {
      if (d.persona.reactions?.double_tap) d.interaction('double_tap' as InteractionKind, p);
      else (d as unknown as { signature(): void }).signature();
    });
    i.on('tap_screen', (p) => d.interaction('tap_screen', p));
    i.on('longpress', (p) => d.interaction('longpress', p));
    i.on('swipe', (s) => d.interaction('swipe', { x: s.x, y: s.y, from: s.path[0], path: s.path }));
    i.on('shake', () => d.interaction('shake'));
    i.on('spam', () => d.interaction('spam'));
    i.on('silence', () => d.dispatch({ type: 'silence' }));
    i.on('activity', () => d.activity());
    i.on('sticker_tap', (p) => d.chooseSticker(p.x, p.y));
    i.on('drag', (p) => this.fx.wipeFog(p.x, p.y, p.px, p.py));
    i.on('peel_move', (p) => this.fx.dragPeel(p.x, p.y));
    i.on('peel_end', (v) => {
      if (this.fx.endPeel(v.vx, v.vy)) {
        this.audio.play('sticker_peel');
        d.interaction('sticker_peel');
      }
    });
  }

  /** «Разбудить кота»: всё, что требует жеста в iOS, — синхронно в начале обработчика */
  async wake() {
    this.audio.unlock();
    this.voice.unlock();
    // офлайн-распознавание (~45 МБ + 2.4 МБ движок) — заранее, чтобы первое «нажми и скажи» не ждало;
    // не на «экономии трафика»
    if (!(navigator as any).connection?.saveData) setTimeout(() => void this.engine.asr.preload?.(), 3000);
    if (this.audio.maybeSilentSwitch) setTimeout(() => this.ui.toast('Не слышно кота? Проверь переключатель «Без звука» сбоку iPhone и громкость.', 5000), 2500);
    const sensors = this.input.requestSensors();
    this.ui.setStartBusy('Просыпается…');
    try {
      if (this.tracker instanceof MindARTracker) await this.tracker.startVideo();
      void sensors.then((ok) => this.director.log(`датчики: ${ok ? 'да' : 'нет'}`));
      this.ui.hideStart();
      this.director.dispatch({ type: 'wake' });
      await this.tracker.start();
      this.resize();
    } catch (e) {
      console.error(e);
      this.ui.hideStart();
      this.ui.toast('Камера не включилась. Разреши доступ к камере в настройках браузера и обнови страницу.', 8000);
    }
  }

  resize() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.renderer.setSize(w, h, false);
    this.tracker.resize(w, h);
    this.fx.resize(w, h);
  }

  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = this.frames / this.fpsT;
      this.frames = 0;
      this.fpsT = 0;
    }
    this.tracker.update(dt, this.elapsed);
    this.input.tick();
    // мурчание-петля, пока гладят
    if (this.input.touch.isStroking && (this.purrT -= dt) <= 0) {
      this.purrT = 1.7;
      this.audio.play('purr', 0.8);
    }
    this.stage.update(dt);
    this.syncPersona();
    this.director.update(dt);
    this.character.update(dt, this.tracker.camera);
    this.fx.update(dt);
    this.fx.draw();
    this.onFrame(dt);
    this.renderer.render(this.scene, this.tracker.camera);
  }
}
