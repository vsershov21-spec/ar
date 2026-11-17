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
