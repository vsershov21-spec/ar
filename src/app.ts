/** Сборка приложения: выбирает реализации модулей по параметрам URL и связывает их. */
import * as THREE from 'three';
import { ASSETS, loadStage } from './config';
import { asset } from './core/util';
import type { Tracker } from './tracker/types';
import { DebugTracker } from './tracker/debugTracker';
import { MindARTracker } from './tracker/mindarTracker';
import { Stage } from './stage';
import type { Character } from './character/types';
import { SpriteCharacter } from './character/spriteCharacter';
import { RigCat } from './character/rigCat';
import { GlbCharacter } from './character/glbCharacter';
import { FxLayer } from './fx/fxLayer';
import { Audio } from './audio/audio';
import { VoicePlayer } from './voice/voicePlayer';
import { makeAsr, type Asr } from './voice/asr';
import { loadPersonas } from './persona/loader';
import { Input } from './input/input';
import { UI, posterUrl } from './ui/ui';
import { Director } from './director';

export type CharacterMode = 'sprite' | 'rig' | 'glb';
export type TrackerKind = 'mindar' | 'debug' | '8thwall' | 'webxr';

export interface AppParams {
  debug: boolean;
  tracker: TrackerKind;
  character: CharacterMode;
  asr: string | null;
}

export function readParams(search = location.search): AppParams {
  const q = new URLSearchParams(search);
  const debug = q.has('debug');
  const t = (q.get('tracker') as TrackerKind) || (debug ? 'debug' : 'mindar');
  const c = (q.get('char') as CharacterMode) || 'sprite';
  return { debug, tracker: t, character: ['sprite', 'rig', 'glb'].includes(c) ? c : 'sprite', asr: q.get('asr') };
}

export function makeCharacter(mode: CharacterMode): Character {
  if (mode === 'rig') return new RigCat();
  if (mode === 'glb') return new GlbCharacter(ASSETS.glb);
  return new SpriteCharacter(ASSETS.spriteManifest);
}

export class App {
  readonly root: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  tracker!: Tracker;
  stage!: Stage;
  fx!: FxLayer;
  audio = new Audio();
  voice!: VoicePlayer;
  speech!: Asr;
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
    this.voice = new VoicePlayer(this.audio);
    this.speech = makeAsr(p.asr, () => this.audio.ctx);
    const [personas] = await Promise.all([loadPersonas(ASSETS.personas), this.audio.load(ASSETS.sfx), this.voice.load(ASSETS.voice)]);

    this.ui = new UI(this.root, {
      onWake: () => void this.wake(),
      onMicDown: () => this.speech.start(),
      onMicUp: () => this.speech.stop(),
      onChip: (t) => {
        this.input.activity();
        this.director.text(t);
      },
      onName: (n) => this.director.dispatch({ type: 'name', name: n }),
      onSkipName: () => this.director.dispatch({ type: 'skip_name' }),
      onShakeButton: () => this.input.simulateShake(),
      onKids: () => window.open(ASSETS.sberKidsUrl, '_blank', 'noopener'),
      onMute: (m) => {
        this.audio.setMuted(m);
        this.voice.muted = m;
      },
    }, { micSupported: this.speech.supported, posterUrl: posterUrl() });

    this.speech.onInterim = (t) => this.ui.micHintText(t);
    this.speech.onState = (s, msg) => {
      if (s === 'listening') this.ui.micHintText('Слушаю…');
      if (s === 'loading') this.ui.micHintText('Загружаю распознавание…');
      if (s === 'error')
        this.ui.micHintText(msg === 'not-allowed' ? 'Нет доступа к микрофону — жми подсказки' : msg === 'no-model' ? 'Офлайн-модель не найдена — жми подсказки' : 'Не расслышал, попробуй ещё');
      if (s === 'idle') this.ui.micLevel(0);
    };
    this.speech.onLevel = (v) => this.ui.micLevel(v);
    this.speech.onResult = (t) => {
      this.ui.micHintText(`«${t}»`);
      this.director.text(t);
    };

    this.director = new Director({
      tracker: this.tracker, stage: this.stage, fx: this.fx, audio: this.audio, voice: this.voice, ui: this.ui,
      personas, glCanvas: this.renderer.domElement, size: () => ({ w: this.root.clientWidth, h: this.root.clientHeight }),
    });
    await this.setCharacterMode(p.character);

    this.input = new Input(this.fx.canvas, {
      isOnCat: (x, y) => this.hitCat(x, y),
      tryPeel: (x, y) => this.fx.beginPeel(x, y),
      isChoiceSticker: (x, y) => !!this.fx.stickerAt(x, y)?.choice,
    });
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
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
    const ch = makeCharacter(mode);
    try {
      await ch.load();
    } catch (e) {
      console.error('[character] load failed', e);
    }
    this.character?.dispose();
    this.character = ch;
    this.director.setCharacter(ch);
  }

  private hitCat(x: number, y: number) {
    if (!this.stage.root.visible) return false;
    const ray = new THREE.Raycaster();
    const w = this.root.clientWidth, h = this.root.clientHeight;
    ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.tracker.camera);
    this.stage.root.updateMatrixWorld(true);
    return this.character.hitTest(ray);
  }

  private bindInput() {
    const i = this.input, d = this.director;
    i.on('tap_cat', (p) => d.interaction('tap_cat', p));
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
    this.stage.update(dt);
    this.director.update(dt);
    this.character.update(dt, this.tracker.camera);
    this.fx.update(dt);
    this.fx.draw();
    this.onFrame(dt);
    this.renderer.render(this.scene, this.tracker.camera);
  }
}
