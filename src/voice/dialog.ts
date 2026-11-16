/**
 * Очередь реплик с приоритетами:
 *  scenario (3) — реплики сценария: не прерываются касаниями, идут по очереди;
 *  reaction (2) — реакции на касания/голос: прерывают болтовню и друг друга, но не сценарий;
 *  chatter  (1) — «заполнители» пауз: только когда тихо, прерываются всем.
 * Перебивание ребёнком (barge-in): bargeIn() — текущая реплика затухает (player.fadeOut), очередь
 * сценария сохраняется, но держится (hold), пока ребёнок говорит и пока не придёт ответ; release() — дальше.
 */
export type Priority = 'scenario' | 'reaction' | 'chatter';
export const RANK: Record<Priority, number> = { scenario: 3, reaction: 2, chatter: 1 };

export interface DialogItem { id: number; prio: Priority; run: () => Promise<void> }

export interface DialogPlayer {
  cancel(): void;
  /** плавно остановить (перебили); если нет — cancel() */
  fadeOut?(ms: number): void;
}

export class DialogQueue {
  private current: DialogItem | null = null;
  private queue: DialogItem[] = [];
  private seq = 0;
  private holdTimer = 0;
  /** очередь «на паузе»: новые реплики не стартуют (ребёнок говорит) */
  held = false;
  constructor(private player: DialogPlayer) {}

  get busy() {
    return !!this.current;
  }
  get currentPriority(): Priority | null {
    return this.current?.prio ?? null;
  }

  /** true — реплика принята (сыграна или поставлена в очередь), false — отброшена */
  say(prio: Priority, run: () => Promise<void>): boolean {
    const item = { id: ++this.seq, prio, run };
    const cur = this.current;
    if (this.held && !cur) {
      if (prio === 'chatter') return false;
      if (prio === 'reaction') this.queue = this.queue.filter((q) => q.prio === 'scenario');
      this.queue.push(item);
      return true;
    }
    if (!cur) {
      this.start(item);
      return true;
    }
    if (prio === 'scenario') {
      if (cur.prio === 'scenario' || cur.prio === 'reaction') {
        this.queue.push(item);
      } else {
        this.interrupt();
        this.start(item);
      }
      return true;
    }
    if (prio === 'reaction') {
      if (cur.prio === 'scenario') return false; // сценарий не перебиваем
      this.interrupt();
      this.queue = this.queue.filter((q) => q.prio === 'scenario');
      this.start(item);
      return true;
    }
    return false; // болтовня — только в тишине
  }

  private interrupt() {
    this.current = null;
    this.player.cancel();
  }

  private start(item: DialogItem) {
    this.current = item;
    void item.run().finally(() => {
      if (this.current?.id !== item.id) return;
      this.current = null;
      this.next();
    });
  }

  private next() {
    if (this.held || this.current) return;
    const n = this.queue.shift();
    if (n) this.start(n);
  }

  /**
   * Ребёнок перебил: текущая реплика затухает за fadeMs, очередь держится до release() (или maxHoldMs).
   * Болтовня (chatter) из очереди выбрасывается, сценарий — остаётся.
   */
  bargeIn(fadeMs = 120, maxHoldMs = 8000) {
    this.hold(maxHoldMs);
    if (this.current) {
      this.current = null;
      if (this.player.fadeOut) this.player.fadeOut(fadeMs);
      else this.player.cancel();
    }
    this.queue = this.queue.filter((q) => q.prio !== 'chatter');
  }

  hold(maxMs = 8000) {
    this.held = true;
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.release(), maxMs) as unknown as number;
  }

  release() {
    clearTimeout(this.holdTimer);
    if (!this.held) return;
    this.held = false;
    this.next();
  }

  get pending() {
    return this.queue.map((q) => q.prio);
  }

  clear() {
    this.queue = [];
    this.interrupt();
  }
}
