/**
 * Кровать кота: исполнение сценариев сна в спальне «Мира кота» (функция `home.bed`, lab — вкл., MVP — выкл.).
 * Логика (автомат, время суток, фразы) — bed.ts, модель — bedProp.ts, вход/зоны/чипы — homeMode.ts.
 *
 * Что делает: «Уложить спать» (чип спальни, голос «спать», «ложись спать», «баю-бай») — свет гаснет, кот залезает
 * в кровать, ложится на бок, одеяло накрывает, шторка опускается, ночник, колыбельная, Zzz. Во сне: тап — бормочет
 * и ворочается, три тапа подряд, чип «Разбудить», голос «просыпайся», «утро» или шторка — потягивается, одеяло
 * долой, спрыгивает, «доброе утро». Тишина ребёнка сну не мешает; уйти в другую комнату или на карту — кот спит.
 * Время суток (местные часы) — только предложения: днём «вздремнём?», вечером зевает и зовёт в кровать;
 * утром первый вход домой за день — кот ещё спит, ребёнок его будит.
 *
 * Анимации: клипы get_into_bed, lie_down_side, sleep_loop_bed, turn_over_sleep, wake_stretch_in_bed, hop_out_of_bed
 * (content/animations.json). Пока их нет в anims_v1.glb, играет клип-опора (fallback), путь корня (дуга на матрас,
 * крен на бок, спрыгнуть) — здесь, мелкие поправки костей — GlbCharacter.poseTweak. Настоящий клип — без поправок.
 * Поза лёжа (любой клип лёжа, Meshy или опора) выравнивается по матрасу и подушке (alignTick): клипы Meshy кладут тело
 * в своей системе (sleep_loop_bed — поперёк, lie_down_side — ещё иначе), поэтому поворот, наклон и место якоря считаются
 * из позы клипа, а не задаются константой. Стенд — scripts/qa/bed-stand.mjs, листы до/после — docs/qa/bed/.
 */
import * as THREE from 'three';
import type { HomeHost, HomePhase } from './homeMode';
import type { Room } from './room';
import type { Mattress } from './bedProp';
import type { ZoneId } from './zones';
import { ZONES, zoneSpot } from './zones';
import type { Chip } from '../scenario/suggest';
import { BED, BedMachine, BedOfferRule, OFFER_SHOW_MS, SLEEP_CLIP, TURN_CLIP, TURN_MS, TUCK_STEPS, WAKE_STEPS, bedIntent, daypart, isNight, localDay, morningWake, type BedOffer, type BedStep, type TuckWhy, type WakeWhy } from './bed';
import { loadMemory, saveMemory } from '../scenario/memory';
import { playLullaby, type Lullaby } from './lullaby';
import { track } from '../analytics';

/** то, что BedFlow берёт у HomeMode */
export interface BedView {
  readonly phase: HomePhase;
  readonly zone: ZoneId;
  readonly moving: boolean;
  readonly room: Room | null;
  readonly camera: THREE.PerspectiveCamera;
  go(id: ZoneId): boolean;
}

/**
 * Поза кота в кровати. Клип-опора sleep_loop — клубок «на коленях, носом в пол»: сцена кладёт его на бок креном
 * (подобрано по снимкам docs/ui/bed_*.png). Настоящий клип sleep_loop_bed (docs/animations/TZ.md) уже лежит на боку
 * головой вправо — тогда крен и поворот не нужны (REAL_LIE).
 */
export const LIE = {
  /** поворот вокруг вертикали: голова к подушке (изголовье справа, +X) */
  yaw: Math.PI / 2,
  /** крен вокруг продольной оси кота: на бок, животом и лапами к зрителю */
  roll: -Math.PI / 2,
  /** поднять корень: после крена тело кота наполовину ушло бы в матрас */
  lift: 0.13,
  /** точка опоры ближе к зрителю: тело после крена лежит от неё к стене */
  dz: 0.2,
};
/** настоящий клип «лёжа на боку»: без крена (поворот, наклон и место — alignTick по позе клипа) */
export const REAL_LIE = { yaw: 0, roll: 0, lift: 0, dz: 0 };
/** кот спит не в спальне (камера в другой комнате): свет в доме — приглушённый */
const AWAY_LIGHT = 0.55;
const NIGHT_LIGHT = 0.15;
const MORNING_LIGHT = 0.42;
/** разбудили раньше этого — «я только уснул!» (wake_forced), позже — «доброе утро» */
const SHORT_NAP_MS = 15_000;

/** эффекты, которые гасим, когда кот ложится (живут долго и закрывают спящего) */
const NOISY_FX = ['hearts_float', 'soap_bubbles', 'glitter_burst', 'confetti'];
/** кости для подгонки позы и силуэта (Mixamo без префикса) */
const BONES = ['Hips', 'Spine', 'Spine2', 'Neck', 'Head', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'];
/** капсулы тела под одеялом (голова — нет: она на подушке, открыта) */
const CAPS: [string, string][] = [
  ['Hips', 'Spine'], ['Spine', 'Spine2'], ['Spine2', 'Neck'], ['Hips', 'LeftUpLeg'], ['Hips', 'RightUpLeg'],
  ['LeftUpLeg', 'LeftLeg'], ['RightUpLeg', 'RightLeg'], ['LeftLeg', 'LeftFoot'], ['RightLeg', 'RightFoot'], ['LeftFoot', 'LeftToeBase'], ['RightFoot', 'RightToeBase'],
  ['Spine2', 'LeftArm'], ['Spine2', 'RightArm'], ['LeftArm', 'LeftForeArm'], ['RightArm', 'RightForeArm'], ['LeftForeArm', 'LeftHand'], ['RightForeArm', 'RightHand'],
];
const clampR = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** клипы, по позе которых выравниваемся (опора sleep_loop — когда клипа сна нет) */
const LYING_CLIPS = new Set(['lie_down_side', SLEEP_CLIP, TURN_CLIP, 'wake_stretch_in_bed', 'sleep_loop']);
const AX_X = new THREE.Vector3(1, 0, 0), AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);
const bedroomX = () => ZONES.find((z) => z.id === 'bedroom')!.x;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

type TweakCh = { poseTweak?: ((rot: (b: string, a: 'up' | 'side' | 'fwd', ang: number) => void, dt: number) => void) | null; procedural?: Set<string> };

export class BedFlow {
  readonly m = new BedMachine();
  readonly offers = new BedOfferRule();
  /** активное предложение кота (днём — вздремнуть, вечером — спать) */
  offer: { kind: BedOffer; until: number } | null = null;
  /** утро: кота нашли спящим — проснётся с «доброе утро» */
  morning = false;
  private pendingTuck: TuckWhy | null = null;
  private pendingWake: WakeWhy | null = null;
  private zzzOn = false;
  private turn: { t0: number; ms: number; amp: number } | null = null;
  private lull: Lullaby | null = null;
  private hourOverride: number | null = null;
  private enteredBedroom = false;
  private now = 0;
  private dozeSet = false;
  /** для debug и тестов */
  readonly stats = { tucks: 0, wakes: 0, murmurs: 0, turns: 0, zzzStarts: 0, zzzStops: 0 };

  constructor(private h: HomeHost, private v: BedView, search = typeof location !== 'undefined' ? location.search : '') {
    const q = new URLSearchParams(search);
    const hr = Number(q.get('hour'));
    if (q.has('hour') && Number.isFinite(hr)) this.hourOverride = hr;
  }

  /** местный час (или ?hour= для проверки) */
  hour(): number {
    return this.hourOverride ?? new Date().getHours();
  }
  setHour(h: number | null) {
    this.hourOverride = h;
  }

  get state() {
    return this.m.state;
  }
  /** кот в кровати (или залезает / вылезает): HomeMode не ставит его в точку зоны, перебежка — без кота */
  get holdsCat() {
    return this.m.inBed;
  }

  private log(s: string) {
    this.h.director.log(`кровать: ${s}`);
  }

  /** реплика: озвучена — голосом, нет — только пузырём (строгий режим: новые реплики ждут озвучки) */
  say(event: string, o: { background?: boolean } = {}): boolean {
    const d = this.h.director;
    if (d.hasVoiced(event)) return d.speakEvent(event, o);
    const shown = d.showLine?.(event) ?? false;
    this.log(`«${event}» без озвучки — ${shown ? 'пузырём' : 'молча'}`);
    return shown;
  }

  // ───────────── команды ─────────────

  /** «Уложить спать»: не в спальне — сначала туда (кот бежит), потом в кровать */
  tuck(why: TuckWhy = 'chip'): boolean {
    if (this.v.phase !== 'home' || this.m.state !== 'awake') return false;
    this.offer = null;
    if (this.v.zone !== 'bedroom') {
      this.pendingTuck = why;
      if (!this.v.go('bedroom')) this.pendingTuck = null;
      return true;
    }
    if (this.v.moving) {
      this.pendingTuck = why;
      return true;
    }
    return this.startTuck(why);
  }

  private startTuck(why: TuckWhy): boolean {
    const now = this.now || performance.now();
    if (!this.m.tuck(now, why)) return false;
    this.stats.tucks++;
    track('sleep'); // воронка (src/analytics)
    const h = this.h;
    // реплики кота до этого (зона, предложение) — не поверх «укрой меня»
    h.director.activity();
    h.energy.activity(now);
    h.stage.cfg.yawFollow = false;
    this.morning = false;
    // идём спать: весёлые эффекты кота (пузыри, сердечки) убираем сразу
    this.quietFx(true);
    this.enterStep(this.m.step);
    this.log(`укладываем (${why})`);
    h.suggest();
    return true;
  }

  /** разбудить: не в спальне — сначала туда (камера), потом будим */
  wake(why: WakeWhy): boolean {
    if (this.m.state !== 'asleep' && this.m.state !== 'tucking') return false;
    if (this.v.phase !== 'home') return false;
    if (this.v.zone !== 'bedroom' && why !== 'external') {
      this.pendingWake = why;
      if (!this.v.go('bedroom')) this.pendingWake = null;
      return true;
    }
    return this.startWake(why);
  }

  private startWake(why: WakeWhy): boolean {
    const now = this.now || performance.now();
    const slept = this.m.asleepSince >= 0 ? now - this.m.asleepSince : 0;
    if (this.m.state === 'tucking') this.m.sleepNow(now);
    if (!this.m.wake(now, why)) return false;
    this.stats.wakes++;
    track('wake'); // воронка (src/analytics)
    this.wakeLine = why === 'external' ? null : why === 'taps' || (!this.morning && slept < SHORT_NAP_MS) ? 'wake_forced' : 'wake_morning';
    this.afterAsleep();
    this.h.director.activity();
    this.h.energy.activity(now);
    this.enterStep(this.m.step);
    this.log(`будим (${why})`);
    this.h.suggest();
    return true;
  }
  private wakeLine: string | null = null;

  /** сон кончился (не важно как): Zzz, дрёма режиссёра, колыбельная, поправки поз */
  private afterAsleep() {
    this.quietFx(false);
    this.lull?.stop();
    this.lull = null;
    this.setZzz(false);
    const d = this.h.director;
    if (this.dozeSet) {
      this.dozeSet = false;
      d.dozing = false;
    }
    this.h.character()?.face('neutral');
  }

  /** чип (home:*) */
  act(id: string): boolean {
    switch (id) {
      case 'home:sleep':
        return this.tuck('chip');
      case 'home:wake':
        return this.wake('chip');
      case 'home:shade':
        return this.openShade();
      case 'home:to_bed':
        return this.v.go('bedroom');
      case 'home:bed_yes':
        if (!this.offer) return false;
        this.offer = null;
        return this.tuck('offer');
      case 'home:bed_no':
        this.offers.decline(this.now || performance.now());
        this.offer = null;
        this.h.suggest();
        return true;
    }
    return false;
  }

  /** шторка: спит — поднять шторку, кот просыпается от света */
  openShade(): boolean {
    if (this.m.state !== 'asleep') return false;
    this.v.room?.bed?.setShade(0);
    this.h.audio.play('whoosh', 0.4);
    return this.wake('shade');
  }

  /** чипы кровати (null — не наши: обычные чипы зоны) */
  chips(): Chip[] | null {
    if (this.v.phase !== 'home') return null;
    const c = (id: string, label: string, icon: string): Chip => ({ id, label, icon, run: { say: '' } });
    if (this.m.busy) return [];
    if (this.m.state === 'asleep') {
      if (this.v.zone !== 'bedroom') return [c('home:to_bed', 'В спальню', 'home_moon'), c('home:wake', 'Разбудить', 'home_sun')];
      const out = [c('home:wake', 'Разбудить', 'home_sun')];
      if ((this.v.room?.bed?.shade ?? 1) > 0.5) out.push(c('home:shade', 'Открыть шторку', 'home_shade'));
      return out;
    }
    if (this.offer && this.now <= this.offer.until) {
      return this.offer.kind === 'evening_yawn'
        ? [c('home:bed_yes', 'Уложить спать', 'moon'), c('home:bed_no', 'Ещё поиграем', 'no')]
        : [c('home:bed_yes', 'Вздремнём', 'moon'), c('home:bed_no', 'Не хочу', 'no')];
    }
    return null;
  }

  // ───────────── касания и голос ─────────────

  /**
   * Касание (до режиссёра). true — съедено: во сне кот не просыпается от одного тапа (бормочет, ворочается),
   * три тапа подряд будят; в переходе (залезает/вылезает) касания без ответа.
   */
  onTouch(kind: string, ctx: { x?: number; y?: number } = {}): boolean {
    if (this.v.phase !== 'home' || !this.m.inBed) return false;
    if (/^(card_|low_light|wake_up|sleep$|sticker)/.test(kind)) return false;
    const now = this.now || performance.now();
    this.h.director.activity();
    if (this.m.busy) return true;
    // тап по окну — поднять шторку
    if (kind === 'tap_screen' && ctx.x !== undefined && ctx.y !== undefined && this.v.zone === 'bedroom' && this.hitWindow(ctx.x, ctx.y)) {
      this.openShade();
      return true;
    }
    // не в спальне кота не видно: касания пустой комнаты сон не трогают
    if (this.v.zone !== 'bedroom') return true;
    const gentle = /^(stroke|longpress|whisper|purr)/.test(kind);
    const r = this.m.tap(now, gentle);
    this.log(`касание во сне (${kind}) → ${r}`);
    switch (r) {
      case 'wake':
        this.startWakeFromTaps();
        break;
      case 'turn':
        this.stats.turns++;
        this.turnOver(now, TURN_MS, 1);
        this.h.audio.play('pop_soft', 0.25);
        break;
      case 'murmur':
        this.stats.murmurs++;
        this.turnOver(now, 600, 0.35);
        this.say('asleep_murmur', { background: true });
        break;
      case 'twitch':
        this.turnOver(now, 450, 0.25);
        break;
    }
    return true;
  }
  private startWakeFromTaps() {
    // m.tap уже перевёл автомат в waking — исполнить переход
    this.stats.wakes++;
    track('wake');
    this.wakeLine = 'wake_forced';
    this.afterAsleep();
    this.enterStep(this.m.step);
    this.log('разбудили тапами');
    this.h.suggest();
  }

  private hitWindow(x: number, y: number): boolean {
    const bed = this.v.room?.bed;
    const el = this.h.root;
    const w = el.clientWidth || (typeof innerWidth !== 'undefined' ? innerWidth : 390), hh = el.clientHeight || (typeof innerHeight !== 'undefined' ? innerHeight : 844);
    if (!bed) return false;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / hh) * 2 + 1), this.v.camera);
    return bed.hitShade(ray);
  }

  /** фраза ребёнка (до режиссёра): true — кровать её поняла */
  onText(text: string, safety = false): boolean {
    if (this.v.phase !== 'home') return false;
    // «грустно», «страшно» — всегда режиссёру (он и разбудит)
    if (safety) return false;
    const it = bedIntent(text);
    if (this.offer) {
      if (it === 'yes' || it === 'sleep') return this.act('home:bed_yes');
      if (it === 'no') return this.act('home:bed_no');
    }
    if (it === 'wake' && this.m.inBed) {
      if (!this.m.busy) this.wake('voice');
      return true;
    }
    if (it === 'sleep') {
      if (this.m.inBed) return true;
      return this.tuck('voice');
    }
    if (this.m.busy) return true;
    if (this.m.state === 'asleep') {
      // любая другая фраза — как тихое касание: бормочет во сне, не просыпается
      this.onTouch('whisper');
      return true;
    }
    return false;
  }

  // ───────────── вход, выход, перебежки ─────────────

  /** HomeMode.enter, до комнаты: утро — кот ещё спит (зона → спальня); уже спал (ушли на карту) — в кровать */
  beforeEnter(force?: 'morning'): ZoneId | null {
    const now = performance.now();
    if (this.m.state === 'waking') this.m.reset();
    if (this.m.state === 'tucking') this.m.sleepNow(now);
    if (this.m.state === 'asleep') return 'bedroom';
    const mem = loadMemory().home;
    const today = localDay(new Date());
    if (force === 'morning' || morningWake(this.hour(), today, mem?.morning)) {
      this.m.sleepNow(now, 'flow');
      this.morning = true;
      saveMemory({ home: { where: mem?.where ?? 'home', zone: 'bedroom', morning: today } });
      this.log('утро: кот ещё спит в кровати');
      return 'bedroom';
    }
    return null;
  }

  /** комната на экране (после портала): кот в кровати спящим */
  afterSwap() {
    if (this.m.state !== 'asleep') return;
    this.asleepVisuals(true);
  }

  /** кот спит: петля сна, лицо, дрёма режиссёра (лестница тишины молчит), Zzz, свет */
  private asleepVisuals(instant = false) {
    const h = this.h, d = h.director;
    this.quietFx(true);
    this.setTweak('asleep');
    h.stage.cfg.yawFollow = false;
    h.character()?.play(SLEEP_CLIP, { loop: true });
    h.character()?.face('sleep');
    d.dozing = true;
    this.dozeSet = true;
    const bed = this.v.room?.bed;
    bed?.setCover(1);
    bed?.setHump(1);
    bed?.setShade(1);
    bed?.setLamp(this.morning ? 0 : 1);
    if (instant) this.v.room?.setLight(this.lightTarget() ?? 1);
  }

  /** перебежка кончилась (HomeMode): отложенные «уложить» / «разбудить», вход в спальню — повод предложить */
  onArrive(zone: ZoneId) {
    if (zone !== 'bedroom') return;
    this.enteredBedroom = true;
    const t = this.pendingTuck, w = this.pendingWake;
    this.pendingTuck = this.pendingWake = null;
    if (t) this.startTuck(t);
    else if (w) this.startWake(w);
  }

  /** «На карту»: кот спит дальше (на карте — дремлет: касание разбудит); колыбельная и Zzz комнаты — стоп */
  onExit() {
    this.lull?.stop();
    this.lull = null;
    this.offer = null;
    this.pendingTuck = this.pendingWake = null;
    if (this.m.state === 'tucking') this.m.sleepNow(this.now || performance.now());
    if (this.m.state === 'waking') {
      this.m.reset();
      this.afterAsleep();
    }
    this.setTweak(null);
    this.setZzz(false);
  }
  /** уже на карте: спящий кот дремлет у карты */
  onCard() {
    if (this.m.state !== 'asleep') return;
    this.h.character()?.play('sleep_loop', { loop: true });
    this.h.character()?.face('sleep');
  }

  // ───────────── кадр ─────────────

  update(_dt: number, now: number) {
    this.now = now;
    const h = this.h, d = h.director, v = this.v;
    // на карте: режиссёр разбудил кота (касание) — сон кончился
    if (v.phase === 'ar') {
      if (this.m.state === 'asleep' && !d.dozing) {
        this.m.reset();
        this.quietFx(false);
        this.dozeSet = false;
        this.log('проснулся на карте');
      }
      this.syncZzz();
      return;
    }
    if (v.phase !== 'home') {
      this.syncZzz();
      return;
    }
    // во сне режиссёр сам разбудил кота (кнопка каталога, фраза): быстро спрыгнуть и выполнить
    if (this.m.state === 'asleep' && this.dozeSet && !d.dozing) {
      this.dozeSet = false;
      this.log('проснулся по команде ребёнка');
      if (v.zone === 'bedroom') this.startWake('external');
      else {
        this.m.reset();
        this.afterAsleep();
        this.toFloor();
      }
    }
    for (const e of this.m.tick(now)) {
      if (e.step) this.enterStep(e.step);
      if (e.done === 'asleep') this.onAsleep();
      if (e.done === 'awake') this.onAwake();
    }
    if (this.m.inBed && v.room) {
      this.alignTick(now);
      this.pose(now);
      this.fitPose(now);
    } else this.lastT = now;
    if (this.turn && now - this.turn.t0 > this.turn.ms) {
      if (this.turn.amp >= 1 && this.m.state === 'asleep') h.character()?.play(SLEEP_CLIP, { loop: true });
      this.turn = null;
    }
    this.syncZzz();
    this.offerTick(now);
  }

  /** вход в шаг перехода: клип, одеяло, свет, реплика */
  private enterStep(st: BedStep | null) {
    if (!st) return;
    const h = this.h, bed = this.v.room?.bed, ch = h.character();
    ch?.play(st.clip, { loop: true });
    this.setTweak(st.id);
    switch (st.id) {
      case 'approach':
        bed?.setCover(0);
        bed?.setHump(0);
        h.audio.play('bleep', 0.25);
        break;
      case 'get_into_bed':
        h.audio.play('boing', 0.4);
        break;
      case 'lie_down_side':
        // над засыпающим и спящим котом — только Zzz: сердечки, пузыри, эмоции реакций убираем и не пускаем
        this.quietFx(true);
        bed?.setShade(1);
        bed?.setLamp(1);
        bed?.setHump(1);
        ch?.face('sleepy');
        break;
      case 'cover': {
        // одеяло натягивается от изножья до плеч (~0,8 с) уже по лежащему коту
        bed?.setCover(1);
        bed?.setHump(1);
        h.audio.play('whoosh', 0.3);
        const night = isNight(this.hour()) || this.m.tuckWhy === 'offer' && daypart(this.hour()) === 'evening';
        this.say(night ? 'goodnight' : 'tuck_in');
        this.startLullaby();
        break;
      }
      case 'uncover':
        // пробуждение начинается с одеяла: откидывается к изножью, кот ещё лежит; шторка вверх, ночник гаснет
        this.setZzz(false);
        this.quietFx(false);
        bed?.setCover(0);
        bed?.setShade(0);
        bed?.setLamp(0);
        h.audio.play('whoosh', 0.3);
        ch?.face('sleepy');
        break;
      case 'wake_stretch_in_bed':
        bed?.setCover(0);
        break;
      case 'hop_out_of_bed':
        bed?.setCover(0);
        bed?.setHump(0);
        h.audio.play('boing', 0.4);
        break;
      case 'walk_back':
        bed?.setHump(0);
        break;
    }
  }

  private onAsleep() {
    this.setTweak('asleep');
    this.asleepVisuals();
    this.log('спит');
    this.h.suggest();
  }

  private onAwake() {
    const h = this.h;
    this.setTweak(null);
    this.toFloor();
    const line = this.wakeLine;
    this.wakeLine = null;
    this.morning = false;
    if (line) this.say(line);
    this.log('проснулся, на полу');
    h.suggest();
  }

  /** кот снова на полу в точке спальни, лицом к зрителю */
  private toFloor() {
    const h = this.h;
    h.stage.cfg.yawFollow = true;
    const sp = zoneSpot(ZONES.find((z) => z.id === 'bedroom')!);
    if (this.v.zone === 'bedroom') this.v.room?.placeAnchor(sp.x, 0, 0, sp.z);
    h.character()?.play('idle');
    h.character()?.face('neutral');
    const bed = this.v.room?.bed;
    bed?.setCover(0);
    bed?.setHump(0);
    bed?.setLamp(0);
    bed?.setShade(0);
  }

  private startLullaby() {
    const a = this.h.audio as HomeHost['audio'] & { ctx?: AudioContext | null; muted?: boolean };
    if (!a.ctx || a.muted) return;
    try {
      const out = (globalThis as unknown as { Howler?: { masterGain?: AudioNode } }).Howler?.masterGain ?? a.ctx.destination;
      this.lull?.stop();
      this.lull = playLullaby(a.ctx, out);
    } catch {
      this.lull = null;
    }
  }

  /** ворочается во сне: приподнять и качнуть корень (amp 1 — переворот с клипом turn_over_sleep) */
  private turnOver(now: number, ms: number, amp: number) {
    this.turn = { t0: now, ms, amp };
    if (amp >= 1) this.h.character()?.play(TURN_CLIP, { loop: true });
  }

  /**
   * Путь кота (root motion сцены). Уложить: со своего места у изножья идёт вдоль кровати к длинному краю, поворачивается
   * к ней, дугой забирается на матрас, ложится на бок головой к подушке (крен — только для клипа-опоры). Разбудить —
   * наоборот: лёжа (одеяло уже откинуто) → садится на край лицом к зрителю → спрыгивает на пол у кровати → идёт на место.
   * Якорь комнаты двигается, клип играет на месте; поза лёжа подгоняется по костям (fit: ровно на матрасе, голова на подушке).
   */
  private pose(now: number) {
    const room = this.v.room!, bed = room.bed;
    const spot = bed?.spot ?? new THREE.Vector3(bedroomX() + BED.dx + 0.1, BED.top, BED.z + 0.04);
    const sp = zoneSpot(ZONES.find((z) => z.id === 'bedroom')!);
    const stand = new THREE.Vector3(sp.x, 0, sp.z);
    const front = BED.z + BED.width / 2;
    // пол у длинного края кровати, напротив места сна
    const side = new THREE.Vector3(spot.x - 0.15, 0, front + 0.2);
    // сидит на краю матраса
    const edge = new THREE.Vector3(spot.x - 0.05, BED.top, front - 0.14);
    const p = this.m.progress(now);
    const L = this.isProc(SLEEP_CLIP) ? LIE : REAL_LIE;
    // поза лёжа — по матрасу (alignTick: ось тела вдоль кровати, голова на подушке, тело на простыне); пока не мерили —
    // запас из точки сна
    const A = this.al;
    const lie = A.ok ? { x: A.x, y: A.y, z: A.z, yaw: A.yaw, roll: L.roll, tilt: A.tilt } : { x: spot.x, y: spot.y + L.lift, z: spot.z + L.dz, yaw: L.yaw, roll: L.roll, tilt: 0 };
    let x = stand.x, y = 0, z = stand.z, yaw = 0, roll = 0, tilt = 0;
    const id = p.step?.id;
    const k = p.k;
    const lying = () => ({ x: lie.x, y: lie.y, z: lie.z, yaw: lie.yaw, roll: lie.roll, tilt: lie.tilt });
    /** насколько кот сейчас «лежит» (0..1): подгонка позы и силуэт одеяла */
    let w = 0;
    if (p.state === 'asleep' || id === 'cover' || id === 'uncover') {
      ({ x, y, z, yaw, roll, tilt } = lying());
      w = 1;
    } else if (id === 'approach') {
      // разворот вправо (идёт вдоль кровати) → шаги → поворот спиной к зрителю, к кровати
      const e = ease(clamp01(k / 0.8));
      x = lerp(stand.x, side.x, e);
      z = lerp(stand.z, side.z, e);
      yaw = k < 0.8 ? (Math.PI / 2) * clamp01(k / 0.15) : lerp(Math.PI / 2, Math.PI, ease((k - 0.8) / 0.2));
    } else if (id === 'get_into_bed') {
      const e = ease(k);
      x = lerp(side.x, lie.x, e);
      z = lerp(side.z, lie.z, e);
      // дуга прыжка — для опоры jump; настоящий клип (Meshy) забирается сам — только путь
      y = lerp(0, lie.y, ease(clamp01(k * 1.4))) + (this.isProc('get_into_bed') ? Math.sin(Math.PI * clamp01(k * 1.15)) * 0.3 : 0);
      yaw = lerp(Math.PI, lie.yaw > Math.PI / 4 ? lie.yaw : lie.yaw + Math.PI * 2, ease(clamp01((k - 0.4) / 0.6)));
    } else if (id === 'lie_down_side') {
      const e = ease(k);
      ({ x, y, z, yaw } = lie);
      // крен на бок — для опоры; настоящий lie_down_side ложится на бок сам (крен сна — тот, что у позы сна)
      const procLie = this.isProc('lie_down_side');
      roll = procLie ? lie.roll * e : lie.roll;
      tilt = procLie ? lie.tilt * e : lie.tilt;
      w = e;
    } else if (id === 'wake_stretch_in_bed') {
      // треть шага — лёжа (потягивается), потом садится на край лицом к зрителю
      const kk = ease(clamp01((k - 0.35) / 0.6));
      x = lerp(lie.x, edge.x, kk);
      y = lerp(lie.y, edge.y, kk);
      z = lerp(lie.z, edge.z, kk);
      yaw = lerp(lie.yaw, 0, kk);
      roll = lie.roll * (1 - kk);
      tilt = lie.tilt * (1 - kk);
      w = 1 - kk;
      // сел — сложенное у изножья одеяло ложится ровно
      if (k > 0.35) bed?.setHump(0);
    } else if (id === 'hop_out_of_bed') {
      const e = ease(k);
      x = lerp(edge.x, side.x, e);
      z = lerp(edge.z, side.z, e);
      y = lerp(edge.y, 0, ease(clamp01((k - 0.15) / 0.85))) + (this.isProc('hop_out_of_bed') ? Math.sin(Math.PI * k) * 0.25 : 0);
    } else if (id === 'walk_back') {
      // к своему месту у изножья (влево), в конце — лицом к зрителю
      const e = ease(clamp01(k / 0.8));
      x = lerp(side.x, stand.x, e);
      z = lerp(side.z, stand.z, e);
      yaw = k < 0.8 ? (-Math.PI / 2) * clamp01(k / 0.15) : lerp(-Math.PI / 2, 0, ease((k - 0.8) / 0.2));
    }
    // ворочается
    const t = this.turn;
    // покачивание корня — опора «ворочается»; настоящий turn_over_sleep ворочается сам
    if (t && p.state === 'asleep' && this.isProc(TURN_CLIP)) {
      const kt = clamp01((now - t.t0) / t.ms);
      const ww = Math.sin(Math.PI * kt);
      y += 0.04 * t.amp * ww;
      roll += 0.22 * t.amp * Math.sin(kt * Math.PI * 2) * (1 - kt * 0.3);
      yaw += 0.12 * t.amp * ww;
    }
    room.placeAnchor(x, y, yaw, z, roll, tilt);
    this.lieW = w;
  }
  /** насколько кот лежит (последний кадр) */
  private lieW = 0;
  /**
   * Выравнивание позы лёжа по матрасу (не интегратор: цель считается заново из позы клипа в системе якоря).
   * al — сглаженная поза якоря (её берёт pose), goal — цель последнего замера, memo — цель по клипу (кот → клип → поза),
   * чтобы смена клипа (лёг → петля сна → потягивание) начиналась с уже известной позы, а не с точки сна.
   */
  readonly al = { x: 0, y: 0, z: 0, yaw: 0, tilt: 0, ok: false };
  private goal: { x: number; y: number; z: number; yaw: number; tilt: number } | null = null;
  private memo = new WeakMap<object, Map<string, { x: number; y: number; z: number; yaw: number; tilt: number }>>();
  private samp: { of: object; list: { mesh: THREE.SkinnedMesh; idx: Int32Array; head: Uint8Array }[] } | null = null;
  private bodyAt = 0;
  private alAt = 0;
  private alClip = '';
  private turnY: number | null = null;
  private alSwitch = 0;
  /** вершины тела (без головы), мир — силуэт для одеяла (fitPose, раз в 0,25 с) */
  private bodyPts: THREE.Vector3[] = [];
  private lastT = 0;
  /** замер для стенда и debug: ось тела, наклон, низ тела над простынёй, голова над подушкой (мм комнаты) */
  readonly alDbg = { axis: 0, pitch: 0, lowMM: 0, headMM: 0, clip: '' };

  /**
   * Вершины кожи (каждая k-я; голова — по доминирующей кости в поддереве Head) — раз на модель. Для замера позы — ~300
   * на сетку без меха; для одеяла (cloth) — гуще и с прядями меха (BD_FurCards: хвост и пряди торчали сквозь ткань).
   */
  private sampCloth: typeof this.samp = null;
  private samples(obj: THREE.Object3D, cloth = false) {
    const cache = cloth ? this.sampCloth : this.samp;
    if (cache?.of === obj) return cache.list;
    const list: { mesh: THREE.SkinnedMesh; idx: Int32Array; head: Uint8Array }[] = [];
    obj.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || (/shell|fur/i.test(m.name) && !(cloth && /furcard/i.test(m.name)))) return;
      const pos = m.geometry.getAttribute('position'), si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
      if (!pos || !si || !sw) return;
      const underHead = (b: THREE.Object3D | undefined) => {
        for (let x: THREE.Object3D | null | undefined = b; x; x = x.parent) if (/Head$/.test(x.name)) return true;
        return false;
      };
      const underArm = (b: THREE.Object3D | undefined) => {
        for (let x: THREE.Object3D | null | undefined = b; x; x = x.parent) if (/(Left|Right)Shoulder$/.test(x.name)) return true;
        return false;
      };
      const step = Math.max(1, Math.floor(pos.count / (cloth ? 1500 : 300)));
      const idx: number[] = [], head: number[] = [];
      for (let i = 0; i < pos.count; i += step) {
        let best = 0, bi = 0;
        for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > best) (best = sw.getComponent(i, k)), (bi = si.getComponent(i, k));
        idx.push(i);
        // для одеяла лапы — как голова (не под тканью): поднятая к мордочке лапа ставила ткань «шатром» с гребнем
        head.push(underHead(m.skeleton.bones[bi]) || (cloth && underArm(m.skeleton.bones[bi])) ? 1 : 0);
      }
      list.push({ mesh: m, idx: Int32Array.from(idx), head: Uint8Array.from(head) });
    });
    if (cloth) this.sampCloth = { of: obj, list };
    else this.samp = { of: obj, list };
    return list;
  }

  /**
   * Кот лежит: поза клипа в системе якоря → поза якоря, при которой (1) ось таз→шея лежит вдоль кровати головой к
   * изголовью (+X), спина горизонтально (наклон ≤ 0,35 рад); (2) голова — на подушке, тело — по центру матраса;
   * (3) нижняя вершина тела — на простыне, нижняя вершина головы — не ниже верха подушки (−5 см: подушка мягкая;
   * не хватает — голова приподнимается наклоном спины, не больше 0,25 рад).
   * Геометрия — BedProp.mattress (как построена кровать), замер — по вершинам кожи раз в 0,2 с, между — сглаживание.
   */
  private alignTick(now: number) {
    const ch = this.h.character() as unknown as { object?: THREE.Object3D; boneWorld?: (n: string, o: THREE.Vector3) => boolean; currentClip?: string } | null;
    const room = this.v.room, bed = room?.bed;
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastT || now)) / 1000));
    this.lastT = now;
    if (!ch?.object || !ch.boneWorld || !room || !bed) return;
    const clip = ch.currentClip ?? '';
    let memo = this.memo.get(ch.object);
    if (!memo) this.memo.set(ch.object, (memo = new Map()));
    const st = this.m.progress(now);
    // мерить: кот лежит (поза сна, ложится, потягивается лёжа), не ворочается
    const lyingStep = st.state === 'asleep' || ['lie_down_side', 'cover', 'uncover'].includes(st.step?.id ?? '') || (st.step?.id === 'wake_stretch_in_bed' && st.k < 0.3);
    // смена клипа (лёг → петля сна): клипы Meshy кладут тело в своей системе по-разному (ось расходится до 150°) —
    // первые 0,7 с после смены мерим каждый кадр и ставим якорь без сглаживания: тело остаётся вдоль кровати, пока
    // микшер смешивает позы; дальше — раз в 0,2 с со сглаживанием
    if (clip !== this.alClip) {
      this.alClip = clip;
      this.alSwitch = now;
    }
    const fresh = now - this.alSwitch < 700;
    let snap = false;
    // мерим только позы лёжа (во время шага может заиграть чужой клип — реплика режиссёра, talk_*): иначе прежняя цель
    if (lyingStep && LYING_CLIPS.has(clip) && !this.turn && (fresh || now - this.alAt > 200)) {
      this.alAt = now;
      const g = this.measure(ch as Required<typeof ch>, room.anchor, bed.mattress);
      if (g) {
        memo.set(clip, g);
        snap = fresh && this.al.ok;
      }
    }
    // ворочается (turn_over_sleep приподнимает тело на 5–7 см): поворот и место — прежние, по высоте тело держим на
    // матрасе (иначе одеяло тянулось вверх за котом)
    if (this.turn && LYING_CLIPS.has(clip) && this.al.ok) {
      if (now - this.alAt > 100) {
        this.alAt = now;
        const g = this.measure(ch as Required<typeof ch>, room.anchor, bed.mattress);
        if (g) this.turnY = g.y;
      }
      if (this.turnY !== null) this.al.y += (this.turnY - this.al.y) * (1 - Math.exp(-dt / 0.1));
      return;
    }
    this.turnY = null;
    // цель: замер этого клипа, иначе прежняя цель
    const want = memo.get(clip) ?? this.goal;
    if (!want) return;
    this.goal = want;
    const A = this.al;
    if (!A.ok) {
      Object.assign(A, want, { ok: true });
      return;
    }
    const k = snap ? 1 : 1 - Math.exp(-dt / 0.18);
    A.x += (want.x - A.x) * k;
    A.y += (want.y - A.y) * k;
    A.z += (want.z - A.z) * k;
    A.tilt += (want.tilt - A.tilt) * k;
    A.yaw += Math.atan2(Math.sin(want.yaw - A.yaw), Math.cos(want.yaw - A.yaw)) * k;
  }

  private measure(ch: { object: THREE.Object3D; boneWorld: (n: string, o: THREE.Vector3) => boolean }, anchor: THREE.Object3D, M: Mattress) {
    ch.object.parent?.updateMatrixWorld(true);
    anchor.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(anchor.matrixWorld).invert();
    const loc = (n: string) => {
      const v = new THREE.Vector3();
      return ch.boneWorld(n, v) ? v.applyMatrix4(inv) : null;
    };
    const hips = loc('Hips'), neck = loc('Neck'), head = loc('Head');
    if (!hips || !neck || !head) return null;
    const L = this.isProc(SLEEP_CLIP) ? LIE : REAL_LIE;
    const q0 = new THREE.Quaternion().setFromAxisAngle(AX_Z, L.roll).multiply(new THREE.Quaternion().setFromAxisAngle(AX_X, -Math.PI / 2));
    const b = neck.clone().sub(hips).applyQuaternion(q0);
    const len = b.length();
    // не лёжа (сидит, встаёт): ось почти вертикальна — не мерим
    if (len < 1e-4 || Math.abs(b.y) / len > 0.64) return null;
    const yaw = Math.atan2(b.z, b.x);
    const qy = new THREE.Quaternion().setFromAxisAngle(AX_Y, yaw);
    const c = b.clone().applyQuaternion(qy);
    let tilt = clampR(-Math.atan2(c.y, c.x), -0.25, 0.25);
    const P = M.pillow;
    const W = new THREE.Quaternion();
    const v = new THREE.Vector3();
    let lowB = Infinity, lowH = Infinity, hw = head, mid = head, hipW = hips;
    const hc = new THREE.Vector3();
    let hn = 0;
    /** подушка мягкая: голова может уйти в неё на столько */
    const SINK = 0.05;
    // два прохода: спина горизонтально → не хватает до подушки — приподнять голову наклоном (не всё тело)
    for (let pass = 0; pass < 2; pass++) {
      W.setFromAxisAngle(AX_Z, tilt).multiply(qy).multiply(q0);
      lowB = lowH = Infinity;
      hc.set(0, 0, 0);
      hn = 0;
      for (const s of this.samples(ch.object)) {
        if (!s.mesh.visible) continue;
        for (let j = 0; j < s.idx.length; j++) {
          s.mesh.getVertexPosition(s.idx[j], v);
          v.applyMatrix4(s.mesh.matrixWorld).applyMatrix4(inv).applyQuaternion(W);
          if (s.head[j]) {
            lowH = Math.min(lowH, v.y);
            hc.add(v);
            hn++;
          } else lowB = Math.min(lowB, v.y);
        }
      }
      hw = head.clone().applyQuaternion(W);
      mid = hips.clone().add(neck).multiplyScalar(0.5).applyQuaternion(W);
      hipW = hips.clone().applyQuaternion(W);
      if (!Number.isFinite(lowB)) lowB = hipW.y - 0.1;
      const short = P.top - SINK - lowH - (M.top + 0.004 - lowB);
      if (pass || !Number.isFinite(short) || short <= 0.005) break;
      tilt = clampR(tilt + Math.atan2(short, Math.max(0.15, hw.x - hipW.x)), -0.25, 0.25);
    }
    // голова (центр вершин головы) — на середину подушки; нет вершин головы — кость Head чуть ближе к телу
    const x = hn ? P.x - hc.x / hn : P.x - P.length * 0.2 - hw.x;
    // placeAnchor ставит якорь на 0,1 дальше от зрителя (точка опоры Stage), тело — по центру матраса
    const z = M.z0 + 0.1 - mid.z;
    // голова не дотягивается и наклоном: тело не висит над простынёй больше 3 см — голова глубже в подушку (Добряк)
    const y = Math.max(M.top + 0.004 - lowB, Number.isFinite(lowH) ? P.top - SINK - lowH - 0.03 : -Infinity);
    const r2d = 180 / Math.PI;
    Object.assign(this.alDbg, { axis: Math.round(yaw * r2d), pitch: Math.round(-tilt * r2d), lowMM: Math.round((y + lowB - M.top) * 1000), headMM: Math.round((y + lowH - P.top) * 1000), clip: (ch as { currentClip?: string }).currentClip ?? '' });
    return { x, y, z, yaw, tilt };
  }

  /** капсулы тела для одеяла (раз в 0,25 с), пока кот лежит */
  private fitPose(now: number) {
    const ch = this.h.character() as unknown as { boneWorld?: (n: string, o: THREE.Vector3) => boolean } | null;
    const bed = this.v.room?.bed;
    const st = this.m.progress(now);
    const sleepPose = st.state === 'asleep' || st.step?.id === 'cover' || st.step?.id === 'uncover' || (st.step?.id === 'lie_down_side' && st.k > 0.6);
    if (!ch?.boneWorld || this.lieW < 0.6 || !sleepPose) {
      if (this.lieW < 0.05) bed?.setBody(null);
      return;
    }
    // ворочается: силуэт одеяла не трогаем (иначе ткань тянулась вверх за лапами клипа), высоту тела держит alignTick
    if (now - this.bodyAt < 250 || !bed || this.turn) return;
    const P: Record<string, THREE.Vector3> = {};
    for (const n of BONES) {
      const v = new THREE.Vector3();
      if (ch.boneWorld(n, v)) P[n] = v;
    }
    if (!P.Hips || !P.Neck) return;
    this.bodyAt = now;
    const hgt = this.h.stage.cfg.height;
    const R = (n: string) => (n === 'Head' ? 0.13 : /Hips|Spine/.test(n) ? 0.12 : /Foot|Toe/.test(n) ? 0.12 : /Leg/.test(n) ? 0.1 : 0.07) * hgt;
    const caps: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
    // силуэт: вершины кожи без головы (на боку туловище в худи толще капсул по костям — торчало сквозь одеяло; во время
    // «ворочается» — тоже по текущей позе) + капсулы костей потоньше (связать точки)
    const obj = (this.h.character() as unknown as { object?: THREE.Object3D } | null)?.object;
    this.bodyPts = [];
    if (obj) {
      obj.parent?.updateMatrixWorld(true);
      for (const s of this.samples(obj, true)) {
        if (!s.mesh.visible) continue;
        for (let j = 0; j < s.idx.length; j++) if (!s.head[j]) this.bodyPts.push(s.mesh.getVertexPosition(s.idx[j], new THREE.Vector3()).applyMatrix4(s.mesh.matrixWorld));
      }
    }
    // ткань ложится по коже: вершина + 1,8 см (мех-оболочка) + толщина ткани в bedProp (1,2 см); кости — только связать
    for (const p of this.bodyPts) caps.push({ a: p, b: p, r: 0.018 });
    const kR = this.bodyPts.length ? 0.5 : 1;
    // по вершинам — капсулы туловища и ног (лапы — поверх одеяла)
    for (const [a, b] of CAPS) if (P[a] && P[b] && !(this.bodyPts.length && /Arm|Hand/.test(a + b))) caps.push({ a: P[a], b: P[b], r: Math.max(R(a), R(b)) * (/Foot|Toe/.test(a + b) ? 1 : kR) });
    // стопы — полной капсулой: подошва кеда между редкими вершинами торчала сквозь ткань
    // край одеяла — у шеи: последние 22 см ткань спускается к матрасу, грудь укрыта, лапы поверх
    bed.setBody(caps, Math.max(P.Neck.x, P.Spine2?.x ?? P.Neck.x) + 0.04);
  }

  /** клип играет опорой (настоящего в GLB нет); спрайт/риг-заглушка — тоже как опора */
  private isProc(clip: string): boolean {
    const ch = this.h.character() as unknown as TweakCh | null;
    return !ch?.procedural || ch.procedural.has(clip);
  }

  /** поправки костей поверх клипа-опоры (только если настоящего клипа нет) */
  private tweak: { step: BedStep['id'] | 'asleep'; t0: number; dur: number } | null = null;
  /**
   * Поправки костей поверх клипа-опоры (настоящих клипов нет): лёжа — ноги вытянуты вдоль тела (опора sleep_loop —
   * «на коленях», без этого ноги торчат вверх из-под одеяла), прыжок — подобрать лапы, потягивание — лапы вверх.
   * Настоящий клип sleep_loop_bed — без поправок.
   */
  private setTweak(step: BedStep['id'] | 'asleep' | null) {
    const ch = this.h.character() as unknown as TweakCh | null;
    if (!ch || !('poseTweak' in ch)) return;
    // поправки — только для шага, который играет опорой (клип Meshy пришёл — без поправок)
    const stepClip = step === 'asleep' ? SLEEP_CLIP : [...TUCK_STEPS, ...WAKE_STEPS].find((x) => x.id === step)?.clip ?? SLEEP_CLIP;
    if (!step || !ch.procedural?.has(stepClip)) {
      this.tweak = null;
      ch.poseTweak = null;
      return;
    }
    this.tweak = { step, t0: performance.now(), dur: [...TUCK_STEPS, ...WAKE_STEPS].find((x) => x.id === step)?.ms ?? 1000 };
    ch.poseTweak = (rot) => {
      const tw = this.tweak;
      if (!tw) return;
      const k = clamp01((performance.now() - tw.t0) / tw.dur);
      const w = Math.sin(Math.PI * k);
      // лёжа: бёдра назад вдоль тела, голени — в линию (подобрано по снимкам)
      const lw = ch.procedural?.has(SLEEP_CLIP) ? this.lieW : 0;
      if (lw > 0.01) {
        rot('LeftUpLeg', 'side', 1.3 * lw);
        rot('RightUpLeg', 'side', 1.3 * lw);
        rot('LeftLeg', 'side', -1.3 * lw);
        rot('RightLeg', 'side', -1.3 * lw);
        // стопы — носком назад, вдоль голени (иначе кеды торчат вверх)
        rot('LeftFoot', 'side', -1.0 * lw);
        rot('RightFoot', 'side', -1.0 * lw);
      }
      if (tw.step === 'get_into_bed') {
        rot('Spine1', 'side', 0.25 * w);
        rot('LeftUpLeg', 'side', -0.5 * w);
        rot('RightUpLeg', 'side', -0.5 * w);
      } else if (tw.step === 'wake_stretch_in_bed') {
        // зевает и тянется лёжа (первая треть), потом садится
        const s2 = Math.sin(Math.PI * clamp01(k / 0.5));
        rot('Head', 'side', -0.35 * s2);
        rot('LeftArm', 'fwd', -0.9 * s2);
        rot('RightArm', 'fwd', 0.9 * s2);
      } else if (tw.step === 'hop_out_of_bed') {
        rot('LeftUpLeg', 'side', -0.4 * w);
        rot('RightUpLeg', 'side', -0.4 * w);
      }
    };
  }

  // ───────────── Zzz, свет, предложения ─────────────

  /** Zzz — только над спящим котом, которого видно: спальня (не в перебежке) или дрёма на карте */
  private syncZzz() {
    const v = this.v;
    const want = this.m.state === 'asleep' && ((v.phase === 'home' && v.zone === 'bedroom' && !v.moving) || (v.phase === 'ar' && this.h.director.dozing));
    this.setZzz(want);
  }
  private setZzz(on: boolean) {
    if (on === this.zzzOn) return;
    this.zzzOn = on;
    const fx = this.h.fx;
    if (on) {
      this.stats.zzzStarts++;
      fx?.play('zzz');
    } else {
      this.stats.zzzStops++;
      // сразу, без тающих букв над проснувшимся котом / пустой комнатой
      if (fx?.kill) fx.kill((id) => id === 'zzz');
      else fx?.stop?.('zzz');
    }
  }
  /** над спящим — только Zzz: живые эффекты кота (сердечки, пузыри) убрать, новые не пускать; false — снять фильтр */
  private quietFx(on: boolean) {
    const fx = this.h.fx;
    if (!fx) return;
    if (on) {
      fx.kill?.((id) => id !== 'zzz');
      fx.clearParticles?.();
      for (const id of NOISY_FX) fx.stop?.(id);
      fx.filter = (id) => id === 'zzz';
    } else if (fx.filter) fx.filter = null;
  }

  /** Zzz сейчас над котом (тесты, debug) */
  get zzz() {
    return this.zzzOn;
  }

  /** свет комнаты: null — как без кровати */
  lightTarget(): number | null {
    const st = this.m.state, v = this.v;
    if (st === 'awake') return null;
    const night = this.morning ? MORNING_LIGHT : NIGHT_LIGHT;
    if (v.zone !== 'bedroom') return st === 'asleep' ? AWAY_LIGHT : null;
    const p = this.m.progress(this.now || performance.now());
    if (st === 'asleep') return night;
    if (st === 'tucking') return p.step?.id === 'approach' || p.step?.id === 'get_into_bed' ? 1 - 0.3 * p.total : night;
    // просыпается: шторка вверх — светло
    return lerp(night, 1, clamp01(p.total * 1.6));
  }

  /** камера: кот в кровати — чуть выше и дальше (видно кровать целиком) */
  frameBias(): { dy: number; zoom: number; dx: number } {
    // ракурс спальни (кровать целиком, кот рядом) задаёт зона (zones.ts cam); кровать добавляет только чуть выше
    if (!this.m.inBed || this.v.zone !== 'bedroom') return { dy: 0, zoom: 1, dx: 0 };
    return { dy: 0.04, zoom: 1, dx: 0 };
  }

  private offerTick(now: number) {
    const h = this.h, d = h.director, v = this.v;
    if (this.offer && now > this.offer.until) {
      this.offer = null;
      h.suggest();
    }
    if (this.offer || v.moving) return;
    const kind = this.offers.check({
      now, hour: this.hour(), state: this.m.state, home: v.phase === 'home',
      busy: !!d.state.dialog || d.queue.busy || d.dozing || d.state.paused || !!this.pendingTuck,
      quietMs: d.ladder.quietFor(now), enteredBedroom: this.enteredBedroom,
    });
    this.enteredBedroom = false;
    if (!kind) return;
    this.offer = { kind, until: now + OFFER_SHOW_MS };
    this.log(`предлагает: ${kind}`);
    if (kind === 'evening_yawn') h.character()?.play('idle_yawn');
    this.say(kind, { background: true });
    d.ladder.reset(now);
    h.suggest();
  }

  /** ?flow=home&zone=bedroom&bed=sleep|wake|night|morning (страница /test) */
  flow(kind: string | null) {
    if (!kind) return;
    this.log(`флоу bed=${kind}`);
    switch (kind) {
      case 'sleep':
        this.tuck('flow');
        break;
      case 'night':
        this.hourOverride ??= 21;
        this.tuck('flow');
        break;
      case 'wake':
        if (this.m.state === 'awake') {
          this.m.sleepNow(this.now || performance.now());
          this.asleepVisuals(true);
          this.h.suggest();
        }
        setTimeout(() => this.wake('flow'), 1500);
        break;
      case 'morning':
        // кот уже лежит (beforeEnter со force) — ждёт, когда разбудят
        break;
    }
  }

  dispose() {
    this.quietFx(false);
    this.lull?.stop();
    this.lull = null;
    this.setTweak(null);
    this.setZzz(false);
  }
}
