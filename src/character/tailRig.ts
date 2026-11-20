/**
 * Хвост и уши: вторичная анимация поверх любого клипа тела (Mixamo-клипы хвост и уши не трогают).
 *
 * Режим выбирается по клипу, additive-клипам каталога (tail_wag, tail_puff, ear_twitch, ears_back)
 * и пресету лица; у каждого характера своя манера (частота, размах, «щелчок» кончиком).
 * Каждый канал — пружина к цели, кончик мягче корня (запаздывает), поэтому движение идёт волной.
 * Инерция тела: поворот и прыжок таза подталкивают хвост в обратную сторону.
 *
 * Углы — в пространстве модели: swing — вокруг вертикали (вбок), lift — вокруг поперечной оси (вверх +),
 * у ушей fold — вперёд + / назад −, out — наружу +. Применение к костям — glbCharacter.
 */

export type TailMode =
  | 'idle' | 'wag' | 'puff' | 'sad' | 'angry' | 'curious' | 'walk' | 'run' | 'dance' | 'sleep' | 'purr' | 'whip';

export interface TailInput {
  clip: string;
  face: string;
  /** уровень ушей из пресета лица, −1 (прижаты) … 1 (торчком) */
  faceEars: number;
  additive: readonly string[];
  persona: string;
  speaking: number;
  /** угловая скорость таза вокруг вертикали, рад/с */
  hipsYawVel: number;
  /** вертикальная скорость таза, м/с (в масштабе модели ~1 м) */
  hipsUpVel: number;
}

export interface TailOutput {
  /** 4 сегмента: [swing, lift] */
  tail: [number, number][];
  earL: [number, number];
  earR: [number, number];
  mode: TailMode;
}

interface ModeDef {
  amp: number; // размах вбок у кончика, рад
  freq: number; // Гц
  lift: number; // подъём, рад (на сегмент)
  curl: number; // доп. подъём к кончику
  noise: number; // случайное блуждание
  stiff: number; // жёсткость пружин (1 — обычная)
  ears: number; // поправка ушей
  tremble?: number; // дрожь (мурчание, страх)
}

const MODES: Record<TailMode, ModeDef> = {
  idle: { amp: 0.24, freq: 0.32, lift: 0.04, curl: 0.12, noise: 0.08, stiff: 0.8, ears: 0 },
  wag: { amp: 0.55, freq: 1.6, lift: 0.18, curl: 0.18, noise: 0.05, stiff: 1.6, ears: 0.2 },
  puff: { amp: 0.06, freq: 4.0, lift: 0.6, curl: 0.0, noise: 0.02, stiff: 3.0, ears: 0.6, tremble: 0.05 },
  sad: { amp: 0.08, freq: 0.2, lift: -0.35, curl: -0.1, noise: 0.03, stiff: 0.6, ears: -0.6 },
  angry: { amp: 0.7, freq: 1.1, lift: 0.0, curl: 0.05, noise: 0.25, stiff: 2.2, ears: -0.5 },
  curious: { amp: 0.15, freq: 0.5, lift: 0.22, curl: 0.35, noise: 0.15, stiff: 1.2, ears: 0.5 },
  walk: { amp: 0.3, freq: 1.7, lift: 0.12, curl: 0.15, noise: 0.05, stiff: 1.4, ears: 0.1 },
  run: { amp: 0.2, freq: 3.0, lift: 0.05, curl: -0.05, noise: 0.05, stiff: 2.0, ears: -0.2 },
  dance: { amp: 0.75, freq: 1.0, lift: 0.25, curl: 0.25, noise: 0.05, stiff: 1.5, ears: 0.3 },
  sleep: { amp: 0.04, freq: 0.15, lift: -0.15, curl: 0.45, noise: 0.02, stiff: 0.4, ears: -0.3 },
  purr: { amp: 0.1, freq: 0.6, lift: 0.3, curl: 0.2, noise: 0.03, stiff: 1.0, ears: -0.1, tremble: 0.035 },
  whip: { amp: 0.9, freq: 2.4, lift: 0.4, curl: -0.1, noise: 0.1, stiff: 3.0, ears: 0.7, tremble: 0.03 },
};

/** манера характера */
const PERSONA: Record<string, { amp: number; freq: number; flick: number; bounce: number }> = {
  hooligan: { amp: 1.0, freq: 0.85, flick: 1.0, bounce: 0.2 }, // ленивый, щёлкает кончиком
  kind: { amp: 0.85, freq: 0.7, flick: 0.2, bounce: 0.3 }, // плавный, широкий
  glitter: { amp: 1.45, freq: 1.2, flick: 0.55, bounce: 1.2 }, // пружинит, кокетливо закручивает (20.11: «хвост неподвижен» — размах больше)
};

const HAPPY = /happy|smile|excited|proud|cheeky|wink|cheeks_gum/;
const SAD = /sad|dizzy|shy/;
const ANGRY = /annoyed|offended|angry/;
const SCARED = /surprised|pain_ears|squished/;
const CURIOUS = /listen|think/;

export function pickMode(i: Pick<TailInput, 'clip' | 'face' | 'additive'>): TailMode {
  const c = i.clip;
  if (c === 'poke_tail' || c === 'flinch' || c === 'wake_startle') return 'whip';
  if (i.additive.includes('tail_puff') || /scared|frightened|surprised|afraid|cover_ears/.test(c)) return 'puff';
  if (/sleep/.test(c)) return 'sleep';
  if (c === 'purr_stroke') return 'purr';
  if (/^dance|celebrate|idle_glitter_twirl|sing/.test(c)) return 'dance';
  if (c === 'run') return 'run';
  if (c === 'walk' || /^turn_/.test(c)) return 'walk';
  if (i.additive.includes('tail_wag')) return 'wag';
  if (/offended|annoyed/.test(c)) return 'angry';
  if (/^laugh|wave|jump|flip|proud|clap/.test(c)) return 'wag';
  if (/cry|sad|tumble|fall/.test(c)) return 'sad';
  if (/think|listen|lean_in|peek/.test(c)) return 'curious';
  if (SCARED.test(i.face)) return 'puff';
  if (ANGRY.test(i.face)) return 'angry';
  if (SAD.test(i.face)) return 'sad';
  if (HAPPY.test(i.face)) return 'wag';
  if (CURIOUS.test(i.face)) return 'curious';
  if (i.face === 'sleep') return 'sleep';
  if (i.face === 'purr') return 'purr';
  return 'idle';
}

/** критически задемпфированная пружина */
class Spring {
  v = 0;
  x = 0;
  step(target: number, k: number, dt: number) {
    const w = Math.sqrt(k);
    // полунеявный Эйлер с подшагами: устойчив и для жёстких пружин на 30–60 fps
    const n = Math.min(16, Math.max(1, Math.ceil((w * dt) / 0.25)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (k * (target - this.x) - 2 * w * this.v) * h;
      this.x += this.v * h;
    }
  }
}

const clampN = (v: number, a: number) => (Number.isFinite(v) ? Math.max(-a, Math.min(a, v)) : 0);

export class TailRig {
  /** множитель размаха (стенд «до/после»: scripts/qa/glitter-alive.mjs) */
  personaScale = 1;
  private t = 0;
  private sw = [0, 1, 2, 3].map(() => new Spring());
  private li = [0, 1, 2, 3].map(() => new Spring());
  private ear = { lf: new Spring(), lo: new Spring(), rf: new Spring(), ro: new Spring() };
  private mix: ModeDef = { ...MODES.idle };
  private wander = 0;
  private wanderV = 0;
  private flickT = 4;
  private flick = 0;
  private twitchT = 3;
  private twitch = { side: 0, t: 0 };
  private earsBackT = 0;
  private lastAdd = new Set<string>();
  mode: TailMode = 'idle';

  constructor(private rnd: () => number = Math.random) {}

  update(dt: number, i: TailInput): TailOutput {
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.t += dt;
    this.mode = pickMode(i);
    const target = MODES[this.mode];
    const p = PERSONA[i.persona] ?? PERSONA.kind;
    // плавная смена режима (~0.3 с)
    const k = 1 - Math.exp(-dt / 0.3);
    for (const key of Object.keys(target) as (keyof ModeDef)[]) {
      const a = (this.mix[key] as number | undefined) ?? 0;
      const b = (target[key] as number | undefined) ?? 0;
      (this.mix as unknown as Record<string, number>)[key] = a + (b - a) * k;
    }
    const m = this.mix;

    // случайное блуждание (ленивый хвост не идеально синусоидален)
    this.wanderV += (this.rnd() - 0.5) * 6 * dt - this.wanderV * 1.5 * dt;
    this.wander = clampN(this.wander + this.wanderV * dt, 1);

    // щелчок кончиком (у Хулигана чаще)
    this.flickT -= dt;
    if (this.flickT <= 0) {
      this.flick = (this.rnd() < 0.5 ? -1 : 1) * p.flick;
      this.flickT = 2.5 + this.rnd() * 5 / Math.max(0.2, p.flick);
    }
    this.flick *= Math.exp(-dt * 6);

    const freq = m.freq * p.freq;
    const amp = m.amp * p.amp * this.personaScale;
    const tail: [number, number][] = [];
    for (let s = 0; s < 4; s++) {
      const u = (s + 1) / 4; // 0.25 … 1 к кончику
      const lag = s * 0.55; // волна от корня к кончику
      const ph = this.t * freq * Math.PI * 2 - lag;
      let swing = Math.sin(ph) * amp * (0.15 + 0.3 * u) + this.wander * m.noise * u;
      let lift = m.lift * (1 - 0.3 * u) + m.curl * u * u;
      // Блёстка пружинит вверх-вниз в такт
      lift += Math.sin(ph * 2) * 0.05 * p.bounce * u;
      if (s === 3) swing += this.flick * 0.5;
      if (m.tremble) {
        swing += Math.sin(this.t * 37 + s) * m.tremble;
        lift += Math.sin(this.t * 31 + s * 2) * m.tremble;
      }
      // инерция тела: поворот → хвост отстаёт, прыжок вверх → хвост вниз
      swing -= i.hipsYawVel * 0.05 * u;
      lift -= i.hipsUpVel * 0.35 * u;
      // пружина в 2–3 раза быстрее частоты режима, иначе гасит взмах; кончик мягче → запаздывает
      const wn = Math.max(6, 2 * Math.PI * freq * 2.6) * Math.sqrt(m.stiff / 1.5);
      const kk = wn * wn * (1.2 - 0.5 * u);
      this.sw[s].step(swing, kk, dt);
      this.li[s].step(lift, kk, dt);
      tail.push([clampN(this.sw[s].x, 1.2), clampN(this.li[s].x, 1.2)]);
    }

    // уши
    for (const a of i.additive) if (!this.lastAdd.has(a) && a === 'ear_twitch') this.startTwitch();
    if (i.additive.includes('ears_back')) this.earsBackT = 0.6;
    this.lastAdd = new Set(i.additive);
    this.twitchT -= dt;
    if (this.twitchT <= 0) {
      this.startTwitch();
      this.twitchT = 2.5 + this.rnd() * 5;
    }
    this.twitch.t = Math.max(0, this.twitch.t - dt);
    this.earsBackT = Math.max(0, this.earsBackT - dt);
    const tw = this.twitch.t > 0 ? Math.sin((this.twitch.t / 0.18) * Math.PI) * 0.45 : 0;
    let fold = clampN(i.faceEars * 0.45 + m.ears * 0.35, 0.9);
    if (this.earsBackT > 0) fold = -0.85;
    const talk = i.speaking * 0.08 * Math.sin(this.t * 14);
    const listen = this.mode === 'curious' ? Math.sin(this.t * 1.3) * 0.25 : 0;
    const ek = 140;
    this.ear.lf.step(fold + talk + (this.twitch.side < 0 ? tw : 0), ek, dt);
    this.ear.rf.step(fold + talk + (this.twitch.side > 0 ? tw : 0), ek, dt);
    const out = fold < 0 ? -fold * 0.6 : 0; // прижатые уши расходятся в стороны
    this.ear.lo.step(out + listen + (m.tremble ?? 0) * Math.sin(this.t * 33), ek, dt);
    this.ear.ro.step(out - listen + (m.tremble ?? 0) * Math.sin(this.t * 29), ek, dt);
    return {
      tail,
      earL: [clampN(this.ear.lf.x, 1.2), clampN(this.ear.lo.x, 1)],
      earR: [clampN(this.ear.rf.x, 1.2), clampN(this.ear.ro.x, 1)],
      mode: this.mode,
    };
  }

  private startTwitch() {
    this.twitch = { side: this.rnd() < 0.5 ? -1 : 1, t: 0.18 };
  }
}
