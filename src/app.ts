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
import { AwakeController } from './awake';
import { Audio } from './audio/audio';
import { VoicePlayer } from './voice/voicePlayer';
import { VoiceEngine } from './voice/engine';
import { loadContent } from './persona/content';
import { Input } from './input/input';
import { UI, posterUrl } from './ui/ui';
import { buildCatalog, catalogEnv, routeItem, type CatalogItem } from './ui/actionCatalog';
import { Suggester, VOICE_GATED, type Chip } from './scenario/suggest';
import { turn } from './voice/turn';
import { Director, type ActionId } from './director';
import { HomeMode, prepareHomeFlow, type HomeHost } from './home/homeMode';
import { NAMES, normalize, matchIntent } from './voice/intents';
import { personaMeta } from './character/personaMeta';
import { CardMonitor, LumaSampler, cardScreenFrac, type CardEvent } from './tracker/cardMonitor';
import { perf, AdaptiveQuality, type QualityLevel } from './core/perf';
import { prefetchModel, warmModel } from './core/modelUrl';
import { loadMemory } from './scenario/memory';
import { progressReady } from './progress';
import { PERSONA_IDS } from './persona/types';
import { setGlRenderer } from './core/glRenderer';
import { EnergyBudget, defaultPixelRatio, fxNeedsBoost, isMobileDevice } from './core/energy';
import { isPersonaId } from './persona/types';
import { prepareFlowMemory, runFlow } from './debug/flows';
import { feature } from './config/edition';
import { SWITCH_LATER_TEXT, SwitchCooldown, cutRedirect, fxAllowed } from './config/pilot';
import { track } from './analytics';
import { startCardPaint, type CardPaint } from './card/paint';
import { paintBlocked } from './card/paintPlan';
import type { TomUiCtx } from './ui/tomMenu';
import { NO_SHIFT, fitShift, shiftCss, shiftPoint, unshiftPoint, type ViewShift } from './ui/catalogGroups';
import { ZONES } from './home/zones';
import { OrbitPointers, OrbitView, bindOrbitKeys, bindOrbitWheel, isDesktopView, isTouchDevice, noCardCameraOff, showOrbitHint, type ViewPose } from './input/orbit';

export type CharacterMode = 'sprite' | 'rig' | 'glb';
export type TrackerKind = 'card' | 'mindar' | 'debug' | '8thwall' | 'webxr' | 'nocard';

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
  // ?nocard — кот на столе без карты (камера фоном, ?nocard=off — без камеры): страница тестовых флоу /test
  // ?desktop — псевдоним ?nocard=off для Mac/ПК: кот на фирменном фоне, вращение мышью (src/input/orbit.ts)
  const t = (q.get('tracker') as TrackerKind) || (q.has('nocard') || q.has('desktop') ? 'nocard' : debug ? 'debug' : 'card');
  // ?char=hooligan|kind|glitter — выбор кота (3D); ?char=sprite|rig|glb — режим персонажа, как раньше
  const cq = q.get('char');
  const c = (cq && isPersonaId(cq) ? 'glb' : (cq as CharacterMode)) || 'glb';
  // микрофон: по умолчанию «слушаю всегда»; ?mic=ptt — по кнопке; выбор ребёнка/родителя запоминается
  let savedMic: string | null = null;
  try {
    savedMic = localStorage.getItem('ar.micMode');
  } catch {
    /* приватный режим */
  }
  // десктоп-просмотр: микрофон только по кнопке (браузер не спрашивает доступ при запуске)
  const mic = q.get('mic') || (isDesktopView(search) ? 'ptt' : savedMic || 'auto');
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
  /** сцена пробуждения кота из карты (src/awake); feature('awake') выкл. или ?awake=0 — старое появление */
  awake: AwakeController | null = null;
  /** раскраска карты (src/card/paint.ts); feature('card.paint') выкл. — null */
  paint: CardPaint | null = null;
  private clock = new THREE.Clock();
  private elapsed = 0;
  fps = 0;
  private frames = 0;
  private fpsT = 0;
  onFrame: (dt: number) => void = () => {};
  /** «Мир кота» без камеры: комната-хаб, зоны, портал (src/home) */
  home!: HomeMode;
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
    prepareHomeFlow(); // ?flow=home — без знакомства, до режиссёра (src/home)
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

    const catEnv = catalogEnv(content.intents, content.dialogs.triggers);
    this.ui = new UI(this.root, {
      onWake: () => void this.wake(),
      onMicDown: () => {
        clearInterval(this.tapTimer);
        this.engine.pttDown();
      },
      onMicUp: () => this.engine.pttUp(),
      onMicTap: () => this.tapListen(),
      onSuggest: (c) => this.runChip(c),
      onReanchor: () => this.reanchor(),
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
        this.suggest.note(id);
        this.director.action(id as ActionId);
      },
      // каталог «Что умеет кот»: только то, что работает у текущего характера; тап — как кнопка или как сказанная фраза
      // новые мини-игры — только когда их начало озвучено (иначе игра идёт молча: director.hasVoiced('rps_start'))
      catalog: () => (this.director ? { who: this.director.persona.name, sections: this.withHome(this.voicedOnly(buildCatalog(this.director.persona, catEnv))) } : null),
      onCatalogPick: (item) => this.runCatalogItem(item),
      // лист каталога открыт — кот уезжает в область над ним (ui/catalogGroups.ts fitShift), закрыт — обратно
      onCatalogLayout: (free) => this.setShiftArea(free),
      extraItems: () => this.extraItems(),
      // меню «как у Тома» (ui/tomMenu.ts): комната дома, сон, раскраска, сцены — колонки прячутся на время сцен
      uiContext: () => this.uiContext(),
      onSkipName: () => this.director.dispatch({ type: 'skip_name' }),
      onShakeButton: () => this.input.simulateShake(),
      onKids: () => {
        track('sberkids_click', { kind: 'open' });
        this.ui.showKids(true, ASSETS.sberKidsUrl);
      },
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
      const sp = new URLSearchParams(location.search), qc = sp.get('cat') ?? sp.get('char');
      const own = (ASSETS.glbByPersona as Record<string, string>)[(isPersonaId(qc) ? qc : loadMemory().persona) ?? PERSONA_IDS[0]];
      if (own) prefetchModel(own, 'high');
      prefetchModel(ASSETS.glbAnims, 'high');
      void import('./character/glbCharacter').catch(() => undefined);
    }
    this.ui.setMicMode(this.engine.mode);
    if (this.desktopView) this.ui.setWakeLabel('Позвать кота'); // без камеры: кнопка не обещает камеру
    if (typeof (this.tracker as unknown as { reanchor?: unknown }).reanchor === 'function') this.tracker.onFound(() => this.ui.showReanchor(true));
    this.catEnv = catEnv;

    // пузырь реплик держится над котом / сбоку от головы, не закрывая морду
    // (с учётом сдвига кота из-под листа каталога)
    this.ui.catRect = () => {
      const r = this.rawCatRect();
      const v = this.shift;
      if (!r || v === NO_SHIFT) return r;
      const t = shiftPoint(v, r.cx, r.top), b = shiftPoint(v, r.cx, r.bottom), hd = shiftPoint(v, r.cx, r.headY);
      return { top: t.y, bottom: b.y, cx: t.x, headY: hd.y, half: r.half * v.s };
    };
    this.bindVoice();

    await progressReady(); // память с сервера (≤ 1,5 с от старта страницы; обычно уже готова к этому моменту)
    prepareFlowMemory(); // ?flow=… — без знакомства, сразу игра (src/debug/flows.ts)
    // редакция (config/edition.ts): пробуждение в MVP; выключатель — feature('awake') / ?awake=0 (OFF_SWITCH)
    if (feature('awake') && new URLSearchParams(location.search).get('awake') !== '0') {
      this.awake = new AwakeController({
        anchor: this.tracker.anchor, aspect: this.tracker.aspect, stage: this.stage, character: () => this.character ?? null, audio: this.audio,
        root: this.root, camera: this.tracker.camera, renderer: this.renderer, log: (s) => this.director?.log(s), persona: () => this.director.persona.id,
      });
      // свечение, искры и «Ого!» при находке карты — теперь в сцене пробуждения
      const ov = (this.tracker as unknown as { overlay?: { quiet: boolean } }).overlay;
      if (ov) ov.quiet = true;
    }
    this.director = new Director({
      awake: this.awake ?? undefined,
      tracker: this.tracker, stage: this.stage, fx: this.fx, audio: this.audio, voice: this.voice, ui: this.ui,
      content, glCanvas: this.renderer.domElement, size: () => ({ w: this.root.clientWidth, h: this.root.clientHeight }),
      // окно ответа: кот спросил — микрофон слушает сам ms (mode 'echo' — повтор: запись без распознавания)
      listen: (ms, mode) => this.engine.listenFor(ms, mode),
      stopListen: () => this.engine.stopListen(),
    });
    this.applyEdition();
    await this.setCharacterMode(p.character);
    this.awake?.warm(this.scene); // шейдеры и текстуры сцены пробуждения — заранее (без рывка на «ПУФ»)
    await sfx;
    perf.mark('char');
    this.wireFx();
    // озвучка: манифест текущего характера и первые реплики сценария — заранее
    this.voice.preloadEvents(this.director.persona.id, ['point_camera', 'meet_card', 'meet_congrats', 'ask_name', 'nice_name', 'no_name', 'meet_self', 'meet_skills', 'welcome_back']);

    this.input = new Input(this.fx.canvas, {
      zoneAt: (x, y, coarse) => this.zoneAt(x, y, coarse),
      tryPeel: (x, y) => this.fx.beginPeel(x, y),
      fxDown: (x, y) => this.fx.pointerDown(x, y),
      fxMove: (x, y, px, py) => this.fx.pointerMove(x, y, px, py),
      fxUp: (x, y) => this.fx.pointerUp(x, y),
      isChoiceSticker: (x, y) => !!this.fx.stickerAt(x, y)?.choice,
    });
    this.bindInput();
    this.setupOrbit();
    this.home = new HomeMode({
      root: this.root, scene: this.scene, renderer: this.renderer, tracker: this.tracker as unknown as HomeHost['tracker'], stage: this.stage,
      director: this.director as unknown as HomeHost['director'], character: () => this.character, ui: this.ui, audio: this.audio,
      energy: this.energy, suggest: () => this.kickSuggest(), fx: this.fx,
    });
    // кот спит в кровати (src/home/bedFlow.ts): касания — к кровати (бормочет, ворочается), а не «А? Я не спал!»
    // раскраска карты: касания по коту, пока он рисует, — съедены (кисть не бросает)
    this.director.touchGate = (k, c) => !!this.paint?.onTouch() || this.home.onTouch(k, c);
    this.home.runFlow(new URLSearchParams(location.search));
    // чипы кота и подсказка (scenario/suggest.ts): по событиям режиссёра (фаза, лог = любое событие сценария),
    // пока идёт игра — ещё и шагом 330 мс (пороги тишины). В дрёме, вне игры и в скрытой вкладке опрос стоит
    this.director.on('log', () => this.kickSuggest());
    this.director.on('phase', (ph) => {
      if (ph === 'play' || ph === 'free') this.ui.setPlaying();
      this.kickSuggest();
    });
    document.addEventListener('visibilitychange', () => this.kickSuggest());
    this.kickSuggest();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
    runFlow(this);
  }

  /** слой эффектов: звук, точки кота, лог, характер (палитра, fxTuning, наклейки из content/src/*.meta.json) */
  private wireFx() {
    const fx = this.fx;
    fx.onSound = (id, v) => this.audio.play(id, v ?? 1);
    fx.onLog = (m) => this.director.log(m);
    fx.anchorFn = (n) => {
      const a = this.stage.anchorScreen(n, this.root.clientWidth, this.root.clientHeight);
      const v = this.shift;
      if (v === NO_SHIFT) return a;
      const p = shiftPoint(v, a.x, a.y);
      return { ...a, x: p.x, y: p.y, s: a.s * v.s };
    };
    // голос: уровень микрофона для echo_wave; «ушки» у кнопки, пока кот слушает; волна у уха в режиме повтора
    fx.levelFn = () => (this.engine?.mic.isOpen ? this.engine.mic.level : 0);
    let listening = false, echo = false;
    this.engine?.on('state', (st) => {
      if (st.listening !== listening) {
        listening = st.listening;
        // «ушки» у кнопки — CSS (ui.setEars), а не эффект на полноэкранном холсте: тот перерисовывался бы каждый кадр,
        // пока кот слушает (в режиме «слушаю всегда» — почти всё время)
        this.ui.setEars(listening);
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
      // 99 % — архив скачан, дальше Vosk распаковывает его в своём воркере (на iPhone — десятки секунд): «99 %» висело
      // всё это время поверх поиска карты (запись 18.11). Процент — только пока качаем, распаковка — молча
      if (s.asrState === 'loading') this.ui.micHintText(s.modelProgress < 0.99 ? `Загружаю распознавание… ${Math.round(s.modelProgress * 100)}%` : '');
      else if (s.asrState === 'listening') this.ui.micHintText(s.echo !== 'off' ? 'Говори — повторю!' : 'Слушаю…');
      else if (s.asrState === 'error')
        this.ui.micHintText(s.micError === 'not-allowed' ? 'Нет доступа к микрофону — жми лапку' : /no-model/.test(s.lastEvent) ? 'Офлайн-модель не найдена — жми лапку' : 'Не расслышал, попробуй ещё', s.micError === 'not-allowed' || /no-model/.test(s.lastEvent) ? 'warn' : 'info');
      else if (s.echo === 'waiting') this.ui.micHintText('Говори — повторю!');
      if (s.asrState === 'idle' && !s.listening && s.echo === 'off') this.ui.micLevel(0);
    });
    // уровень микрофона на кнопке — в frame() (micLevelTick): ≤ 10 раз в секунду и только при заметном изменении;
    // раньше — отдельный requestAnimationFrame-цикл, крутившийся 60 раз в секунду всегда, даже в дрёме
    e.on('state', (s) => {
      this.voiceBusy = s.catSpeaking || s.listening;
      if (s.listening) this.energy.activity(performance.now(), false);
    });
    e.on('text', ({ text, source }) => {
      this.energy.activity(performance.now());
      if (source === 'asr') this.ui.micHintText(`«${text}»`);
      this.input?.activity();
      // дома: «спать», «просыпайся», да/нет на «вздремнём?» — кровати (src/home/bedFlow.ts); «грустно/страшно» — режиссёру
      const safety = /^(sad|scared)$/.test(matchIntent(text).intent);
      if (this.home?.onText(text, safety)) return;
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

  // ───────────── чипы кота, каталог, микрофон «я говорю» ─────────────
  /** что кот предлагает (до двух чипов) и подсказка в пузыре */
  readonly suggest = new Suggester((id) => this.ui?.tried.mark(id));
  private catEnv: ReturnType<typeof catalogEnv> | null = null;
  private availCache: { persona: string; map: Map<string, { label: string; icon: string }> } | null = null;
  private available() {
    const p = this.director.persona;
    if (this.availCache?.persona !== p.id) {
      const map = new Map<string, { label: string; icon: string }>();
      if (this.catEnv) for (const s of buildCatalog(p, this.catEnv)) for (const it of s.items) if ('action' in it.run) map.set(it.id, { label: it.label, icon: it.icon });
      this.availCache = { persona: p.id, map };
    }
    return this.availCache.map;
  }
  private voiced(ev: string) {
    const d = this.director as unknown as { hasVoiced?: (e: string) => boolean };
    return d.hasVoiced ? d.hasVoiced(ev) : true;
  }
  private voicedOnly(secs: ReturnType<typeof buildCatalog>) {
    return secs
      .map((s) => ({ ...s, items: s.items.filter((it) => !('action' in it.run) || !VOICE_GATED[it.run.action] || this.voiced(VOICE_GATED[it.run.action])) }))
      .filter((s) => s.items.length);
  }
  private sugTimer = 0;
  private sugKick = false;
  /** пересчитать чипы как можно скорее (события режиссёра идут пачками — один пересчёт на пачку) */
  private kickSuggest() {
    if (this.sugKick) return;
    this.sugKick = true;
    clearTimeout(this.sugTimer);
    this.sugTimer = window.setTimeout(() => this.suggestLoop(), 0);
  }
  private suggestLoop() {
    this.sugKick = false;
    clearTimeout(this.sugTimer);
    this.sugTimer = 0;
    if (document.hidden) return; // вкладку вернули — visibilitychange
    const d = this.director;
    this.suggestTick();
    const playing = d.state.phase === 'play' || d.state.phase === 'free';
    // дрёма: чип «Разбуди меня» не меняется, пока кот не проснётся (пробуждение — событие режиссёра);
    // вне игры чипов нет (вход в игру — событие phase)
    if (d.dozing || !playing) return;
    this.sugTimer = window.setTimeout(() => this.suggestLoop(), 330);
  }
  /** подсказка этой тишины уже показана (голосом или пальцем) */
  private hintOn = false;
  private suggestTick() {
    const d = this.director;
    if (!d || !this.ui) return;
    const st = d.state, now = performance.now();
    const dlg = st.dialog;
    const node = dlg ? d.cfg.dialogs.dialogs[dlg.id]?.nodes[dlg.node] : undefined;
    // варианты ответа мини-игры (если режиссёр их знает: угадай эмоцию, камень-ножницы-бумага, повтори движение)
    const gc = (d as unknown as { gameChoices?: () => { game: string; options: { id: string; label: string }[] } | null }).gameChoices?.() ?? null;
    const r = this.suggest.update({
      now, phase: st.phase, appeared: st.appeared, game: gc ? { id: gc.game, options: gc.options } : null,
      dialog: dlg ? { id: dlg.id, node: dlg.node, listening: !!dlg.listening, expect: Object.keys(node?.on ?? {}) } : null,
      paused: st.paused, dozing: d.dozing, speaking: d.queue.busy || this.voice.speaking,
      quietMs: d.ladder.quietFor(now), visits: st.visits, available: this.available(), tried: (id) => this.ui.tried.has(id),
      voiced: (ev) => this.voiced(ev),
    });
    const chips = this.home ? this.home.chips(r.chips) : r.chips;
    // раскраска карты: чипы предложения «Раскрась! / Не сейчас»; пока кот рисует или открыт лист цветов — без чипов
    this.ui.setSuggestions(this.paint ? this.paint.chips(chips) : chips);
    // подсказка — один раз на тишину и без немого пузыря: в первые визиты кот говорит её озвученной репликой
    // («Погладь меня пальцем или нажми кнопку внизу», событие help) — чипы подпрыгивают; голоса нет
    // (или визит не первый, кот и так предлагает занятия лестницей тишины) — палец стучит по чипу
    const want = !!r.hint && !this.ui.isCatalogOpen;
    if (want && !this.hintOn) {
      this.hintOn = true;
      const voiced = r.hintFirst && d.sayHint();
      this.ui.nudge(voiced ? 'soft' : 'finger', r.hint!);
      d.log(`подсказка: ${voiced ? 'голосом (help)' : 'палец на чипе'} — ${r.hint}`);
    } else if (!want && this.hintOn) {
      this.hintOn = false;
      this.ui.nudge(null);
    }
  }
  /** чип кота: действие — как кнопка каталога, фраза — как сказанная голосом */
  runChip(c: Chip) {
    this.input.activity();
    if (c.id.startsWith('home:')) return void this.home.act(c.id);
    if (c.id.startsWith('paint:')) return void this.paint?.act(c.id);
    if ('action' in c.run) {
      this.suggest.note(c.run.action);
      this.director.action(c.run.action);
    } else this.engine.handleText(c.run.say, 'chip');
  }
  /**
   * Срез редакции (config/edition.ts → config/pilot.ts) и воронка (src/analytics): точки входа одним местом.
   * pilot.catalog — команда вырезанного действия голосом → «Давай лучше …» пузырём + чипы замены;
   * pilot.switchCooldown — смена кота не чаще раза в 3 мин («Чуть позже!»); pilot.fx — белый список эффектов.
   */
  readonly switchCooldown = new SwitchCooldown();
  private applyEdition() {
    const d = this.director;
    const bubble = (text: string) => this.ui.say(text, d.persona.name, d.persona.id, 3500);
    if (feature('pilot.catalog') || feature('pilot.switchCooldown'))
      d.intentGate = (h) => {
        if (feature('pilot.switchCooldown') && h.type === 'change_persona' && !this.switchCooldown.allow(performance.now())) {
          bubble(SWITCH_LATER_TEXT);
          d.log(`смена кота: ещё ${Math.ceil(this.switchCooldown.wait(performance.now()) / 1000)} с (пилот, раз в 3 мин)`);
          return true;
        }
        if (!feature('pilot.catalog')) return false;
        const av = this.available();
        const r = cutRedirect(d.persona.id, h.type, (id) => av.get(id)?.label);
        if (!r) return false;
        d.log(`«${h.type}» — нет в наборе пилота (${r.cut}) → ${r.chips.join(', ')}`);
        bubble(r.text);
        this.suggest.prefer(r.chips, performance.now());
        this.kickSuggest();
        return true;
      };
    if (feature('pilot.switchCooldown'))
      d.switchGate = () => {
        const now = performance.now();
        if (!this.switchCooldown.allow(now)) {
          bubble(SWITCH_LATER_TEXT);
          return false;
        }
        this.switchCooldown.mark(now);
        return true;
      };
    if (feature('pilot.fx')) d.fxGate = (pid, fx) => fxAllowed(pid, fx);
    // воронка: игры, имя (только факт), смена кота, карта найдена / потеряна, СберKids
    d.on('game', (g) => track(g.start ? 'game_start' : 'game_end', { id: g.id }));
    d.on('named', () => track('named', {}, true));
    let firstPersona = true;
    d.on('persona', (id) => {
      if (!firstPersona) track('cat_switch', { to: id });
      firstPersona = false;
    });
    let lost = 0;
    this.tracker.onFound(() => track('card_landed', { ms: performance.now() }, true));
    this.tracker.onLost(() => track('card_lost', { count: ++lost }));
    // раскраска карты (src/card/paint.ts): предложение кота, лист цветов, рисунок на карте, память
    if (feature('card.paint'))
      this.paint = startCardPaint({
        root: this.root, tracker: this.tracker, stage: this.stage, director: d, ui: this.ui, audio: this.audio,
        character: () => this.character ?? null, home: () => this.home ?? null, awakeActive: () => !!this.awake?.active,
        kickSuggest: () => this.kickSuggest(), log: (s) => d.log(s),
      });
  }

  /** «Мой дом» (на карте) / «На карту» (дома) — первым пунктом раздела «Игры» */
  private withHome(secs: ReturnType<typeof buildCatalog>): ReturnType<typeof buildCatalog> {
    const it = feature('home') ? this.home?.catalogItem() : null; // редакция: config/edition.ts
    if (!it) return secs;
    const item: CatalogItem = { ...it, run: { ui: 'home' } };
    const g = secs.find((s) => s.id === 'games');
    if (g) return secs.map((s) => (s === g ? { ...s, items: [item, ...s.items] } : s));
    return [...secs, { id: 'games' as const, title: 'Игры', icon: 'quest', items: [item] }];
  }
  /** кот на экране без сдвига (px) */
  rawCatRect() {
    if (!this.stage?.root.visible) return null;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    const top = this.stage.headScreen(w, h, 1.02), feet = this.stage.headScreen(w, h, 0), head = this.stage.anchorScreen('head', w, h);
    return { top: top.y, bottom: feet.y, cx: head.x, headY: head.y, half: Math.max(40, Math.abs(feet.y - top.y) * 0.32) };
  }
  /** сдвиг кота из-под листа каталога (transform холста) и тот, по которому сейчас попадаем касанием (на время анимации — старый) */
  shift: ViewShift = NO_SHIFT;
  private hitShift: ViewShift = NO_SHIFT;
  private hitShiftTimer = 0;
  private shiftArea: { top: number; bottom: number; left: number; right: number } | null = null;
  private shiftT = 0;
  setShiftArea(free: { top: number; bottom: number; left: number; right: number } | null) {
    this.shiftArea = free;
    this.applyShift();
  }
  private catBox = new THREE.Box3();
  private catCorner = new THREE.Vector3();
  /**
   * Экранная рамка кота без сдвига (px): проекция габаритов модели — для листа каталога. Кот целиком (уши, лапы),
   * а не приближение по голове (rawCatRect): при виде сверху кот шире, чем 0,64 высоты.
   */
  catScreenBox(): { top: number; bottom: number; cx: number; half: number } | null {
    const obj = this.character?.object;
    if (!obj || !this.stage?.root.visible) return this.rawCatRect();
    obj.updateMatrixWorld(true);
    const w = this.root.clientWidth, h = this.root.clientHeight;
    let l = Infinity, r = -Infinity, t = Infinity, btm = -Infinity, n = 0;
    const add = (v: THREE.Vector3) => {
      const c = v.project(this.stage.camera);
      const x = ((c.x + 1) / 2) * w, y = ((1 - c.y) / 2) * h;
      if (!Number.isFinite(x + y)) return;
      l = Math.min(l, x);
      r = Math.max(r, x);
      t = Math.min(t, y);
      btm = Math.max(btm, y);
      n++;
    };
    // кости скелета (поза сейчас, дёшево); без скелета — габариты модели
    obj.traverse((o) => {
      if ((o as THREE.Bone).isBone) add(o.getWorldPosition(this.catCorner));
    });
    if (n < 4) {
      const b = this.catBox.setFromObject(obj);
      if (b.isEmpty()) return this.rawCatRect();
      for (let i = 0; i < 8; i++) add(this.catCorner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    }
    if (!n) return this.rawCatRect();
    // кости — внутри тела: запас на мех, уши и кепку (голова — сверху)
    const bh = Math.max(1, btm - t), bw = Math.max(1, r - l);
    const padX = Math.max(bw * 0.18, bh * 0.12);
    return { top: t - bh * 0.22, bottom: btm + bh * 0.04, cx: (l + r) / 2, half: bw / 2 + padX };
  }
  private applyShift() {
    // кот — не крупнее, чем был (никакого приближения), целиком в области над листом; дома — только сдвиг
    const v = this.shiftArea ? fitShift(this.catScreenBox(), this.shiftArea, 8, !this.home?.inRoom) : NO_SHIFT;
    const same = (a: ViewShift, b: ViewShift) => Math.abs(a.dx - b.dx) < 2 && Math.abs(a.dy - b.dy) < 2 && Math.abs(a.s - b.s) < 0.01;
    if (same(v, this.shift) && (v === NO_SHIFT) === (this.shift === NO_SHIFT)) return;
    const prev = this.shift;
    this.shift = v;
    const c = this.renderer.domElement;
    c.style.transform = shiftCss(v);
    c.classList.toggle('shifted', v !== NO_SHIFT);
    if (v === NO_SHIFT) {
      // кот плавно возвращается: касание первые 0,35 с ещё попадает по нему там, где он виден
      c.classList.add('unshifting');
      clearTimeout(this.hitShiftTimer);
      this.hitShift = prev;
      this.hitShiftTimer = window.setTimeout(() => {
        this.hitShift = NO_SHIFT;
        c.classList.remove('unshifting');
      }, 350);
    } else this.hitShift = v;
    this.director?.log(v === NO_SHIFT ? 'каталог: кот на месте' : `каталог: кот сдвинут (${Math.round(v.dx)}, ${Math.round(v.dy)}) ×${v.s.toFixed(2)}`);
  }
  /** пункты листа/панели сверх каталога: комнаты дома (когда кот дома), «Сдёрнуть наклейки» (десктоп — вместо встряски) */
  extraItems(): { item: CatalogItem; section: string }[] {
    const out: { item: CatalogItem; section: string }[] = [];
    if (this.home?.phase === 'home')
      for (const z of ZONES) if (z.id !== this.home.zone) out.push({ item: { id: `zone:${z.id}`, label: z.title, icon: z.icon, run: { ui: 'zone' } }, section: 'world' });
    if (this.desktopView) out.push({ item: { id: 'ui:unstick', label: 'Сдёрнуть наклейки', icon: 'sticker', run: { ui: 'unstick' } }, section: 'magic' });
    // «Раскрасить карту» / «Стереть рисунок» — вкладка «Образ» (вне карты кот попросит её показать)
    if (this.paint) for (const it of this.paint.catalogItems()) out.push({ item: it, section: 'magic' });
    return out;
  }
  /** для меню «как у Тома» (feature ui.tomLayout): где кот и чем занят */
  uiContext(): TomUiCtx {
    const home = this.home, d = this.director;
    const zone = home?.phase === 'home' ? home.zone : null;
    const sleeping = !!d?.dozing || home?.bed?.state === 'asleep';
    const busy: TomUiCtx['busy'] = this.awake?.active ? 'awake' : this.paint?.painting || this.paint?.sheetOpen ? 'paint'
      : home && (home.phase === 'to_home' || home.phase === 'to_ar' || home.moving) ? 'cutscene' : sleeping ? 'sleep' : null;
    return { home: zone, sleeping, paintBlocked: this.paint ? paintBlocked(this.paint.where()) !== null : true, busy };
  }
  runCatalogItem(item: CatalogItem) {
    this.input.activity();
    if (item.id.startsWith('home:')) return void this.home.act(item.id);
    if ('action' in item.run) this.suggest.note(item.run.action);
    routeItem(item, {
      action: (id) => this.director.action(id),
      say: (t) => this.engine.handleText(t, 'chip'),
      ui: (id) => {
        if (id === 'reanchor') this.reanchor();
        else if (id === 'home') void this.home.act(item.id);
        else if (id === 'unstick') this.input.simulateShake();
        else if (id === 'zone') this.home.go(item.id.slice(5) as (typeof ZONES)[number]['id']);
        else if (id === 'paint') this.paint?.request('catalog');
        else if (id === 'paint_erase') this.paint?.erase();
        else {
          const m = this.engine.mode === 'auto' ? 'ptt' : 'auto';
          this.engine.setMode(m);
          if (m === 'auto') this.engine.resumeAuto();
          this.ui.setMicMode(m);
          this.ui.toast(m === 'auto' ? 'Кот слушает всё время — просто говори' : 'Держи микрофон и говори', 2200);
        }
      },
    });
  }
  /**
   * «Слушаю всегда» + короткое нажатие микрофона = «я говорю»: распознавание уже идёт (pttDown на нажатии, кот перебит),
   * останавливаем его не на отпускании, а когда фраза кончилась (VAD), или через 6 с тишины.
   */
  private reanchor() {
    const t = this.tracker as unknown as { reanchor?: () => void };
    t.reanchor?.();
    this.ui.toast('Наведи камеру на другую карту и подержи телефон ровно — пересажу кота', 3000);
  }
  private tapTimer = 0;
  private tapListen() {
    clearInterval(this.tapTimer);
    const t0 = performance.now();
    let spoke = false;
    this.tapTimer = window.setInterval(() => {
      const t = turn.get(), dt = performance.now() - t0;
      if (t.userSpeaking) spoke = true;
      if ((spoke && !t.userSpeaking) || (!spoke && dt > 6000) || dt > 15000) {
        clearInterval(this.tapTimer);
        this.engine.pttUp();
      }
    }, 120);
  }

  private async makeTracker(kind: TrackerKind): Promise<Tracker> {
    if (kind === 'debug') return new DebugTracker(asset(ASSETS.cardImage));
    if (kind === 'nocard') {
      const { NoCardTracker } = await import('./tracker/noCardTracker');
      return new NoCardTracker(asset(ASSETS.cardImage), this.root, !noCardCameraOff(location.search));
    }
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
    if (scanText) scanText.textContent = 'Наведи камеру на банковскую карту';
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
  private furMode = '';

  /**
   * Энергобюджет кадра: что сейчас происходит → частота рендера, потолок трекера.
   * Кадры сверх частоты пропускаются целиком (логика тоже): шаг анимаций — реальное время между кадрами.
   */
  private energyTick(now: number) {
    const tr = this.tracker as unknown as { view?: { quad: { x: number; y: number }[] } | null; isLocked?: boolean; stats?: { mode: string }; maxHz?: number; detectEvery?: number };
    // скорость карты на экране — по новым углам от трекера
    const v = tr.view;
    // дома камеры нет: карта «не едет», трекер не в беде
    if (this.home?.active) this.energy.quadSample(0);
    else if (v && v !== this.lastView) {
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
    const fxLive = this.fx.parts.list.length > 0 || this.fx.hasLive(fxNeedsBoost);
    const action = reacting || this.stage.walking || fxLive || this.fx.isPeeling || !!this.input?.touch.isStroking || !!this.awake?.active || !!this.paint?.busy;
    const out = this.energy.update({
      now,
      catVisible: this.stage.root.visible,
      action,
      talking: this.voiceBusy,
      locked: !!tr.isLocked && this.tracker.isTracking,
      trouble: !this.home?.active && ((!this.tracker.isTracking && now - this.lostAt < 3000) || tr.stats?.mode === 'plane'),
    });
    // мех: в «спокойном» и «дрёме» меньше слоёв оболочек, в дрёме не колышется (src/character/furShell.ts)
    if (out.mode !== this.furMode) {
      this.furMode = out.mode;
      void import('./character/furShell').then((m) => m.setFurEnergy(out.mode));
    }
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

  /**
   * Зона кота под пальцем (head, cheek, belly, paw, tail, body) или null — мимо кота.
   * Точная зона (касание, долгое нажатие) — луч по сетке скинованной модели: 15–20 мс на телефоне (≈ 80 мс в headless
   * при CPU×4) — раньше так проверялось и КАЖДОЕ движение пальца при поглаживании (60–120 раз в секунду: главный поток
   * занят целиком, кадры рвутся, телефон греется). coarse — только «на коте ли палец»: габаритный бокс, микросекунды.
   * Точный ответ для той же точки (касание сразу после нажатия) — из кэша (≤ 4 px, ≤ 400 мс).
   */
  zoneAt(x: number, y: number, coarse = false): TouchZone | null {
    if (!this.stage.root.visible) return null;
    const now = performance.now();
    const c = this.zoneCache;
    if (!coarse && c && now - c.t < 400 && Math.abs(c.x - x) <= 4 && Math.abs(c.y - y) <= 4) return c.zone;
    const ray = this.ray;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    // кот сдвинут из-под листа каталога — точка касания обратно в «несдвинутый» экран
    if (this.hitShift !== NO_SHIFT) ({ x, y } = unshiftPoint(this.hitShift, x, y));
    ray.setFromCamera(this.rayPt.set((x / w) * 2 - 1, -(y / h) * 2 + 1), this.stage.camera);
    this.stage.root.updateMatrixWorld(true);
    if (coarse) return (this.character.hitCoarse?.(ray) ?? this.character.hitTest(ray)) ? 'body' : null;
    if (!this.character.hitZone) return this.character.hitTest(ray) ? 'body' : null;
    const zone = this.character.hitZone(ray);
    this.zoneCache = { x, y, t: now, zone };
    return zone;
  }
  private ray = new THREE.Raycaster();
  private rayPt = new THREE.Vector2();
  private zoneCache: { x: number; y: number; t: number; zone: TouchZone | null } | null = null;

  /**
   * Событие касания кота → режиссёр. Если у характера нет реакции на это событие (старые persona-файлы),
   * — ближайшая общая реакция + клип/лицо из таблицы, чтобы тычки по зонам были видны всегда.
   */
  private touchCat(event: string, p: { x?: number; y?: number } = {}, fallback = 'tap_cat') {
    const d = this.director;
    const has = !!d.persona.reactions?.[event];
    d.interaction((has ? event : fallback) as InteractionKind, p);
    // кот спит в кровати: касание уже обработала кровать (бормочет), клип тычка на спящем не нужен
    if (this.home?.catInBed) return;
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
    // палец на коте (жест ещё не распознан): кот сразу замечает — взгляд на палец, брови вверх (character notice)
    i.on('touch_down', (p) => {
      if (this.stage.walking || this.home?.catInBed || this.director.dozing) return;
      const h = this.stage.anchorScreen('head', this.root.clientWidth, this.root.clientHeight);
      (this.character as Character & { notice?: (t: { dx: number; dy: number }) => void }).notice?.({ dx: (p.x - h.x) / h.s, dy: (p.y - h.y) / h.s });
    });
    i.on('poke_combo', (p) => {
      this.suggest.upset(performance.now());
      this.touchCat('poke_combo', p);
    });
    i.on('poke_hard', (p) => {
      this.suggest.upset(performance.now());
      this.touchCat('poke_hard', p);
    });
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
    // долгое нажатие на кота / карту: меню «Пересадить на другую карту» (эффект «к стеклу» — в каталоге, «Чудеса»);
    // трекер не умеет пересаживать — как раньше, эффект на стекле
    // стекло пальцем (feature glass.gestures, у всех котов): долгое нажатие мимо кота — стекло запотевает и по нему
    // рисуем пальцем (steam_draw: туман забирает касания, пока не растает); свайп — царапины по стеклу (claws)
    const glass = () => feature('glass.gestures') && d.state.appeared && !this.home?.active && !d.state.dialog;
    i.on('longpress', (p) => {
      if (d.state.appeared && !this.home?.active && this.ui.pressMenu(p.x, p.y)) return;
      if (glass() && !p.onCat) {
        d.activity();
        this.fx.play('steam_draw');
        d.glassMoment('fog', p);
        this.audio.play('breath', 0.7);
        d.log('стекло: запотело — рисуй пальцем (steam_draw)');
        return;
      }
      d.interaction('longpress', p);
    });
    i.on('swipe', (s) => {
      // дома: влево/вправо — соседняя комната (кот перебегает), не рисунок на стекле
      if (this.home?.onSwipe(s.dir)) return;
      if (glass()) {
        // царапины ребёнка, а кот отвечает своим клипом и репликой на свайп — без своего эффекта поверх
        this.fx.claws(s.path[0], { x: s.x, y: s.y });
        d.glassMoment('claws', s);
        this.audio.play('claws_glass', 0.8);
        d.muteFx(400);
      }
      d.interaction('swipe', { x: s.x, y: s.y, from: s.path[0], path: s.path });
    });
    i.on('shake', () => {
      if (d.state.phase !== 'switching') this.suggest.upset(performance.now());
      d.interaction('shake');
    });
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

  /** десктоп-просмотр: без камеры и карты на Mac/ПК — не ждём датчиков и камеры, микрофон по кнопке */
  readonly desktopView = isDesktopView(location.search);
  private orbitView: OrbitView | null = null;
  private hideOrbitHint: (() => void) | null = null;

  /**
   * Кот без карты (?nocard, ?desktop): площадку можно вращать — мышь (тянуть ≥ 6 px), колесо/щипок, двойной клик,
   * клавиши; на телефоне — двумя пальцами (src/input/orbit.ts). Повёрнутая площадка — кот не разворачивается к зрителю.
   */
  private setupOrbit() {
    if (this.params.tracker !== 'nocard' || !('spin' in this.tracker)) return;
    const follow = this.stage.cfg.yawFollow;
    const view = new OrbitView(this.tracker as unknown as ViewPose, (v) => {
      this.stage.cfg.yawFollow = v.spun ? false : follow;
      this.hideOrbitHint?.();
    });
    this.orbitView = view;
    const ptr = new OrbitPointers(view);
    this.input.orbit = ptr;
    bindOrbitWheel(this.fx.canvas, view, () => this.input.activity());
    bindOrbitKeys(view, () => this.input.activity());
    (window as unknown as { __orbit?: OrbitView }).__orbit = view;
  }

  /** «Разбудить кота»: всё, что требует жеста в iOS, — синхронно в начале обработчика */
  async wake() {
    track('onboarding_done', {}, true);
    // аудиосессия iOS — один раз и сразу «с микрофоном», если он будет: потом её никто не переключает
    this.audio.unlock(this.engine.mic.supported);
    this.voice.unlock();
    // «слушаю всегда»: микрофон — ПОСЛЕ камеры (два getUserMedia одновременно на iOS рвут видео)
    let micAsked = false;
    const openMic = () => {
      if (micAsked) return;
      micAsked = true;
      this.engine.resumeAuto();
    };
    // офлайн-распознавание (~45 МБ + 2.4 МБ движок) — заранее, чтобы первое «нажми и скажи» не ждало;
    // не на «экономии трафика»
    // Не во время поиска карты: распаковка модели (воркер Vosk, WASM) на iPhone забирала процессор у трекера —
    // посадка шла медленнее. Начинаем через 1,5 с после посадки кота (или через 25 с, если карты так и нет).
    if (!(navigator as any).connection?.saveData) {
      let started = false;
      const go = () => {
        if (started) return;
        started = true;
        off();
        void this.engine.asr.preload?.();
      };
      const off = this.tracker.onFound(() => setTimeout(go, 1500));
      setTimeout(go, 25_000);
    }
    if (this.audio.maybeSilentSwitch) setTimeout(() => this.ui.toast('Не слышно кота? Проверь переключатель «Без звука» сбоку iPhone и громкость.', 5000), 2500);
    // десктоп-просмотр: датчиков нет — не спрашиваем; микрофон — только по кнопке
    const desk = this.desktopView;
    const sensors = desk ? Promise.resolve(false) : this.input.requestSensors();
    if (desk) {
      micAsked = true;
      this.input.motionGranted = false;
    }
    this.ui.setStartBusy(desk ? 'Зову кота…' : 'Включаю камеру…');
    try {
      const tv = this.tracker as unknown as { startVideo?: () => Promise<void>; withAudio?: boolean; audioStream?: MediaStream | null };
      // iOS: камера и микрофон одним запросом — второй getUserMedia за микрофоном рвёт видео
      if ('withAudio' in tv) tv.withAudio = this.engine.mic.supported;
      if (typeof tv.startVideo === 'function') await tv.startVideo();
      track('camera_granted', {}, true);
      this.engine.mic.adopt(tv.audioStream ?? null);
      openMic();
      void sensors.then((ok) => {
        this.director.log(`датчики: ${desk ? 'десктоп-просмотр' : ok ? 'да' : 'нет'}`);
        if (desk) return;
        // без гироскопа кот, когда карты не видно, «едет» вместе с телефоном — скажем, как включить
        if (!ok && (window as any).DeviceOrientationEvent?.requestPermission)
          setTimeout(() => this.ui.toast('Чтобы кот стоял на месте, когда карта вне кадра, разреши «Движение и ориентация»: закрой вкладку, открой снова и нажми «Разрешить»', 7000), 6000);
      });
      this.ui.hideStart();
      this.director.dispatch({ type: 'wake' });
      // подсказка про мышь — один раз и только без касаний (телефон, iPad)
      if (this.orbitView && !isTouchDevice()) setTimeout(() => (this.hideOrbitHint = showOrbitHint(this.root)), 1500);
      await this.tracker.start();
      openMic();
      this.resize();
    } catch (e) {
      console.error(e);
      openMic();
      this.ui.hideStart();
      this.ui.error('Камера не включилась', 'Разреши доступ к камере в настройках браузера и попробуй ещё раз.');
    }
  }

  resize() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.home?.resize(w, h);
    this.renderer.setSize(w, h, false);
    this.tracker.resize(w, h);
    this.fx.resize(w, h);
    this.awake?.resize(w, h);
    this.paint?.resize(w, h);
  }

  private lvlT = 0;
  private lvlV = -1;
  /** уровень микрофона → кольцо кнопки: ≤ 10 Гц и только при изменении (стиль кнопки — перерисовка) */
  private micLevelTick(now: number) {
    const mic = this.engine?.mic;
    if (!mic?.isOpen) {
      if (this.lvlV > 0) this.ui.micLevel((this.lvlV = 0));
      return;
    }
    if (now - this.lvlT < 100) return;
    this.lvlT = now;
    // шаг 0,1 (кольцо 1,8 px) и 10 Гц: каждое новое значение — пересчёт стиля и перерисовка тени кнопки
    const v = Math.round(mic.level * 10) / 10;
    if (v !== this.lvlV) this.ui.micLevel((this.lvlV = v));
  }

  /**
   * Кадр. rAF приходит 60 (120) раз в секунду, но работа — только в кадрах, которые разрешил энергобюджет:
   * сначала дешёвая проверка due() по прошлому решению, и лишь потом пересчёт режима (energyTick) — пропущенный
   * кадр стоит одно сравнение. Касание/речь сбрасывают ожидание (energy.activity), реакция не ждёт кадра дрёмы.
   */
  private frame() {
    const now = performance.now();
    if (!this.energy.due(now)) return;
    this.energyTick(now);
    perf.count('logic');
    perf.beginFrame();
    perf.section('tracker');
    const raw = this.clock.getDelta();
    const dt = Math.min(this.energy.maxDt, raw);
    this.quality.tick(raw, this.energy.out.renderFps);
    this.elapsed += dt;
    this.frames++;
    this.fpsT += raw; // реальное время: dt обрезан energy.maxDt — при тормозах app.fps (debug, perf) завышал частоту
    if (this.fpsT >= 0.5) {
      this.fps = this.frames / this.fpsT;
      this.frames = 0;
      this.fpsT = 0;
    }
    // дома трекер и камера стоят (src/home): ни кадров камеры, ни освещённости карты
    const atHome = this.home?.inRoom ?? false;
    if (!atHome) this.tracker.update(dt, this.elapsed);
    this.home?.update(dt, now);
    if (this.director.state.appeared && !atHome) {
      this.cardMonitor.card(cardScreenFrac(this.tracker), dt * 1000);
      // освещённость меняется медленно: раз в секунду (кадр камеры 1280×720 → 32×24 — полное чтение кадра с GPU на iOS)
      if ((this.lumaT += dt) >= 1) {
        const l = this.luma.sample((this.tracker as { video?: HTMLVideoElement | null }).video);
        if (l !== null) this.cardMonitor.light(l, this.lumaT * 1000);
        this.lumaT = 0;
      }
    }
    perf.section('input');
    this.input.tick();
    this.micLevelTick(now);
    // мурчание-петля, пока гладят
    if (this.input.touch.isStroking && (this.purrT -= dt) <= 0) {
      this.purrT = 1.7;
      this.audio.play('purr', 0.8);
    }
    perf.section('stage');
    this.awake?.update(dt); // поза Stage.intro — до stage.update
    this.stage.update(dt);
    this.paint?.update(dt); // раскраска: мазок за котом, рисунок на карте, предложение кота
    this.syncPersona();
    perf.section('director');
    this.director.update(dt);
    perf.section('character');
    this.character.update(dt, this.stage.camera);
    perf.section('fx');
    this.fx.update(dt);
    this.fx.draw();
    this.onFrame(dt);
    // лист каталога открыт: кот мог пойти — сдвиг пересчитываем 4 раза в секунду
    if (this.shiftArea && (this.shiftT += dt) > 0.25) {
      this.shiftT = 0;
      this.applyShift();
    }
    perf.section('render');
    // кота (и его тени) на экране нет: один кадр — очистить холст, дальше GPU не трогаем
    const empty = !this.stage.root.visible && !this.stage.shadow.visible && !this.awake?.active && this.params.tracker !== 'webxr';
    if (!empty || !this.blankDrawn) {
      this.renderer.render(this.scene, this.stage.camera);
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
