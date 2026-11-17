/**
 * Переходы между клипами тела и живой покой поверх миксера (3D-кот, GlbCharacter).
 *
 * Переход — инерциальный: в момент смены клипа запоминаем показанную позу (до поворотов головы/хвоста),
 * новый клип сразу играет с весом 1, а разница «было − стало» по каждой кости затухает за 0,15–0,6 с
 * по плавной кривой (smootherstep). Поэтому:
 *  - нет «щелчков» и bind-позы между клипами (старый клип не нужен — поза уже снята);
 *  - перебивание реакции реакцией (частые тапы) не дёргает: смещение снимается с текущей показанной позы;
 *  - реакция видна сразу (новый клип управляет движением с первого кадра, <1 кадра задержки).
 * Плюс: темп клипа (timeScale из animPrep, подгонка ходьбы под скорость сцены, лёгкий разброс idle),
 * случайная фаза петель покоя, слой «перенос веса» в покое (медленные покачивания корпуса).
 */
import * as THREE from 'three';
import type { ClipState } from './clipState';
import type { ClipPrepInfo } from './animPrep';

const smoother = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
/** остаток смещения для реакции: быстрый старт (за 0,1 с проходит ~половина пути), мягкая посадка */
const snappy = (x: number) => (x <= 0 ? 1 : x >= 1 ? 0 : (1 - x) * (1 - x) * (1 + 0.5 * x));
/** клипы «покоя»: в них входим мягко (smootherstep), в реакции — быстро (snappy) */
export const isCalm = (id: string) => /^(idle|sit_idle|sleep_loop|listen|talk_|echo_speak|walk|run)/.test(id);

/** длительность затухания перехода, с: из каталога (blendInMs), но не резче 0,15 с и не дольше 0,6 с */
export function blendSeconds(blendInMs: number, from: string, to: string) {
  let s = (blendInMs / 1000) * 1.5;
  if (to.startsWith('idle') && from.startsWith('idle')) s = Math.max(s, 0.6); // смена покоя — мягко
  else if (to.startsWith('idle') || to === 'sit_idle') s = Math.max(s, 0.45); // возврат в покой после реакции
  return Math.min(0.6, Math.max(0.15, s));
}

interface BoneSlot {
  b: THREE.Object3D;
  /** показанная поза прошлого кадра (после смещения перехода, до головы/хвоста) */
  last: THREE.Quaternion;
  off: THREE.Quaternion;
  hasPos: boolean;
  lastP: THREE.Vector3;
  /** чистый выход миксера прошлого кадра */
  raw: THREE.Quaternion;
  rawP: THREE.Vector3;
  offP: THREE.Vector3;
}

export class AnimBlender {
  private slots: BoneSlot[] = [];
  private playing = '';
  /** дорожка ClipState, под которую запущен клип (повторный play того же id — новая дорожка) */
  private track: unknown = null;
  private action: THREE.AnimationAction | null = null;
  private pending = false;
  private from = '';
  private t = 0;
  private dur = 0.3;
  private snap = false;
  private haveLast = false;
  /** вес слоя покоя 0..1 (входит и уходит плавно) */
  private idleW = 0;
  private time = Math.random() * 100;
  private seed = Math.random() * 10;
  private iq = new THREE.Quaternion();
  private tq = new THREE.Quaternion();
  private tq2 = new THREE.Quaternion();
  private ax = new THREE.Vector3();
  private spine: THREE.Object3D | null = null;
  private spine1: THREE.Object3D | null = null;
  /** последние переходы (debug/диагностика) */
  readonly log: { at: number; from: string; to: string; dur: number; jump: number }[] = [];

  constructor(
    model: THREE.Object3D,
    private info: (a: THREE.AnimationAction) => ClipPrepInfo | undefined,
    private rnd: () => number = Math.random,
  ) {
    model.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      // хвост и уши ведёт TailRig (сброс к покою каждый кадр) — переход им не нужен
      if (/Tail|Ear/.test(o.name)) return;
      const hasPos = /Hips$/.test(o.name);
      this.slots.push({ b: o, last: o.quaternion.clone(), off: new THREE.Quaternion(), hasPos, lastP: o.position.clone(), offP: new THREE.Vector3(), raw: o.quaternion.clone(), rawP: o.position.clone() });
      if (/Spine$/.test(o.name)) this.spine = o;
      if (/Spine1$/.test(o.name)) this.spine1 = o;
    });
  }

  /** реальная длительность одноразового клипа с учётом темпа */
  realDuration(a: THREE.AnimationAction) {
    return a.getClip().duration / (this.info(a)?.timeScale || 1);
  }

  /**
   * до mixer.update: смена клипа по ClipState.
   * Сначала кости возвращаются к чистому выходу миксера прошлого кадра: PropertyMixer пишет в кость только
   * изменившееся значение, и на неподвижном треке все поправки поверх клипа (переход, взгляд, выталкивание
   * рук из тела) иначе накапливались бы от кадра к кадру — рука «уезжала», голова дрейфовала.
   */
  sync(cs: ClipState, actions: Map<string, THREE.AnimationAction>, moveSpeed = 0) {
    if (this.haveLast) for (const s of this.slots) {
      s.b.quaternion.copy(s.raw);
      if (s.hasPos) s.b.position.copy(s.rawP);
    }
    const id = cs.cur.id;
    const retrig = id === this.playing && cs.cur !== this.track;
    if (id !== this.playing || retrig) {
      const next = actions.get(id) ?? null;
      const from = this.playing;
      this.playing = id;
      this.track = cs.cur;
      if (next) {
        const same = next === this.action;
        const ts = next.timeScale || 1;
        // та же петля (или псевдоним той же петли) — не перезапускаем
        const keepLoop = same && cs.cur.loop && next.isRunning();
        // та же реакция повторно в первой трети (частые тапы) — доигрывает, без перезапуска; таймер ClipState — по клипу
        const keepShot = same && !cs.cur.loop && next.isRunning() && next.time < next.getClip().duration * 0.35;
        if (keepShot) cs.cur.t = next.time / ts;
        if (!keepLoop && !keepShot) {
          if (this.action && !same) this.action.stop();
          next.reset();
          next.setLoop(cs.cur.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
          next.clampWhenFinished = !cs.cur.loop;
          next.setEffectiveWeight(1);
          next.timeScale = this.tempo(next, id, cs.idleMode, moveSpeed);
          // петля покоя — со случайной фазы: одинаковые idle не повторяются кадр в кадр
          if (cs.cur.loop && cs.idleMode) next.time = this.rnd() * next.getClip().duration;
          next.play();
          this.action = next;
          if (this.haveLast) {
            this.pending = true;
            this.from = from;
            this.t = 0;
            this.dur = blendSeconds(cs.cur.def.blendInMs, from, id);
            this.snap = !isCalm(id);
          }
        }
      } else if (this.action) {
        // клипа нет в модели — процедурная заглушка (glbCharacter): старый клип плавно уходит
        this.action.fadeOut(cs.cur.def.blendInMs / 1000);
        this.action = null;
      }
    } else if (this.action && (id === 'walk' || id === 'run')) {
      this.action.timeScale = this.tempo(this.action, id, false, moveSpeed);
    }
  }

  /** темп: из подготовки клипа; ходьба — под скорость сцены (лапы не скользят); idle — лёгкий разброс */
  private tempo(a: THREE.AnimationAction, id: string, idle: boolean, moveSpeed: number) {
    const inf = this.info(a);
    let s = inf?.timeScale ?? 1;
    if ((id === 'walk' || id === 'run') && moveSpeed > 0 && inf?.footSpeed && inf.footSpeed > 0.05) {
      s = THREE.MathUtils.clamp(moveSpeed / inf.footSpeed, 0.6, 1.6);
    } else if (idle) s *= 0.92 + this.rnd() * 0.16;
    return s;
  }

  /** после mixer.update: смещение перехода, слой покоя; снимок позы для следующего перехода */
  post(dt: number, cs: ClipState, frame: THREE.Object3D) {
    this.time += dt;
    const slots = this.slots;
    for (const s of slots) {
      s.raw.copy(s.b.quaternion);
      if (s.hasPos) s.rawP.copy(s.b.position);
    }
    if (this.pending) {
      // разница «показанная поза − первый кадр нового клипа»
      this.pending = false;
      let jump = 0;
      for (const s of slots) {
        s.off.copy(s.last).multiply(this.tq.copy(s.b.quaternion).invert());
        if (s.off.w < 0) s.off.set(-s.off.x, -s.off.y, -s.off.z, -s.off.w);
        jump = Math.max(jump, 2 * Math.acos(Math.min(1, Math.abs(s.off.w))));
        if (s.hasPos) s.offP.copy(s.lastP).sub(s.b.position);
      }
      // большой разрыв позы — дольше: пиковая скорость затухания ≈ 1,9 (snappy 1,5)·разрыв/длительность ≤ ~10 рад/с
      this.dur = Math.max(this.dur, Math.min(0.6, jump * (this.snap ? 0.15 : 0.19)));
      this.log.push({ at: +this.time.toFixed(2), from: this.from, to: this.playing, dur: +this.dur.toFixed(2), jump: +jump.toFixed(2) });
      if (this.log.length > 30) this.log.shift();
      this.t = 0;
    }
    if (this.t < this.dur) {
      this.t += dt;
      const w = this.snap ? snappy(this.t / this.dur) : 1 - smoother(this.t / this.dur);
      for (const s of slots) {
        if (w > 0) {
          this.tq.copy(this.iq).slerp(s.off, w);
          s.b.quaternion.premultiply(this.tq);
          if (s.hasPos) s.b.position.addScaledVector(s.offP, w);
        }
      }
    }
    // снимок до слоя покоя: слой добавляется каждый кадр заново, в смещение перехода он попадать не должен
    for (const s of slots) {
      s.last.copy(s.b.quaternion);
      if (s.hasPos) s.lastP.copy(s.b.position);
    }
    this.haveLast = true;
    // слой покоя: медленный перенос веса и покачивание корпуса (суммы синусов с несоизмеримыми периодами)
    const idleTarget = cs.idleMode ? 1 : 0;
    this.idleW += (idleTarget - this.idleW) * Math.min(1, dt * 2.5);
    if (this.idleW > 0.01) this.idleLayer(this.idleW, frame);
  }

  private idleLayer(w: number, frame: THREE.Object3D) {
    const t = this.time + this.seed;
    const n = (a: number, b: number, c: number) => (Math.sin(t * a) + 0.6 * Math.sin(t * b + 1.3) + 0.35 * Math.sin(t * c + 2.1)) / 1.95;
    // оси персонажа в мире
    const mq = frame.getWorldQuaternion(this.tq2);
    const fwd = this.ax.set(0, 0, 1).applyQuaternion(mq);
    // перенос веса: корпус клонится то к одной, то к другой лапе (период ~7–11 с), низ спины компенсирует
    const sway = n(0.62, 0.37, 1.13) * 0.035 * w;
    if (this.spine) rotWorld(this.spine, fwd, sway, this.tq);
    if (this.spine1) rotWorld(this.spine1, fwd, -sway * 0.45, this.tq);
    const up = this.ax.set(0, 1, 0).applyQuaternion(mq);
    // лёгкий поворот плеч
    if (this.spine1) rotWorld(this.spine1, up, n(0.41, 0.83, 1.37) * 0.04 * w, this.tq);
  }
}

/** поворот кости вокруг мировой оси */
function rotWorld(b: THREE.Object3D, axis: THREE.Vector3, angle: number, tmp: THREE.Quaternion) {
  if (!angle || !b.parent) return;
  b.parent.updateWorldMatrix(true, false);
  const pq = b.parent.getWorldQuaternion(tmp);
  const d = RW_D.setFromAxisAngle(axis, angle);
  const local = RW_L.copy(pq).invert().multiply(d).multiply(pq);
  b.quaternion.premultiply(local);
}
// временные для rotWorld (вызывается каждый кадр слоя покоя): без двух new Quaternion на вызов
const RW_D = new THREE.Quaternion();
const RW_L = new THREE.Quaternion();
