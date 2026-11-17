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
import { Director, type ActionId } from './director';
import { NAMES, normalize } from './voice/intents';
import { personaMeta } from './character/personaMeta';
import { CardMonitor, LumaSampler, cardScreenFrac, type CardEvent } from './tracker/cardMonitor';
import { perf, AdaptiveQuality, type QualityLevel } from './core/perf';
import { prefetchModel, warmModel } from './core/modelUrl';
import { loadMemory } from './scenario/memory';
import { PERSONA_IDS } from './persona/types';
import { setGlRenderer } from './core/glRenderer';
import { EnergyBudget, defaultPixelRatio, isMobileDevice } from './core/energy';

export type CharacterMode = 'sprite' | 'rig' | 'glb';
export type TrackerKind = 'card' | 'mindar' | 'debug' | '8thwall' | 'webxr';

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
  const t = (q.get('tracker') as TrackerKind) || (debug ? 'debug' : 'card');
  const c = (q.get('char') as CharacterMode) || 'glb';
  // микрофон: по умолчанию «слушаю всегда»; ?mic=ptt — по кнопке; выбор ребёнка/родителя запоминается
  let savedMic: string | null = null;
  try {
    savedMic = localStorage.getItem('ar.micMode');
  } catch {
    /* приватный режим */
  }
  const mic = q.get('mic') || savedMic || 'auto';
  return { debug, tracker: t, character: ['sprite', 'rig', 'glb'].includes(c) ? c : 'sprite', asr: q.get('asr'), mic };
}

/** GLB-режим грузится лениво: GLTFLoader (и Draco, если модель сжата) не попадают в основной бандл */
export async function makeCharacter(mode: CharacterMode, personaId = ''): Promise<Character> {
  if (mode === 'rig') return new RigCat();
  if (mode === 'glb') {
    const { GlbCharacter } = await import('./character/glbCharacter');
    const custom = new URLSearchParams(location.search).get('glb');
    const own = (ASSETS.glbByPersona as Record<string, string>)[personaId] ?? ASSETS.glb;
    return new GlbCharacter(custom && /^[\w./-]+\.glb$/.test(custom) ? custom : own, ASSETS.glbAnims);
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
  /** адаптивное качество (src/core/perf.ts): ?q=0..3 — зафиксировать уровень */
  readonly quality = new AdaptiveQuality(new URLSearchParams(location.search).get('q'));
  /** энергобюджет (src/core/energy.ts): частота рендера и трекера по тому, что происходит; ?fps=N, ?energy=0|1 */
  readonly energy = makeEnergy();
  /** pixelRatio без адаптации: телефон 1,5…2 по экрану, ?dpr=N — вручную */
  private basePr() {
    const q = Number(new URLSearchParams(location.search).get('dpr'));
    if (q > 0) return Math.min(q, window.devicePixelRatio || 1);
    return defaultPixelRatio(this.root.clientWidth || innerWidth, this.root.clientHeight || innerHeight, window.devicePixelRatio || 1, isMobileDevice());
  }

  constructor(root: HTMLElement, readonly params: AppParams) {
    this.root = root;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.debug });
    this.renderer.setPixelRatio(this.basePr());
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'gl';
    setGlRenderer(this.renderer);
    // WebXR рисует кадры сессии сам — пропускать их нельзя
    if (params.tracker === 'webxr') this.energy.enabled = false;
  }

  async init() {
    const p = this.params;
    this.quality.onChange = (lvl, i) => this.applyQuality(lvl, i);
    document.addEventListener('visibilitychange', () => this.quality.pause());
    // энергобюджет: поворот телефона (гироскоп; на iOS — после разрешения «Движение и ориентация»)
    window.addEventListener('devicemotion', (e) => {
      const r = e.rotationRate;
      if (r && r.alpha != null) this.energy.gyroSample(Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0), performance.now());
    });
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
    // быстрый старт: онбординг ждёт только контент и манифест озвучки; звуки эффектов (~0,3 МБ) догружаются
    // за ним (до «Открыть камеру» их не играем), модель — сразу как онбординг на экране
    const sfx = this.audio.load(ASSETS.sfx);
    sfx.catch(() => undefined);
    const [content] = await Promise.all([loadContent(), this.voice.load(ASSETS.voice)]);

    this.ui = new UI(this.root, {
      onWake: () => void this.wake(),
      onMicDown: () => this.engine.pttDown(),
      onMicUp: () => this.engine.pttUp(),
      onReanchor: () => {
        const t = this.tracker as unknown as { reanchor?: () => void };
        t.reanchor?.();
        this.ui.toast('Наведи камеру на карту и подержи телефон ровно — пересажу кота', 3000);
      },
      onMicMode: (m) => {
        this.engine.setMode(m);
        if (m === 'auto') this.engine.resumeAuto();
        this.ui.setMicMode(m);
        this.ui.toast(m === 'auto' ? 'Кот слушает всё время — просто говори' : 'Держи кнопку и говори', 2200);
      },
      onChip: (t) => {
        this.input.activity();
        this.engine.handleText(t, 'chip');
      },
      // имя из поля ввода: как голосом — кот произносит и запоминает только имя из словаря
      onName: (n) => {
        const known = NAMES.get(normalize(n));
        this.director.dispatch({ type: 'name', name: known ?? n.trim(), known: !!known });
      },
      onAction: (id) => {
        this.input.activity();
        this.director.action(id as ActionId);
      },
      onSkipName: () => this.director.dispatch({ type: 'skip_name' }),
      onShakeButton: () => this.input.simulateShake(),
      onKids: () => this.ui.showKids(true, ASSETS.sberKidsUrl),
      onMute: (m) => {
        this.audio.setMuted(m);
        this.voice.muted = m;
        if (m) this.voice.cancel();
      },
    }, { micSupported: this.engine.asr.supported, posterUrl: posterUrl() });
    perf.mark('ui');
    // модель выбранного характера и библиотека движений: качаются, пока ребёнок листает онбординг
    // (код 3D-персонажа — параллельно, а не после звуков и режиссёра)
    if (p.character === 'glb' && !new URLSearchParams(location.search).get('glb')) {
      const own = (ASSETS.glbByPersona as Record<string, string>)[loadMemory().persona ?? PERSONA_IDS[0]];
      if (own) prefetchModel(own, 'high');
      prefetchModel(ASSETS.glbAnims, 'high');
      void import('./character/glbCharacter').catch(() => undefined);
    }
    this.ui.setMicMode(this.engine.mode);
    if (typeof (this.tracker as unknown as { reanchor?: unknown }).reanchor === 'function') this.tracker.onFound(() => this.ui.showReanchor(true));

    // пузырь реплик держится над котом / сбоку от головы, не закрывая морду
    this.ui.catRect = () => {
      if (!this.stage?.root.visible) return null;
      const w = this.root.clientWidth, h = this.root.clientHeight;
      const top = this.stage.headScreen(w, h, 1.02), feet = this.stage.headScreen(w, h, 0), head = this.stage.anchorScreen('head', w, h);
      return { top: top.y, bottom: feet.y, cx: head.x, headY: head.y, half: Math.max(40, Math.abs(feet.y - top.y) * 0.32) };
    };
    this.bindVoice();

    this.director = new Director({
      tracker: this.tracker, stage: this.stage, fx: this.fx, audio: this.audio, voice: this.voice, ui: this.ui,
      content, glCanvas: this.renderer.domElement, size: () => ({ w: this.root.clientWidth, h: this.root.clientHeight }),
      // окно ответа: кот спросил — микрофон слушает сам ms (mode 'echo' — повтор: запись без распознавания)
      listen: (ms, mode) => this.engine.listenFor(ms, mode),
      stopListen: () => this.engine.stopListen(),
    });
    await this.setCharacterMode(p.character);
    await sfx;
    perf.mark('char');
    this.wireFx();
    // озвучка: манифест текущего характера и первые реплики сценария — заранее
    this.voice.preloadEvents(this.director.persona.id, ['point_camera', 'meet_card', 'meet_congrats', 'ask_name', 'nice_name', 'no_name', 'meet_self', 'meet_skills', 'welcome_back']);

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
    // голос: уровень микрофона для echo_wave; «ушки» у кнопки, пока кот слушает; волна у уха в режиме повтора
    fx.levelFn = () => (this.engine?.mic.isOpen ? this.engine.mic.level : 0);
    let listening = false, echo = false;
    this.engine?.on('state', (st) => {
      if (st.listening !== listening) {
        listening = st.listening;
        if (listening) fx.play('listen_ears');
        else fx.stop('listen_ears');
      }
      const e = st.echo !== 'off';
      if (e !== echo) {
        echo = e;
        if (echo) fx.play('echo_wave');
        else fx.stop('echo_wave');
      }
    });
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
    // все наклейки отклеили пальцем: праздник; если экран был заклеен для смены образа — как встряска
    fx.onAllStickersGone = () => {
      const switching = this.director.state.phase === 'switching';
      this.director.interaction('stickers_all_gone' as InteractionKind);
      if (switching) this.director.interaction('shake');
    };
    fx.onStickerSeries = () => {
      if (!this.stage.walking) this.character.play('sticker_slap');
    };
  }
  private lastPersona = '';
  /** смена характера (её делает director) → графика: эффекты и скин */
  private syncPersona() {
    const p = this.director.persona;
    if (p.id === this.lastPersona) return;
    const changed = !!this.lastPersona;
    this.lastPersona = p.id;
    // в 3D у каждого характера своя модель: подменяем, движения общие (anims_v1.glb)
    if (changed && this.charMode === 'glb' && !new URLSearchParams(location.search).get('glb')) void this.setCharacterMode('glb');
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
      this.ui.setListening(s.asrState === 'listening');
      if (s.asrState === 'loading') this.ui.micHintText(`Загружаю распознавание… ${Math.round(s.modelProgress * 100)}%`);
      else if (s.asrState === 'listening') this.ui.micHintText(s.echo !== 'off' ? 'Говори — повторю!' : 'Слушаю…');
      else if (s.asrState === 'error')
        this.ui.micHintText(s.micError === 'not-allowed' ? 'Нет доступа к микрофону — жми подсказки' : /no-model/.test(s.lastEvent) ? 'Офлайн-модель не найдена — жми подсказки' : 'Не расслышал, попробуй ещё', s.micError === 'not-allowed' || /no-model/.test(s.lastEvent) ? 'warn' : 'info');
      else if (s.echo === 'waiting') this.ui.micHintText('Говори — повторю!');
      if (s.asrState === 'idle' && !s.listening && s.echo === 'off') this.ui.micLevel(0);
    });
    // уровень микрофона: ~15 раз в секунду и только при заметном изменении (раньше — стиль кнопки 60 раз в секунду
    // всё время, пока микрофон открыт: пересчёт стилей и перерисовка слоя без нужды)
    let lvlT = 0, lvlV = -1;
    const lvl = (t: number) => {
      requestAnimationFrame(lvl);
      if (!e.mic.isOpen || t - lvlT < 66) return;
      lvlT = t;
      const v = Math.round(e.mic.level * 20) / 20;
      if (v !== lvlV) this.ui.micLevel((lvlV = v));
    };
    requestAnimationFrame(lvl);
    e.on('state', (s) => {
      this.voiceBusy = s.catSpeaking || s.listening;
      if (s.listening) this.energy.activity(performance.now(), false);
    });
    e.on('text', ({ text, source }) => {
      this.energy.activity(performance.now());
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
    if (kind === 'mindar') return new MindARTracker(this.root, asset(ASSETS.target));
    // по умолчанию — любая банковская карта (без маркера); рамка прилипает к карте, когда она найдена
    const { CardTracker } = await import('./tracker/cardTracker');
    document.querySelector('.scan')?.classList.add('free');
    const scanText = document.querySelector('.scan span');
    if (scanText) scanText.textContent = 'Положи карту на стол и наведи камеру';
    return new CardTracker(this.root);
  }

  private charMode: CharacterMode = 'sprite';
  async setCharacterMode(mode: CharacterMode) {
    this.charMode = mode;
    const ch = await makeCharacter(mode, this.director.persona.id);
    try {
      await ch.load();
    } catch (e) {
      console.error('[character] load failed', e);
    }
    this.character?.dispose();
    this.character = ch;
    this.director.setCharacter(ch);
    this.applyQuality(this.quality.current, this.quality.level);
    this.quality.pause();
    this.precompile();
  }

  /**
   * Шейдеры кота — заранее, пока ребёнок на онбординге (KHR_parallel_shader_compile — без блокировки):
   * иначе первый кадр с котом ждёт компиляции 0,1–0,5 с на телефоне. Кот на сцене ещё скрыт — показываем
   * его только на время вызова (компиляция обходит видимые объекты).
   */
  private precompile() {
    const root = this.stage.root;
    if (root.visible) return;
    root.visible = true;
    try {
      void this.renderer.compileAsync(this.scene, this.tracker.camera).catch(() => undefined);
    } catch {
      /* старый браузер — скомпилирует при первом кадре, как раньше */
    } finally {
      root.visible = false;
    }
  }

  /** адаптивное качество: чёткость рендера, слои меха, частота трекера */
  private applyQuality(lvl: QualityLevel, i: number) {
    const pr = Math.min(this.basePr(), lvl.dprCap);
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 1e-3) {
      this.renderer.setPixelRatio(pr);
      if (this.tracker) this.resize();
    }
    if (this.character) void import('./character/furShell').then((m) => m.setFurQuality(this.character.object, lvl.fur));
    this.qualityTrackerHz = lvl.trackerHz; // вместе с энергобюджетом — в frame()
    if (i > 0 || this.loggedQ) {
      this.loggedQ = true;
      this.director?.log(`качество: уровень ${i} (pixelRatio ${pr.toFixed(2)}, мех ×${lvl.fur}, трекер ${lvl.trackerHz || '—'} Гц)`);
    }
  }
  private loggedQ = false;
  private qualityTrackerHz = 0;
  private voiceBusy = false;
  /** холст уже очищен кадром без кота — следующие пустые кадры не рисуем */
  private blankDrawn = false;
  private lastView: unknown = null;
  private lastViewQuad: { x: number; y: number }[] | null = null;
  private lastViewT = 0;
  private lostAt = -1e9;
  private wasTracking = false;
  private lastClip = 'idle';
  private clipSince = 0;
  private dozing = false;

  /**
   * Энергобюджет кадра: что сейчас происходит → частота рендера, потолок трекера.
   * Кадры сверх частоты пропускаются целиком (логика тоже): шаг анимаций — реальное время между кадрами.
   */
  private energyTick(now: number) {
    const tr = this.tracker as unknown as { view?: { quad: { x: number; y: number }[] } | null; isLocked?: boolean; stats?: { mode: string }; maxHz?: number; detectEvery?: number };
    // скорость карты на экране — по новым углам от трекера
    const v = tr.view;
    if (v && v !== this.lastView) {
      if (this.lastViewQuad && now > this.lastViewT) {
        const q = v.quad, p = this.lastViewQuad;
        const diag = Math.max(1, Math.hypot(q[0].x - q[2].x, q[0].y - q[2].y));
        let d = 0;
        for (let k = 0; k < 4; k++) d = Math.max(d, Math.hypot(q[k].x - p[k].x, q[k].y - p[k].y));
        this.energy.quadSample(d / diag / ((now - this.lastViewT) / 1000));
      }
      this.lastView = v;
      this.lastViewQuad = v.quad.map((p) => ({ x: p.x, y: p.y }));
      this.lastViewT = now;
    }
    if (this.wasTracking && !this.tracker.isTracking) this.lostAt = now;
    this.wasTracking = this.tracker.isTracking;
    const ch = this.character;
    const clip = ch?.currentClip ?? 'idle';
    if (clip !== this.lastClip) {
      this.lastClip = clip;
      this.clipSince = now;
    }
    // реакция (не idle-вариант и не сон) — первые 4 с клипа; длинные петли (танец, сон) дальше идут на обычной частоте
    const reacting = !/^idle|sleep/.test(clip) && now - this.clipSince < 4000;
    const fxLive = this.fx.parts.list.length > 0 || this.fx.activeIds.some((id) => id !== 'listen_ears' && id !== 'echo_wave');
    const action = reacting || this.stage.walking || fxLive || this.fx.isPeeling || !!this.input?.touch.isStroking;
    const out = this.energy.update({
      now,
      catVisible: this.stage.root.visible,
      action,
      talking: this.voiceBusy,
      locked: !!tr.isLocked && this.tracker.isTracking,
      trouble: (!this.tracker.isTracking && now - this.lostAt < 3000) || tr.stats?.mode === 'plane',
    });
    if ((out.mode === 'doze') !== this.dozing) {
      this.dozing = out.mode === 'doze';
      this.director?.log(this.dozing ? 'энергия: кот дремлет (60 с без касаний, речи и движения) — минимальные частоты' : 'энергия: проснулся');
    }
    if ('maxHz' in tr) {
      const q = this.qualityTrackerHz, e = out.trackerHz;
      tr.maxHz = q && e ? Math.min(q, e) : q || e;
      tr.detectEvery = out.detectEvery;
    }
  }

  /** модели других характеров — в HTTP-кэш, когда кот уже на экране и сеть свободна (смена образа без ожидания) */
  private warmed = false;
  private warmOthers() {
    if (this.warmed || this.charMode !== 'glb' || (navigator as any).connection?.saveData) return;
    this.warmed = true;
    const cur = this.director.persona.id;
    const run = () => {
      for (const [id, url] of Object.entries(ASSETS.glbByPersona as Record<string, string>)) if (id !== cur) warmModel(url);
    };
    const ric = (window as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
    setTimeout(() => (ric ? ric(run, { timeout: 5000 }) : run()), 20000);
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
  /** карта далеко/близко, темно → события режиссёру (card_far, card_close, low_light) */
  readonly cardMonitor = new CardMonitor((e) => this.cardEvent(e));
  private luma = new LumaSampler();
  private lumaT = 0;
  cardEvent(e: CardEvent) {
    this.director.log(`камера: ${e}`);
    this.director.interaction(e as unknown as InteractionKind);
  }

  private bindInput() {
    const i = this.input, d = this.director;
    i.on('activity', () => this.energy.activity(performance.now()));
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
    i.on('tap_screen', (p) => {
      d.interaction('tap_screen', p);
      // лапа тянется к точке стука (если кот не пошёл по карте)
      if (!this.stage.walking) {
        const h = this.stage.anchorScreen('head', this.root.clientWidth, this.root.clientHeight);
        this.character.reach?.({ dx: (p.x - h.x) / h.s, dy: (p.y - h.y) / h.s });
      }
    });
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
    // «слушаю всегда»: микрофон открываем в жесте (iOS), до него AudioContext спит
    this.engine.resumeAuto();
    // офлайн-распознавание (~45 МБ + 2.4 МБ движок) — заранее, чтобы первое «нажми и скажи» не ждало;
    // не на «экономии трафика»
    if (!(navigator as any).connection?.saveData) setTimeout(() => void this.engine.asr.preload?.(), 3000);
    if (this.audio.maybeSilentSwitch) setTimeout(() => this.ui.toast('Не слышно кота? Проверь переключатель «Без звука» сбоку iPhone и громкость.', 5000), 2500);
    const sensors = this.input.requestSensors();
    this.ui.setStartBusy('Включаю камеру…');
    try {
      const tv = this.tracker as unknown as { startVideo?: () => Promise<void> };
      if (typeof tv.startVideo === 'function') await tv.startVideo();
      void sensors.then((ok) => {
        this.director.log(`датчики: ${ok ? 'да' : 'нет'}`);
        // без гироскопа кот, когда карты не видно, «едет» вместе с телефоном — скажем, как включить
        if (!ok && (window as any).DeviceOrientationEvent?.requestPermission)
          setTimeout(() => this.ui.toast('Чтобы кот стоял на месте, когда карта вне кадра, разреши «Движение и ориентация»: закрой вкладку, открой снова и нажми «Разрешить»', 7000), 6000);
      });
      this.ui.hideStart();
      this.director.dispatch({ type: 'wake' });
      await this.tracker.start();
      this.resize();
    } catch (e) {
      console.error(e);
      this.ui.hideStart();
      this.ui.error('Камера не включилась', 'Разреши доступ к камере в настройках браузера и попробуй ещё раз.');
    }
  }

  resize() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.renderer.setSize(w, h, false);
    this.tracker.resize(w, h);
    this.fx.resize(w, h);
  }

  private frame() {
    const now = performance.now();
    this.energyTick(now);
    if (!this.energy.due(now)) return;
    perf.count('logic');
    perf.beginFrame();
    perf.section('tracker');
    const raw = this.clock.getDelta();
    const dt = Math.min(this.energy.maxDt, raw);
    this.quality.tick(raw, this.energy.out.renderFps);
    this.elapsed += dt;
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = this.frames / this.fpsT;
      this.frames = 0;
      this.fpsT = 0;
    }
    this.tracker.update(dt, this.elapsed);
    if (this.director.state.appeared) {
      this.cardMonitor.card(cardScreenFrac(this.tracker), dt * 1000);
      if ((this.lumaT += dt) >= 0.5) {
        const l = this.luma.sample((this.tracker as { video?: HTMLVideoElement | null }).video);
        if (l !== null) this.cardMonitor.light(l, this.lumaT * 1000);
        this.lumaT = 0;
      }
    }
    perf.section('input');
    this.input.tick();
    // мурчание-петля, пока гладят
    if (this.input.touch.isStroking && (this.purrT -= dt) <= 0) {
      this.purrT = 1.7;
      this.audio.play('purr', 0.8);
    }
    perf.section('stage');
    this.stage.update(dt);
    this.syncPersona();
    perf.section('director');
    this.director.update(dt);
    perf.section('character');
    this.character.update(dt, this.tracker.camera);
    perf.section('fx');
    this.fx.update(dt);
    this.fx.draw();
    this.onFrame(dt);
    perf.section('render');
    // кота (и его тени) на экране нет: один кадр — очистить холст, дальше GPU не трогаем
    const empty = !this.stage.root.visible && !this.stage.shadow.visible && this.params.tracker !== 'webxr';
    if (!empty || !this.blankDrawn) {
      this.renderer.render(this.scene, this.tracker.camera);
      perf.count('render');
    }
    this.blankDrawn = empty;
    perf.endFrame();
    perf.mark('loop');
    if (this.stage.root.visible && !this.warmed) {
      perf.mark('cat');
      this.warmOthers();
    }
  }
}

function makeEnergy(): EnergyBudget {
  const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const e = q.get('energy');
  return new EnergyBudget({ enabled: e === '1' || (e !== '0' && isMobileDevice()), fixedFps: Number(q.get('fps')) || 0, now: performance.now() });
}
