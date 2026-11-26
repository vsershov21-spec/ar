/**
 * Пробуждение кота из карты — «видеоряд» для каждого образа, но не видеофайлом, а постановочной сценой в движке:
 * она привязана к карте в AR (видео висело бы в воздухе и не совпадало с картой; прозрачное видео на iOS — только
 * HEVC с альфой) и идёт с той же частотой, что и кот. Запускается в момент посадки на карту (director.appear):
 * первая встреча — полная сцена ~5,4 с, повторный визит — короткая 1,5 с.
 *
 *   кривые и события по времени — timeline.ts; 3D в плоскости карты — awakeScene.ts; салют на весь экран —
 *   fx/salute.ts; звуки — awakeAudio.ts (public/sounds/awake.*, scripts/gen_awake_sounds.py).
 *
 * Что делает сам: двигает кота (Stage.intro), включает клипы, эмоции и глаза (сонный → удивлённый → радость),
 * звуки, частицы образа, салют; энергобюджет держит «boost» только пока сцена или салют идут (active).
 * ?flow=awake — кнопки «↻ Первое / ↻ Повтор» для страницы /test (перезапуск сцены на месте).
 * window.__awake — для скриптов снимков (scripts/awake-shots.mjs): play(), timeScale.
 */
import * as THREE from 'three';
import type { PersonaId } from '../persona/types';
import type { Character } from '../character/types';
import type { Stage } from '../stage';
import type { Audio } from '../audio/audio';
import { Salute, type BurstShape } from '../fx/salute';
import { AwakeAudio } from './awakeAudio';
import { AwakeScene, AWAKE_COLORS } from './awakeScene';
import { awakePlan, clamp01, easeOutBack, type AwakeKind, type AwakePlan } from './timeline';
import { track } from '../analytics';

export { awakePlan } from './timeline';
export type { AwakeKind } from './timeline';

const SHAPES: Record<PersonaId, BurstShape[]> = {
  hooligan: ['star', 'ring', 'peony', 'star', 'ring', 'peony'],
  kind: ['heart', 'ring', 'peony', 'heart', 'peony', 'ring'],
  glitter: ['star', 'peony', 'ring', 'star', 'peony', 'heart'],
};

export interface AwakeDeps {
  anchor: THREE.Object3D;
  aspect: number;
  stage: Stage;
  character: () => Character | null;
  audio: Audio;
  /** контейнер приложения: туда — холст салюта и кнопки ?flow=awake */
  root: HTMLElement;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  log?: (s: string) => void;
  /** текущий образ (перезапуск ?flow=awake) */
  persona?: () => PersonaId;
}

interface Run {
  plan: AwakePlan;
  t: number;
  next: number;
  emitAcc: Record<string, number>;
}

export class AwakeController {
  readonly scene: AwakeScene;
  readonly salute: Salute;
  readonly sounds: AwakeAudio;
  private run: Run | null = null;
  /** замедление для записи превью (1 — как есть) */
  timeScale = 1;
  private lastNow = 0;
  private tmp = new THREE.Vector3();
  private catXY = new THREE.Vector2();
  private persona: PersonaId = 'hooligan';
  /** сколько раз сыграна сцена (QA) */
  played = 0;
  /** время старта последней сцены (performance.now) — QA: длинные задачи в первые 500 мс */
  startedAt = -1;

  constructor(private d: AwakeDeps) {
    this.scene = new AwakeScene(d.aspect);
    d.anchor.add(this.scene.group);
    d.stage.root.add(this.scene.skate);
    this.salute = new Salute(d.root);
    this.salute.resize(d.root.clientWidth || innerWidth, d.root.clientHeight || innerHeight);
    this.salute.faceFn = () => {
      if (!d.stage.root.visible) return null;
      const w = d.root.clientWidth, h = d.root.clientHeight;
      const head = d.stage.anchorScreen('head', w, h);
      return { x: head.x, y: head.y, r: head.s * 0.42 };
    };
    this.sounds = new AwakeAudio(d.audio);
    this.salute.onBurst = (x, w) => {
      const id = `boom_${1 + Math.floor(Math.random() * 3)}`;
      this.sounds.play(id, 0.32, 0.92 + Math.random() * 0.16);
      void x;
      void w;
    };
    if (typeof window !== 'undefined') (window as unknown as { __awake: AwakeController }).__awake = this;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('flow') === 'awake') this.flowButtons();
  }

  /** сцена или салют идут: энергобюджет — «boost», рендер не пропускается */
  get active() {
    return !!this.run || this.salute.active;
  }

  resize(w: number, h: number) {
    this.salute.resize(w, h);
  }

  /**
   * Прогрев: шейдеры всех объектов сцены (контур, портал, столб, частицы, скейт) и текстуры — заранее, пока ребёнок
   * на онбординге. Иначе первый кадр сцены ждёт компиляции (на телефоне 50–300 мс — заметный рывок «ПУФ»).
   */
  warm(scene: THREE.Scene) {
    const r = this.d.renderer;
    this.scene.forWarm(true);
    const skate = this.scene.skate;
    skate.visible = true;
    const root = this.d.stage.root;
    const rootVis = root.visible;
    root.visible = true;
    try {
      for (const t of this.scene.textures()) r.initTexture(t);
      // текстуры кота (2048², KTX2) — тоже на GPU заранее: иначе загрузка в первом кадре с котом («ПУФ»)
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const mat of m ? (Array.isArray(m) ? m : [m]) : [])
          for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) r.initTexture(v as THREE.Texture);
      });
      void r.compileAsync(scene, this.d.camera).catch(() => undefined);
    } catch {
      /* старый браузер — скомпилирует в первом кадре */
    } finally {
      root.visible = rootVis;
      skate.visible = false;
      this.scene.forWarm(false);
      this.scene.clear();
      this.scene.group.visible = false;
    }
    this.salute.warm();
    void this.sounds.load();
  }

  /**
   * Сыграть пробуждение. Возвращает, через сколько мс сценарий идёт дальше («Ого! Это твоя карта?…»).
   * Кот на сцене — с первого кадра (масштаб 0 до «ПУФ»), Stage.intro двигает его до конца сцены.
   */
  play(persona: PersonaId, kind: AwakeKind): number {
    this.persona = persona;
    const plan = awakePlan(persona, kind);
    this.run = { plan, t: 0, next: 0, emitAcc: {} };
    this.played++;
    this.startedAt = performance.now();
    // «Мир кота» (Stage.useView) — своя плоскость пола: сцена — на ней
    const a = (this.d.stage as unknown as { anchor?: THREE.Object3D }).anchor ?? this.d.anchor;
    if (this.scene.group.parent !== a) a.add(this.scene.group);
    this.scene.setColors(persona);
    this.scene.clear();
    this.scene.group.visible = true;
    const st = this.d.stage;
    st.resetPosition();
    st.intro = plan.pose(0);
    st.show(true);
    this.d.log?.(`✨ пробуждение ${persona} (${kind === 'first' ? 'первая встреча' : 'повтор'}, ${plan.dur.toFixed(1)} с)`);
    this.step(0);
    return plan.appearDoneMs;
  }

  /** прервать (смена кота, уход со сцены) — экран чистый, кот на месте */
  stop() {
    if (this.run) this.finish();
    this.salute.stop();
  }

  private finish() {
    if (this.run) track('awake_done', {}, true); // воронка (src/analytics): первое пробуждение за сессию
    this.run = null;
    this.d.stage.intro = null;
    this.scene.clear();
    this.scene.group.visible = false;
    this.scene.skate.visible = false;
  }

  /** кадр: до stage.update (поза Stage.intro — в этом же кадре) */
  update(dt: number) {
    // время сцены — по часам, а не по сумме dt кадров: при тормозах (dt обрезан energy.maxDt) сцена не отстаёт
    // от фанфар и от таймера сценария appear_done
    const now = performance.now();
    if (this.lastNow > 0) dt = Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    dt *= this.timeScale;
    if (this.run) this.step(dt);
    this.salute.update(dt);
    this.salute.draw();
  }

  private step(dt: number) {
    const run = this.run!;
    const p = run.plan;
    run.t += dt;
    const t = run.t;
    // события по времени
    while (run.next < p.events.length && p.events[run.next].t <= t) this.fire(p.events[run.next++]);
    const st = this.d.stage;
    const pose = p.pose(t);
    st.intro = pose;
    // кот на карте: точка опоры + подъём (в ширинах карты)
    this.catXY.copy(st.pos);
    const H = st.cfg.height;
    // контур, портал, столб, тень, кляксы
    const pil = p.pillar(t);
    const splat = [0, 1, 2].map((i) => {
      if (this.persona !== 'hooligan') return 0;
      // граффити — вместе со столбом света (после подскоков карты)
      const t0 = p.kind === 'first' ? p.tPop - 0.83 + i * 0.22 : 0.1 + i * 0.08;
      const fade = p.kind === 'first' ? 1 - clamp01((t - p.tLand - 1.2) / 0.8) : 1 - clamp01((t - p.tLand - 0.1) / 0.45);
      return t < t0 ? 0 : easeOutBack((t - t0) / 0.22, 2.6) * fade;
    });
    this.scene.apply({
      t, cracks: p.cracks(t), hop: p.hop(t), glow: p.glow(t), portal: p.portal(t), pillarH: pil.h, pillarK: pil.k, silhouette: p.silhouette(t), splat,
      occlude: t >= p.tPop - 0.02 && t < p.tLand, catXY: this.catXY, flair: this.persona,
    });
    // скейт под лапами (Хулиган), после приземления укатывается
    const sk = p.skate(t), skate = this.scene.skate;
    skate.visible = sk >= 1 && sk < 2.999;
    if (skate.visible) {
      const k = Math.max(0, sk - 1);
      skate.position.set(k * 1.6, -0.035 + Math.sin(k * Math.PI) * 0.12, 0.02);
      skate.rotation.set(0, 0, -k * 0.6);
      skate.scale.setScalar(Math.max(0.001, 1 - k * 0.85));
    }
    this.emit(dt, t, p, pose.lift, pose.scale, H);
    // размер точек частиц: px на единицу мира (с масштабом якоря карты)
    const r = this.d.renderer, cam = this.d.camera;
    const bh = r.getDrawingBufferSize(TMP2).y;
    const s = this.d.anchor.getWorldScale(this.tmp).x || 1;
    this.scene.setPointScale((bh / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)))) * s);
    this.scene.update(dt, t);
    if (t >= p.dur && this.scene.particlesLive === 0) this.finish();
    else if (t >= p.dur + 1.5) this.finish();
  }

  private fire(e: AwakePlan['events'][number]) {
    const ch = this.d.character() as (Character & { setEmotion?: (n: string, w?: number, ms?: number) => void }) | null;
    switch (e.type) {
      case 'sound':
        if (!this.sounds.play(e.id, e.vol ?? 1) && e.id.startsWith('fanfare')) (this.d.audio as Audio & { fanfare?: (v?: number) => void }).fanfare?.(e.id.includes('short') ? 0.35 : 0.5);
        break;
      case 'sfx':
        if (this.d.audio.has(e.id)) this.d.audio.play(e.id, e.vol ?? 1);
        break;
      case 'clip':
        ch?.play(e.clip);
        break;
      case 'emotion':
        if (ch?.setEmotion) ch.setEmotion(e.name, e.weight, e.ms);
        else ch?.face(e.name, e.ms);
        break;
      case 'pop':
        this.burst(this.run!.plan.kind === 'first' ? 46 : 26);
        break;
      case 'land':
        this.dust(this.run!.plan.kind === 'first' ? 34 : 18);
        break;
      case 'salute':
        this.salute.start({ size: e.size, shapes: SHAPES[this.persona] ?? SHAPES.hooligan, crackle: this.persona === 'glitter' ? 0.7 : 0.3 });
        break;
    }
  }

  // ───────────── частицы ─────────────
  private rnd = (a: number, b: number) => a + Math.random() * (b - a);
  private pc(i?: number) {
    const parts = AWAKE_COLORS[this.persona].parts;
    return this.scene.color(parts[i ?? Math.floor(Math.random() * parts.length)]);
  }

  /** ПУФ: искры из портала вверх и в стороны */
  private burst(n: number) {
    const { x, y } = this.catXY;
    const glit = this.persona === 'glitter';
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = this.rnd(0.35, 1.1);
      this.scene.glowParts.emit({ x: x + Math.cos(a) * 0.05, y: y + Math.sin(a) * 0.05, z: 0.02, vx: Math.cos(a) * sp * 0.8, vy: Math.sin(a) * sp * 0.8, vz: this.rnd(0.6, 1.6), life: this.rnd(0.6, 1.1), size: this.rnd(0.03, 0.055), shape: glit || i % 4 === 0 ? 1 : 0, color: this.pc(), gz: -1.6, drag: 1.4 });
    }
    if (this.persona === 'kind')
      for (let i = 0; i < 10; i++) {
        const a = Math.random() * Math.PI * 2;
        this.scene.softParts.emit({ x: x + Math.cos(a) * 0.08, y: y + Math.sin(a) * 0.08, z: 0.05, vx: Math.cos(a) * 0.25, vy: Math.sin(a) * 0.25, vz: this.rnd(0.2, 0.5), life: this.rnd(1.4, 2.2), size: this.rnd(0.07, 0.13), shape: 3, color: this.pc(0), gz: 0.04, drag: 1.2, wob: 0.12 });
      }
  }

  /** приземление: кольцо пыли-искр по карте */
  private dust(n: number) {
    const { x, y } = this.catXY;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.scene.glowParts.emit({ x: x + Math.cos(a) * 0.08, y: y + Math.sin(a) * 0.05, z: 0.01, vx: Math.cos(a) * 0.7, vy: Math.sin(a) * 0.45, vz: this.rnd(0.05, 0.25), life: this.rnd(0.4, 0.7), size: 0.03, shape: 0, color: this.pc(), gz: -0.4, drag: 3 });
    }
  }

  /** непрерывные потоки по кривым sparks(t) / flair(t): rate — штук в секунду при интенсивности 1 */
  private flow(key: string, rate: number, dt: number, fn: () => void) {
    const acc = this.run!.emitAcc;
    acc[key] = (acc[key] ?? 0) + rate * dt;
    while (acc[key] >= 1) {
      acc[key] -= 1;
      fn();
    }
  }

  private emit(dt: number, t: number, p: AwakePlan, lift: number, scale: number, H: number) {
    if (dt <= 0) return;
    const { x, y } = this.catXY;
    const short = p.kind === 'short';
    const sp = p.sparks(t), fl = p.flair(t);
    const G = this.scene.glowParts, S = this.scene.softParts;
    const inFlight = t >= p.tPop && t < p.tLand;
    const bodyZ = Math.max(0.02, (lift + 0.45 * scale) * H);
    if (sp > 0)
      this.flow('sp', (short ? 50 : 80) * sp, dt, () => {
        const a = Math.random() * Math.PI * 2, r = this.rnd(0.1, 0.2);
        G.emit({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, z: 0.01, vx: -Math.cos(a) * 0.05, vy: -Math.sin(a) * 0.05, vz: this.rnd(0.5, 1.3), life: this.rnd(0.6, 1.1), size: this.rnd(0.02, 0.04), shape: this.persona === 'glitter' ? 1 : 0, color: this.pc(), gz: -0.2, drag: 0.6 });
      });
    if (fl <= 0) return;
    switch (this.persona) {
      case 'hooligan':
        // неоновые спреи: струи из углов карты к центру и вверх
        this.flow('spray', (short ? 60 : 130) * fl, dt, () => {
          const c = CORNERS[Math.floor(Math.random() * 4)];
          const hx = 0.5, hy = 0.5 / this.scene.aspect;
          const sx = c[0] * hx * 0.9, sy = c[1] * hy * 0.9;
          const dx = x - sx, dy = y - sy;
          G.emit({ x: sx, y: sy, z: 0.02, vx: dx * this.rnd(0.8, 1.4) + this.rnd(-0.1, 0.1), vy: dy * this.rnd(0.8, 1.4) + this.rnd(-0.1, 0.1), vz: this.rnd(0.5, 1.0), life: this.rnd(0.5, 0.8), size: this.rnd(0.018, 0.03), shape: 0, color: this.pc(Math.floor(Math.random() * 4)), gz: -1.4, drag: 1.2 });
        });
        if (inFlight)
          this.flow('wheel', 70, dt, () => G.emit({ x: x + this.rnd(-0.08, 0.08), y: y + this.rnd(-0.03, 0.03), z: Math.max(0.01, lift * H), vx: this.rnd(-0.3, 0.3), vy: this.rnd(-0.3, 0.3), vz: this.rnd(-0.2, 0.1), life: this.rnd(0.3, 0.5), size: 0.025, shape: 0, color: this.pc(1), gz: -1, drag: 2 }));
        break;
      case 'kind':
        // облако пузырей вокруг кота и мягкие сердечки
        this.flow('bub', (short ? 10 : inFlight ? 34 : 16) * fl, dt, () => {
          const a = Math.random() * Math.PI * 2, r = this.rnd(0.12, inFlight ? 0.32 : 0.4);
          S.emit({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r * 0.7, z: inFlight ? bodyZ + this.rnd(-0.25, 0.2) : this.rnd(0.02, 0.4), vx: Math.cos(a) * 0.05, vy: Math.sin(a) * 0.05, vz: this.rnd(0.12, 0.3), life: this.rnd(1.3, 2.2), size: this.rnd(0.06, 0.13), shape: 3, color: this.pc(0), gz: 0.05, drag: 0.8, wob: 0.15 });
        });
        this.flow('heart', (short ? 4 : 7) * fl, dt, () => {
          const a = Math.random() * Math.PI * 2, r = this.rnd(0.15, 0.35);
          S.emit({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r * 0.6, z: this.rnd(0.05, 0.5), vx: 0, vy: 0, vz: this.rnd(0.25, 0.45), life: this.rnd(1.0, 1.6), size: this.rnd(0.05, 0.08), shape: 2, color: this.pc(1), gz: 0.05, drag: 0.8, wob: 0.1 });
        });
        break;
      case 'glitter':
        // звёздная пыль по спирали вокруг столба, в полёте — шлейф за котом
        this.flow('dust', (short ? 60 : 140) * fl, dt, () => {
          const a = Math.random() * Math.PI * 2, r = this.rnd(0.18, 0.3);
          G.emit({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, z: this.rnd(0.02, 0.9), vx: 0, vy: 0, vz: this.rnd(0.1, 0.35), life: this.rnd(0.7, 1.3), size: Math.random() < 0.4 ? this.rnd(0.035, 0.06) : this.rnd(0.012, 0.022), shape: Math.random() < 0.4 ? 1 : 0, color: this.pc(), gz: 0, drag: 0.4, swirl: 2.4 });
        });
        if (inFlight)
          this.flow('trail', 90, dt, () => G.emit({ x: x + this.rnd(-0.1, 0.1), y: y + this.rnd(-0.06, 0.06), z: bodyZ + this.rnd(-0.2, 0.2), vx: this.rnd(-0.15, 0.15), vy: this.rnd(-0.15, 0.15), vz: this.rnd(-0.3, 0), life: this.rnd(0.5, 0.9), size: this.rnd(0.03, 0.05), shape: 1, color: this.pc(), gz: -0.3, drag: 1 }));
        break;
    }
  }

  // ───────────── ?flow=awake ─────────────
  private flowButtons() {
    const box = document.createElement('div');
    box.className = 'awake-flow';
    Object.assign(box.style, { position: 'absolute', left: '10px', top: 'calc(env(safe-area-inset-top, 0px) + 64px)', zIndex: '30', display: 'flex', gap: '6px', pointerEvents: 'auto' });
    const btn = (label: string, kind: AwakeKind) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.awake = kind;
      Object.assign(b.style, { font: '700 13px "SB Sans Text", system-ui, sans-serif', padding: '8px 12px', borderRadius: '14px', border: '0', background: 'rgba(255,255,255,.92)', color: '#157a2c', boxShadow: '0 4px 12px rgba(0,0,0,.25)' });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.replay(kind);
      });
      box.appendChild(b);
    };
    btn('↻ Пробуждение', 'first');
    btn('↻ Повтор', 'short');
    this.d.root.appendChild(box);
  }

  /** перезапуск сцены на месте (страница /test): кот «ныряет» в карту и выходит снова */
  replay(kind: AwakeKind = 'first', persona: PersonaId = this.d.persona?.() ?? this.persona) {
    this.salute.stop();
    this.play(persona, kind);
  }
}

const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const TMP2 = new THREE.Vector2();
