/**
 * Когда кот может заговорить сам (мысль вслух filler, «ты тут?» silence) — чистые правила, тестируются в Node.
 * Жалоба с iPhone: «общается только сам». Поэтому инициатива кота — редкая и вежливая:
 *  - между его инициативными репликами — не меньше minGapMs + случайно до jitterMs (в покое ≈ раз в 15–20 с);
 *  - ребёнок говорит (VAD) — кот не начинает;
 *  - после голоса/касания ребёнка — тишина afterUserMs (он, может, думает, что сказать дальше);
 *  - после любой реплики кота — afterCatMs; после реплики-вопроса — afterQuestionMs (ждём ответ дольше);
 *  - идёт диалог, кот говорит, очередь занята, пауза поддержки — нельзя.
 */
export interface InitiativeOpts {
  minGapMs: number;
  jitterMs: number;
  afterUserMs: number;
  afterCatMs: number;
  afterQuestionMs: number;
}
export const INITIATIVE_DEFAULTS: InitiativeOpts = { minGapMs: 15_000, jitterMs: 5_000, afterUserMs: 10_000, afterCatMs: 10_000, afterQuestionMs: 15_000 };

export interface InitiativeEnv {
  now: number;
  userSpeaking: boolean;
  lastUserAt: number;
  lastQuestionAt: number;
  /** кот говорит или в очереди есть реплика */
  busy: boolean;
  /** диалог ждёт ответа / поддержка / пауза */
  blocked: boolean;
}

export class InitiativeGate {
  private lastInitiative: number;
  private lastCatEnd = -1e9;
  private gap: number;
  constructor(private o: InitiativeOpts = INITIATIVE_DEFAULTS, private random: () => number = Math.random, start = 0) {
    // первая мысль вслух — не сразу после начала игры
    this.lastInitiative = start;
    this.gap = this.nextGap();
  }

  private nextGap() {
    return this.o.minGapMs + this.random() * this.o.jitterMs;
  }

  /** кот закончил любую реплику */
  catLine(now: number) {
    this.lastCatEnd = now;
  }

  /** кот заговорил сам — следующая инициатива не раньше чем через gap */
  fired(now: number) {
    this.lastInitiative = now;
    this.gap = this.nextGap();
  }

  /** сколько ещё ждать (0 — можно) */
  waitMs(e: InitiativeEnv): number {
    if (e.userSpeaking || e.busy || e.blocked) return Infinity;
    const o = this.o;
    return Math.max(0, this.lastInitiative + this.gap - e.now, e.lastUserAt + o.afterUserMs - e.now, this.lastCatEnd + o.afterCatMs - e.now, e.lastQuestionAt + o.afterQuestionMs - e.now);
  }

  allowed(e: InitiativeEnv): boolean {
    return this.waitMs(e) === 0;
  }
}

/**
 * Лестница тишины (docs/scenario/LOGIC.md): что кот делает сам, пока ребёнок ничего не делает.
 * Отсчёт — от последнего действия ребёнка (касание, кнопка, фраза) или конца мини-игры. Любое действие — с начала.
 *   12 с  — «ты тут?» (silence);
 *   30 с  — предлагает занятие (offer: загадка / камень-ножницы-бумага / повторялка / угадай эмоцию / танец / повтори движение — по кругу);
 *   55 с  — мысль вслух (filler);
 *   80 с  — предлагает следующее занятие;
 *   110 с — дремлет (doze): дальше молчит, пока ребёнок не разбудит.
 * Между репликами кота сам по себе — не меньше minGapMs, и не раньше afterCatMs после любой его реплики.
 */
export type IdleStep = 'silence' | 'offer' | 'filler' | 'doze';
export const IDLE_PLAN: readonly { at: number; step: IdleStep }[] = [
  { at: 12_000, step: 'silence' },
  { at: 30_000, step: 'offer' },
  { at: 55_000, step: 'filler' },
  { at: 80_000, step: 'offer' },
  { at: 110_000, step: 'doze' },
];
/** что кот предлагает сам — по кругу (узлы диалога offer в content/dialogs.json) */
export const OFFERS = ['riddle', 'rps', 'echo', 'emo', 'dance', 'simon'] as const;

export class IdleLadder {
  private since: number;
  private i = 0;
  private lastFired = -1e9;
  constructor(now = 0, private plan: readonly { at: number; step: IdleStep }[] = IDLE_PLAN, private minGapMs = 12_000, private afterCatMs = 4_000) {
    this.since = now;
  }
  /** ребёнок что-то сделал (или мини-игра закончилась) — лестница с начала */
  reset(now: number) {
    this.since = now;
    this.i = 0;
  }
  /** следующий шаг, если пора (env: кот молчит, диалога нет, ребёнок не говорит) */
  due(now: number, env: { quiet: boolean; lastCatEnd: number }): IdleStep | null {
    const p = this.plan[this.i];
    if (!p || !env.quiet) return null;
    if (now - this.since < p.at) return null;
    if (now - this.lastFired < this.minGapMs || now - env.lastCatEnd < this.afterCatMs) return null;
    return p.step;
  }
  /** шаг выполнен (или пропущен) — дальше по лестнице */
  fired(now: number) {
    this.i++;
    this.lastFired = now;
  }
  get step() {
    return this.i;
  }
  /** сколько длится тишина */
  quietFor(now: number) {
    return now - this.since;
  }
  get finished() {
    return this.i >= this.plan.length;
  }
}
