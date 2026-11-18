/**
 * «Мир кота» без камеры (решение продакта, MVP): кот уводит ребёнка к себе домой, камера и трекер на паузе.
 *
 * Вход:  (а) карта потеряна дольше 6 с — кот предлагает «Пойдём, покажу мой дом?» (чипы «Пойдём!» / «Найду карту»);
 *        (б) сам — в лестнице тишины на карте (≈ 40 с тишины) или по пункту каталога «Мой дом»; (в) ?flow=home (страница /test).
 * Переход: вспышка-портал из кота (прыгает «в телефон») → камера освобождается (tracker.stop: видеодорожки стоп,
 *        микрофон живёт), трекер стоит, Stage смотрит на пол комнаты и камеру сцены → комната проявляется.
 * В доме: три зоны одной комнаты (кухня ← гостиная → спальня), свайп или стрелки у краёв; подпись-иконка зоны сверху;
 *        кот — тот же персонаж и режиссёр (касания, каталог, голос, эмоции, мини-игры), чипы — действие зоны.
 * Выход: кнопка «На карту» — getUserMedia повторно прямо в жесте (iOS: без второго запроса разрешения и без
 *        блокировки autoplay), трекер ищет карту с нуля, кот ждёт «у стекла».
 * Где кот (AR/дом, зона) — в памяти кота (scenario/memory.ts, поле home).
 * Кровать в спальне (уложить спать, сон, разбудить, время суток) — bedFlow.ts, функция `home.bed` (lab).
 *
 * Энергия: в доме камеры и воркера трекера нет, рендер — по энергобюджету (покой 20 к/с, обычно 30).
 */
import * as THREE from 'three';
import './home.css';
import { ZONES, DEFAULT_ZONE, zoneSpot, zoneCam, HomeOfferRule, OFFER_SHOW_MS, isZoneId, offerChips, zoneAfterSwipe, zoneIndex, type OfferWhy, type ZoneDef, type ZoneId } from './zones';
import { HOME_ICON, registerHomeIcons } from './icons';
import type { Room } from './room';
import type { Chip } from '../scenario/suggest';
import { loadMemory, saveMemory } from '../scenario/memory';
import { CAT_ICON } from '../ui/catalogIcons';
import { feature } from '../config/edition';
import { BedFlow } from './bedFlow';

export type HomePhase = 'ar' | 'to_home' | 'home' | 'to_ar';

/** то, что HomeMode берёт у приложения (app.ts) — структурно, чтобы тесты подставляли заглушки */
export interface HomeHost {
  root: HTMLElement;
  scene: THREE.Scene;
  renderer: { setClearColor(c: THREE.ColorRepresentation, a?: number): void };
  tracker: {
    anchor: THREE.Object3D;
    isTracking: boolean;
    start(): Promise<void>;
    stop(): void;
    withAudio?: boolean;
    reanchor?(): void;
  };
  stage: {
    root: THREE.Object3D;
    cfg: { yawFollow: boolean; height: number };
    useView(v: { anchor: THREE.Object3D; camera: THREE.PerspectiveCamera } | null): void;
    setMode(m: 'card' | 'glass'): void;
    resetPosition(): void;
    show(v: boolean): void;
    readonly walking: boolean;
    anchorScreen(n: 'body', w: number, h: number): { x: number; y: number };
  };
  director: {
    state: { phase: string; appeared: boolean; cardVisible: boolean; dialog: unknown; paused: boolean };
    dozing: boolean;
    /** реплика без озвучки — только пузырём (кровать: новые реплики до прогона ElevenLabs) */
    showLine?(event: string): boolean;
    ladder: { quietFor(now: number): number; reset(now: number): void };
    queue: { busy: boolean };
    dispatch(e: { type: 'card_found' } | { type: 'card_lost' } | { type: 'context_change' }): void;
    speakEvent(event: string, o?: { background?: boolean; force?: boolean }): boolean;
    hasVoiced(event: string): boolean;
    action(id: string): void;
    interaction(kind: string): void;
    activity(): void;
    log(s: string): void;
  };
  character(): { play(clip: string, o?: { loop?: boolean }): void; currentClip: string; face(p: string, ms?: number): void } | null;
  ui: { root: HTMLElement; toast(t: string, ms?: number): void; closeCatalog(): void; nudge(m: null): void; hidePressMenu(): void; error(t: string, s: string): void; canReanchor: boolean };
  audio: { play(id: string, v?: number): unknown; ctx?: AudioContext | null; muted?: boolean };
  /** эффекты (Zzz над спящим котом в кровати) */
  fx?: { play(id: string): unknown; stop?(id: string): void; kill?(pred: (id: string) => boolean): void; clearParticles?(): void; filter?: ((id: string) => boolean) | null };
  energy: { activity(now: number, boost?: boolean): void };
  /** пересчитать чипы кота */
  suggest(): void;
  /** конструктор комнаты (по умолчанию — ленивый import('./room')) */
  buildRoom?: () => Promise<Room>;
}

const PORTAL_IN_MS = 430;
const PORTAL_OUT_MS = 600;
/** бег между зонами */
const SWITCH_MS = 900;
/** миска с рыбкой стоит столько */
const BOWL_MS = 7000;

export class HomeMode {
  phase: HomePhase = 'ar';
  zone: ZoneId = DEFAULT_ZONE;
  readonly camera = new THREE.PerspectiveCamera(40, 9 / 19.5, 0.05, 60);
  room: Room | null = null;
  readonly offers = new HomeOfferRule();
  /** активное предложение «пойдём домой» */
  offer: { why: OfferWhy; until: number } | null = null;
  /** первый визит домой в этой сессии: «Это мой дом!» */
  private visited = false;
  private hud: HTMLDivElement;
  private portal: HTMLDivElement;
  private roomP: Promise<Room> | null = null;
  private timers: number[] = [];
  private lostSince = -1;
  private now = 0;
  /** перебежка между зонами: from → to, t 0..1 */
  private move: { from: ZoneDef; to: ZoneDef; t: number; dir: number } | null = null;
  private camX = 0;
  private aspect = 9 / 19.5;
  private par = { x: 0, y: 0, tx: 0, ty: 0, g0: NaN, b0: NaN };
  private onOrient = (e: DeviceOrientationEvent) => this.orient(e);
  private bowlTimer = 0;
  private savedClear = new THREE.Color(0, 0, 0);
  /** кровать в спальне (функция home.bed; null — как в MVP: «Уложить спать» = дрёма режиссёра) */
  readonly bed: BedFlow | null;
  private bedParam: string | null = null;
  private cam = { dy: 0, zoom: 1, dx: 0 };
  /** счётчики для тестов и debug: сколько раз открывали/закрывали камеру */
  readonly stats = { enter: 0, exit: 0, cameraStops: 0, cameraStarts: 0 };

  constructor(private h: HomeHost, opts: { bed?: boolean } = {}) {
    registerHomeIcons();
    this.bed = (opts.bed ?? feature('home.bed')) ? new BedFlow(h, this) : null;
    const mem = loadMemory().home;
    if (mem && isZoneId(mem.zone)) this.zone = mem.zone;
    // кот был дома, когда ребёнок закрыл вкладку — позовёт домой в первую паузу
    if (mem?.where === 'home') this.offers.pendingMemory = true;
    this.hud = document.createElement('div');
    this.hud.className = 'home-hud hidden';
    this.hud.innerHTML = `
      <button class="home-back" type="button" data-h="back" aria-label="Вернуться на карту"><i>${HOME_ICON.home_card}</i><span>На карту</span></button>
      <div class="home-zone" role="status" aria-live="polite"><span class="hz-ico"></span><span class="hz-l"></span><span class="hz-dots">${ZONES.map(() => '<i></i>').join('')}</span></div>
      <button class="home-arrow l" type="button" data-h="prev">${HOME_ICON.home_chev_l}<span class="ha-ico"></span></button>
      <button class="home-arrow r" type="button" data-h="next">${HOME_ICON.home_chev_r}<span class="ha-ico"></span></button>`;
    this.portal = document.createElement('div');
    this.portal.className = 'home-portal';
    this.portal.innerHTML = '<i></i><b></b>';
    const parent = h.ui.root;
    parent.insertBefore(this.hud, parent.firstChild);
    parent.appendChild(this.portal);
    this.hud.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-h]')?.getAttribute('data-h');
      if (a === 'back') this.exit();
      if (a === 'prev') this.go(ZONES[zoneIndex(this.zone) - 1]?.id);
      if (a === 'next') this.go(ZONES[zoneIndex(this.zone) + 1]?.id);
    });
    // модуль комнаты — заранее, в простое (сама комната строится при первом входе)
    if (!h.buildRoom) setTimeout(() => void import('./room').catch(() => undefined), 8000);
  }

  /** дома или в переходе: камера трекера не нужна, рисуем комнату */
  get active() {
    return this.phase !== 'ar';
  }
  /** комната на экране (Stage смотрит на её пол) */
  get inRoom() {
    return !!this.room && this.room.group.parent === this.h.scene;
  }
  /** кот перебегает между зонами */
  get moving() {
    return !!this.move;
  }
  /** свет комнаты сейчас (1 — день, ниже — приглушён: кот спит) */
  get lightLevel() {
    return this.room?.light ?? 1;
  }
  get zoneDef(): ZoneDef {
    return ZONES[zoneIndex(this.zone)];
  }

  private later(ms: number, fn: () => void) {
    const id = window.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== id);
      fn();
    }, ms);
    this.timers.push(id);
  }

  private loadRoom(): Promise<Room> {
    this.roomP ??= (this.h.buildRoom ? this.h.buildRoom() : import('./room').then((m) => m.buildRoom())).then((r) => (this.room = r));
    return this.roomP;
  }

  private canPlay() {
    const st = this.h.director.state;
    return st.appeared && (st.phase === 'play' || st.phase === 'free');
  }

  // ───────────── вход ─────────────
  /** «Пойдём!»: портал → комната. false — нельзя (знакомство не закончено, уже дома) */
  enter(why: string = 'button'): boolean {
    if (this.phase !== 'ar' || !this.canPlay()) return false;
    const h = this.h;
    this.phase = 'to_home';
    this.offer = null;
    this.stats.enter++;
    h.director.log(`дом: вход (${why})`);
    // другая обстановка — мини-игра (загадка и т. п.) заканчивается, её чипы («Сдаюсь») не едут в дом
    h.director.dispatch({ type: 'context_change' });
    const bz = this.bed?.beforeEnter(this.bedParam === 'morning' ? 'morning' : undefined);
    if (bz) this.zone = bz;
    h.ui.closeCatalog();
    h.ui.hidePressMenu();
    h.ui.nudge(null);
    h.energy.activity(performance.now());
    if (!this.bed?.holdsCat) h.character()?.play('jump');
    h.audio.play('whoosh_big', 0.8);
    this.portalIn();
    const room = this.loadRoom();
    this.later(PORTAL_IN_MS, () => {
      void room.then(() => {
        if (this.phase !== 'to_home') return;
        this.swapToRoom();
        this.portalOut();
        this.later(PORTAL_OUT_MS, () => {
          if (this.phase !== 'to_home') return;
          this.phase = 'home';
          this.h.suggest();
          if (!this.bed?.holdsCat) this.sayZone(!this.visited ? 'home_enter' : this.zoneDef.enterEvent);
          this.visited = true;
          if (this.bedParam) this.bed?.flow(this.bedParam);
          this.bedParam = null;
        });
      }, (e) => {
        console.error('[home] комната не построилась', e);
        this.phase = 'ar';
        this.portalOut();
      });
    });
    h.suggest();
    return true;
  }

  private swapToRoom() {
    const h = this.h, room = this.room!;
    // камера телефона больше не нужна: видеодорожки стоп (микрофон — отдельная дорожка, живёт), воркер трекера стоп
    h.tracker.stop();
    this.stats.cameraStops++;
    // режиссёр и эффекты «к стеклу» смотрят на isTracking: дома кот всегда «на месте»
    const lost = !h.director.state.cardVisible;
    h.tracker.isTracking = true;
    h.tracker.anchor.visible = false;
    h.scene.add(room.group);
    this.placeCat();
    this.camX = this.zoneDef.x;
    h.stage.useView({ anchor: room.anchor, camera: this.camera });
    h.stage.resetPosition();
    h.stage.setMode('card');
    h.stage.show(true);
    if (lost) {
      // «вот она!» про карту дома не нужно: у режиссёра карта «нашлась» молча
      (h.director as unknown as { cardLostSaid?: boolean }).cardLostSaid = false;
      h.director.dispatch({ type: 'card_found' });
    }
    h.renderer.setClearColor('#FFF3E2', 1);
    h.root.classList.add('home-on');
    h.ui.canReanchor = false;
    this.hud.classList.remove('hidden');
    this.syncHud(true);
    this.par.g0 = this.par.b0 = NaN;
    window.addEventListener('deviceorientation', this.onOrient);
    this.frame();
    room.setLight(1);
    if (this.bed?.holdsCat) this.bed.afterSwap();
    else {
      h.character()?.play('appear');
      h.audio.play('boing', 0.6);
    }
    this.remember();
  }

  // ───────────── выход ─────────────
  /**
   * «На карту»: камера открывается СРАЗУ, в этом же жесте (iOS: getUserMedia и play() — только из обработчика нажатия;
   * повторный запрос в той же вкладке разрешения не спрашивает). Трекер ищет карту с нуля, кот ждёт «у стекла».
   */
  exit(): boolean {
    if (this.phase !== 'home') return false;
    const h = this.h;
    this.phase = 'to_ar';
    this.stats.exit++;
    h.director.log('дом: выход на карту');
    h.director.dispatch({ type: 'context_change' });
    h.energy.activity(performance.now());
    h.ui.closeCatalog();
    this.move = null;
    clearTimeout(this.bowlTimer);
    // трекер: забыть старую карту и искать с нуля; камера — одна видеодорожка (микрофон уже открыт)
    h.tracker.isTracking = false;
    if ('withAudio' in h.tracker) h.tracker.withAudio = false;
    h.tracker.reanchor?.();
    this.stats.cameraStarts++;
    const started = h.tracker.start().catch((e) => {
      console.error('[home] камера не включилась', e);
      h.ui.error('Камера не включилась', 'Разреши доступ к камере в настройках браузера и попробуй ещё раз.');
    });
    void started;
    // спал — просыпается («ой, задремал»), иначе — «вернёмся к карте!»; спит в кровати — спит дальше (дремлет у карты)
    const inBed = !!this.bed?.holdsCat;
    this.bed?.onExit();
    if (inBed) h.director.log('дом: кот спит в кровати — на карте дремлет дальше');
    else if (h.director.dozing) h.director.interaction('wake_up');
    else h.director.speakEvent('home_back', { background: true });
    if (!inBed) h.character()?.play('jump');
    h.audio.play('whoosh_big', 0.8);
    this.portalIn();
    this.later(PORTAL_IN_MS, () => {
      this.swapToCard();
      this.portalOut();
      this.later(PORTAL_OUT_MS, () => {
        if (this.phase === 'to_ar') this.phase = 'ar';
        this.h.suggest();
      });
    });
    h.suggest();
    return true;
  }

  private swapToCard() {
    const h = this.h;
    window.removeEventListener('deviceorientation', this.onOrient);
    this.room?.group.removeFromParent();
    this.room?.showBowl(false);
    this.room?.setLight(1);
    h.stage.cfg.yawFollow = true;
    h.stage.useView(null);
    h.tracker.anchor.visible = true;
    h.renderer.setClearColor(this.savedClear, 0);
    h.root.classList.remove('home-on');
    h.ui.canReanchor = typeof h.tracker.reanchor === 'function';
    this.hud.classList.add('hidden');
    // карта ещё не найдена: кот ждёт у стекла, режиссёр знает, что карты нет («где карта?» — через 1,5 с)
    if (!h.tracker.isTracking) {
      h.director.dispatch({ type: 'card_lost' });
      h.stage.setMode('glass');
    }
    this.lostSince = -1;
    if (this.bed?.holdsCat) this.bed.onCard();
    else h.character()?.play('appear');
    this.remember();
  }

  // ───────────── зоны ─────────────
  /** свайп в доме: влево/вправо — соседняя зона. true — свайп съеден (кот не рисует на стекле) */
  onSwipe(dir: string): boolean {
    if (this.phase !== 'home') return false;
    if (dir !== 'left' && dir !== 'right') return false;
    const next = zoneAfterSwipe(this.zone, dir);
    if (!next) {
      // край комнаты: лёгкий «упор»
      this.bump(dir === 'left' ? 1 : -1);
      return true;
    }
    this.go(next);
    return true;
  }

  /** перейти в зону: кот перебегает вместе с камерой */
  go(id: ZoneId | undefined): boolean {
    if (!id || this.phase !== 'home' || id === this.zone || this.move) return false;
    const from = this.zoneDef;
    this.zone = id;
    const to = this.zoneDef;
    this.move = { from, to, t: 0, dir: Math.sign(zoneSpot(to).x - zoneSpot(from).x) };
    const h = this.h;
    // кот в кровати остаётся спать: камера уходит одна
    const held = !!this.bed?.holdsCat;
    if (!held && h.director.dozing) h.director.interaction('wake_up');
    h.director.activity();
    h.energy.activity(performance.now());
    if (!held) {
      h.stage.cfg.yawFollow = false;
      h.character()?.play('run', { loop: true });
    }
    h.audio.play('whoosh', 0.5);
    this.room?.showBowl(false);
    this.syncHud(true);
    this.remember();
    h.director.log(`дом: зона ${id}`);
    h.suggest();
    return true;
  }

  private bump(dir: number) {
    this.par.tx += dir * 0.6;
    this.h.audio.play('pop_soft', 0.4);
  }

  /** действие зоны (чип) */
  act(id: string): boolean {
    const h = this.h;
    const ch = h.character();
    switch (id) {
      case 'home:go':
        return this.enter(this.offer?.why ?? 'chip');
      case 'home:find':
      case 'home:later':
        this.offer = null;
        h.suggest();
        if (id === 'home:find') h.ui.toast('Наведи камеру на карту — и я выпрыгну!', 2600);
        return true;
      case 'home:back':
        return this.exit();
      case 'home:treat':
        this.room?.showBowl(true);
        h.audio.play('pop_soft', 0.6);
        clearTimeout(this.bowlTimer);
        this.bowlTimer = window.setTimeout(() => this.room?.showBowl(false), BOWL_MS);
        h.director.action('treat');
        return true;
      case 'home:cocoa':
        h.director.activity();
        h.energy.activity(performance.now());
        ch?.play('idle_kind_cocoa');
        ch?.face('happy', 2500);
        h.audio.play('chime_soft', 0.6);
        if (!h.director.speakEvent('home_cocoa')) h.director.log('дом: какао (реплика без озвучки — молча)');
        return true;
      case 'home:dance':
        h.director.action('dance');
        return true;
      case 'home:ball':
        this.room?.bounceBall();
        h.audio.play('boing', 0.5);
        h.director.action('jump');
        this.later(250, () => void h.director.speakEvent('home_ball'));
        return true;
      case 'home:sleep':
        // кровать (lab): кот залезает в кровать, одеяло, ночник — bedFlow.ts
        if (this.bed) return this.bed.act(id);
        // MVP: как «Усыпи», но без самопробуждения через 6,5 с — спит, пока ребёнок не разбудит
        // (касание или чип «Разбуди меня»); свет в спальне гаснет (update)
        h.director.interaction('sleep');
        return true;
      case 'home:wake':
      case 'home:shade':
      case 'home:to_bed':
      case 'home:bed_yes':
      case 'home:bed_no':
        return this.bed?.act(id) ?? false;
    }
    return false;
  }

  /** чипы кота: дома — действия зоны (если кот не спрашивает и не играет), на карте — предложение «пойдём домой» */
  chips(base: Chip[]): Chip[] {
    if (this.phase === 'ar') {
      if (!this.offer || this.now > this.offer.until) {
        this.offer = null;
        return base;
      }
      return offerChips(this.offer.why).map((a) => this.chip(a.id, a.label, a.icon));
    }
    if (this.phase !== 'home') return [];
    // перебежка между комнатами: чипов нет (иначе висели чипы прошлой комнаты), по прибытии — новые
    if (this.move) return [];
    const d = this.h.director;
    // кровать: спит — «Разбудить» / «Открыть шторку», залезает — без чипов, предложение «вздремнём?» — да/нет
    const bc = this.bed?.chips();
    if (bc && (this.bed!.holdsCat || !base.some((c) => !('action' in c.run)))) return bc;
    // ответы на вопрос, варианты мини-игры, «разбуди меня», поддержка — как обычно
    if (base.some((c) => !('action' in c.run)) || d.dozing || d.state.paused || d.state.dialog) return base;
    const acts = this.zoneDef.actions.map((a) => this.chip(a.id, a.label, a.icon));
    const out = acts.slice(0, 2);
    for (const c of base) if (out.length < 2 && !out.some((o) => o.label === c.label)) out.push(c);
    return out;
  }
  private chip(id: string, label: string, icon: string): Chip {
    return { id, label, icon, run: { say: '' } };
  }

  /** пункт каталога «Мой дом» / «На карту» (раздел «Игры») */
  catalogItem(): { id: string; label: string; icon: string } | null {
    if (this.phase === 'home') return { id: 'home:back', label: 'На карту', icon: 'home_card' };
    if (this.phase === 'ar' && this.canPlay()) return { id: 'home:go', label: 'Мой дом', icon: 'home_house' };
    return null;
  }

  // ───────────── кадр ─────────────
  update(dt: number, now = performance.now()) {
    this.now = now;
    const h = this.h;
    this.bed?.update(dt, now);
    if (this.phase === 'ar') {
      this.offerTick(now);
      return;
    }
    if (!this.inRoom || !this.room) return;
    const held = !!this.bed?.holdsCat;
    // перебежка между зонами
    if (this.move) {
      const m = this.move;
      m.t = Math.min(1, m.t + (dt * 1000) / SWITCH_MS);
      const k = ease(m.t);
      const a = zoneSpot(m.from), b = zoneSpot(m.to);
      // разворот по ходу бега в начале, к зрителю — в конце
      const turn = Math.min(1, m.t / 0.18, (1 - m.t) / 0.22);
      if (!held) this.placeCat(a.x + (b.x - a.x) * k, (m.dir * Math.PI) / 2 * Math.max(0, turn), a.z + (b.z - a.z) * k);
      this.camX = m.from.x + (m.to.x - m.from.x) * k;
      if (m.t >= 1) {
        this.move = null;
        if (!held) {
          h.stage.cfg.yawFollow = true;
          this.placeCat();
          h.character()?.play('idle');
          this.sayZone(this.zoneDef.enterEvent);
        }
        this.bed?.onArrive(this.zone);
        h.suggest();
      }
    }
    // свет: спит — ночь (в спальне глубже); кровать решает сама, пока кот в ней
    const ch = h.character();
    const sleeping = h.director.dozing || /^sleep/.test(ch?.currentClip ?? '');
    const bl = this.bed?.lightTarget();
    this.room.setLight(bl ?? (sleeping ? (this.zone === 'bedroom' ? 0.15 : 0.55) : 1));
    this.room.update(dt);
    // параллакс по гироскопу (плавно)
    const p = this.par;
    p.tx *= Math.exp(-dt * 3);
    p.x += (p.tx - p.x) * Math.min(1, dt * 5);
    p.y += (p.ty - p.y) * Math.min(1, dt * 5);
    this.frame();
  }

  /** кот в точке зоны (спальня — у кровати сбоку, zones.ts spot); x/z — по пути между зонами */
  private placeCat(x?: number, yaw = 0, z?: number) {
    const zd = this.zoneDef, sp = zoneSpot(zd);
    const y = this.move ? 0 : zd.floorY;
    this.room?.placeAnchor(x ?? sp.x, y, yaw, z ?? sp.z);
  }

  private sayZone(event: string) {
    const d = this.h.director;
    if (d.queue.busy || d.state.dialog) return;
    if (!d.hasVoiced(event)) {
      d.log(`дом: «${event}» без озвучки — только подпись зоны`);
      return;
    }
    d.speakEvent(event, { background: true });
  }

  private offerTick(now: number) {
    const h = this.h, d = h.director;
    const tracking = h.tracker.isTracking;
    if (tracking || !d.state.appeared) this.lostSince = -1;
    else if (this.lostSince < 0) this.lostSince = now;
    if (this.offer && now > this.offer.until) {
      this.offer = null;
      h.suggest();
    }
    if (this.offer) return;
    const why = this.offers.check({
      now, playing: this.canPlay(), home: false, cardVisible: tracking, lostSince: this.lostSince, quietMs: d.ladder.quietFor(now),
      busy: !!d.state.dialog || d.queue.busy || d.dozing || d.state.paused,
    });
    if (!why) return;
    this.offer = { why, until: now + OFFER_SHOW_MS };
    d.log(`дом: кот зовёт домой (${why})`);
    if (d.hasVoiced('home_offer')) d.speakEvent('home_offer', { background: why !== 'lost' });
    // тишина: предложение кота — тоже его инициатива, лестница с начала
    if (why === 'quiet') d.ladder.reset(now);
    h.suggest();
  }

  // ───────────── камера сцены ─────────────
  resize(w: number, h: number) {
    this.aspect = Math.max(0.2, w / Math.max(1, h));
    this.frame();
  }

  /**
   * Ракурс как у «говорящего Тома»: кот в центре во весь рост, лапы на ~72% высоты экрана (над чипами и кнопками),
   * чуть сверху (камера наклонена на 7°). Альбомная — кот крупнее, лапы ниже.
   */
  frame() {
    const cam = this.camera;
    const land = this.aspect > 1;
    cam.fov = land ? 36 : 40;
    cam.aspect = this.aspect;
    const catH = this.h.stage.cfg.height;
    const frac = land ? 0.56 : 0.42;
    const feetAt = land ? 0.8 : 0.72;
    // ракурс зоны (спальня — дальше, чтобы кровать с котом рядом помещалась целиком) + кот в кровати; плавно
    const zc = zoneCam(this.zoneDef), fb = this.bed?.frameBias() ?? { dy: 0, zoom: 1, dx: 0 };
    const c = this.cam;
    c.dy += (zc.dy + fb.dy - c.dy) * 0.08;
    c.zoom += (zc.zoom * fb.zoom - c.zoom) * 0.08;
    c.dx += (zc.dx + fb.dx - c.dx) * 0.08;
    const halfH = (catH / frac / 2) * c.zoom;
    const D = halfH / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const yc = (2 * feetAt - 1) * halfH + (this.move ? 0 : this.zoneDef.floorY) + c.dy;
    const pitch = THREE.MathUtils.degToRad(7);
    const p = this.par;
    const tx = this.camX + c.dx, tz = 0.2;
    cam.position.set(tx + p.x * 0.22, yc + Math.sin(pitch) * D + p.y * 0.12, tz + Math.cos(pitch) * D);
    cam.lookAt(tx + p.x * 0.05, yc, tz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  private orient(e: DeviceOrientationEvent) {
    if (e.gamma == null || e.beta == null) return;
    const p = this.par;
    if (Number.isNaN(p.g0)) {
      p.g0 = e.gamma;
      p.b0 = e.beta;
    }
    // база медленно подтягивается: телефон положили иначе — параллакс снова от центра
    p.g0 += (e.gamma - p.g0) * 0.004;
    p.b0 += (e.beta - p.b0) * 0.004;
    p.tx = clamp((e.gamma - p.g0) / 22, -1, 1);
    p.ty = clamp(-(e.beta - p.b0) / 28, -1, 1);
  }

  // ───────────── HUD и портал ─────────────
  private syncHud(pop = false) {
    const z = this.zoneDef, i = zoneIndex(this.zone);
    const el = this.hud.querySelector('.home-zone') as HTMLElement;
    (el.querySelector('.hz-ico') as HTMLElement).innerHTML = CAT_ICON[z.icon] ?? '';
    (el.querySelector('.hz-l') as HTMLElement).textContent = z.title;
    el.setAttribute('aria-label', `Комната: ${z.title}`);
    el.querySelectorAll('.hz-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    if (pop) {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
    const prev = ZONES[i - 1], next = ZONES[i + 1];
    const l = this.hud.querySelector('.home-arrow.l') as HTMLElement, r = this.hud.querySelector('.home-arrow.r') as HTMLElement;
    l.classList.toggle('off', !prev);
    r.classList.toggle('off', !next);
    l.setAttribute('aria-label', prev ? `В комнату: ${prev.title}` : '');
    r.setAttribute('aria-label', next ? `В комнату: ${next.title}` : '');
    (l.querySelector('.ha-ico') as HTMLElement).innerHTML = prev ? CAT_ICON[prev.icon] ?? '' : '';
    (r.querySelector('.ha-ico') as HTMLElement).innerHTML = next ? CAT_ICON[next.icon] ?? '' : '';
  }

  /** снимки и debug: вспышка портала без перехода */
  portalDemo() {
    this.portalIn();
  }
  private portalIn() {
    const w = this.h.root.clientWidth || innerWidth, hh = this.h.root.clientHeight || innerHeight;
    let at = { x: w / 2, y: hh * 0.55 };
    try {
      at = this.h.stage.anchorScreen('body', w, hh);
    } catch {
      /* кот ещё не на сцене */
    }
    const el = this.portal;
    el.style.setProperty('--px', `${Math.round(at.x)}px`);
    el.style.setProperty('--py', `${Math.round(at.y)}px`);
    el.classList.remove('out');
    el.classList.add('on');
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');
  }
  private portalOut() {
    const el = this.portal;
    el.classList.remove('in');
    el.classList.add('out');
    this.later(PORTAL_OUT_MS, () => {
      if (!el.classList.contains('in')) el.classList.remove('on', 'out');
    });
  }

  private remember() {
    const morning = loadMemory().home?.morning;
    saveMemory({ home: { where: this.phase === 'to_ar' || this.phase === 'ar' ? 'ar' : 'home', zone: this.zone, ...(morning ? { morning } : {}) } });
  }

  /** ?flow=home (страница /test): как только кот в игре — домой (&zone=kitchen|living|bedroom — сразу в зону) */
  runFlow(q: URLSearchParams) {
    if (q.get('flow') !== 'home') return;
    const z = q.get('zone');
    if (isZoneId(z)) this.zone = z;
    // &bed=sleep|wake|night|morning — кровать (src/home/bedFlow.ts)
    if (this.bed && q.get('bed')) this.bedParam = q.get('bed');
    const t0 = performance.now();
    const tick = () => {
      if (this.phase !== 'ar') return;
      if (this.canPlay() && this.enter('flow')) return;
      if (performance.now() - t0 < 120_000) setTimeout(tick, 300);
    };
    tick();
  }

  /** кот дома в кровати (спит, залезает или вылезает) */
  get catInBed(): boolean {
    return this.phase === 'home' && !!this.bed?.holdsCat;
  }
  /** касание до режиссёра (Director.touchGate): кот спит в кровати — съедаем (бормочет, ворочается) */
  onTouch(kind: string, ctx: { x?: number; y?: number } = {}): boolean {
    return this.bed?.onTouch(kind, ctx) ?? false;
  }
  /** фраза ребёнка до режиссёра: «спать», «просыпайся», да/нет на «вздремнём?» */
  onText(text: string, safety = false): boolean {
    return this.bed?.onText(text, safety) ?? false;
  }

  dispose() {
    this.bed?.dispose();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    clearTimeout(this.bowlTimer);
    window.removeEventListener('deviceorientation', this.onOrient);
    this.hud.remove();
    this.portal.remove();
    this.room?.dispose();
    this.room = null;
    this.roomP = null;
  }
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * ?flow=home (страница /test): без знакомства — память «знакомы» до создания режиссёра (как другие флоу src/debug/flows.ts).
 * Вызывать до new Director().
 */
export function prepareHomeFlow(search = typeof location !== 'undefined' ? location.search : '') {
  const q = new URLSearchParams(search);
  if (q.get('flow') !== 'home' || q.has('fresh')) return;
  const m = loadMemory();
  if (m.met) return;
  saveMemory({ met: true, persona: m.persona ?? 'hooligan', visits: Math.max(m.visits, 2), lastVisitAt: Date.now() - 3600_000 });
}
