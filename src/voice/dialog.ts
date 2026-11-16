/**
 * Очередь реплик с приоритетами:
 *  scenario (3) — реплики сценария: не прерываются касаниями, идут по очереди;
 *  reaction (2) — реакции на касания/голос: прерывают болтовню и друг друга, но не сценарий;
 *  chatter  (1) — «заполнители» пауз: только когда тихо, прерываются всем.
 */
export type Priority = 'scenario' | 'reaction' | 'chatter';
export const RANK: Record<Priority, number> = { scenario: 3, reaction: 2, chatter: 1 };

export interface DialogItem { id: number; prio: Priority; run: () => Promise<void> }

export interface DialogPlayer {
  cancel(): void;
}

export class DialogQueue {
  private current: DialogItem | null = null;
  private queue: DialogItem[] = [];
  private seq = 0;
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
      const next = this.queue.shift();
      if (next) this.start(next);
    });
  }

  clear() {
    this.queue = [];
    this.interrupt();
  }
}
