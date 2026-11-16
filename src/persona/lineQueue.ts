/**
 * Очередь реплик, знающая характер и приоритет события (events.json):
 *   3 — безопасность (грустно/страшно, потеря карты): перебивает всё, очередь сбрасывается до неё;
 *   2 — сценарий/диалог: встаёт в очередь, если сейчас звучит реплика;
 *   1 — реакция на касание/голос: перебивает реакцию/фон и interruptible-сценарий, иначе отбрасывается;
 *   0 — фон (мысли вслух): только в тишине.
 * При смене характера реплики старого характера выкидываются из очереди, а уже звучащая
 * доигрывает до конца слога (player.stop(true)).
 */
import type { PersonaId } from './types';

export interface QueueItem {
  id: number;
  persona: PersonaId;
  event: string;
  priority: number;
  interruptible: boolean;
  run: () => Promise<void>;
}

export interface QueuePlayer {
  /** soft=true — остановить на ближайшей границе слога; промис — когда звук реально затих */
  stop(soft: boolean): void | Promise<void>;
}

export const MAX_QUEUE = 4;

export class LineQueue {
  private cur: QueueItem | null = null;
  private q: QueueItem[] = [];
  private seq = 0;
  private idleWaiters: (() => void)[] = [];
  /** звучащая реплика старого характера дорезается до конца слога — новые ждут */
  private stopping = false;
  constructor(private player: QueuePlayer) {}

  get busy() {
    return !!this.cur || this.q.length > 0 || this.stopping;
  }
  get current(): Readonly<QueueItem> | null {
    return this.cur;
  }
  get pending(): readonly Readonly<QueueItem>[] {
    return this.q;
  }

  /** true — реплика принята (играет или в очереди), false — отброшена */
  say(item: Omit<QueueItem, 'id'>): boolean {
    const it: QueueItem = { ...item, id: ++this.seq };
    const cur = this.cur;
    if (this.stopping) {
      if (it.priority <= 0) return false;
      this.q.push(it);
      return true;
    }
    if (!cur) {
      this.start(it);
      return true;
    }
    if (it.priority >= 3) {
      this.q = this.q.filter((x) => x.priority >= 3);
      if (cur.priority >= 3) this.q.push(it);
      else {
        this.interrupt(false);
        this.start(it);
      }
      return true;
    }
    if (it.priority === 2) {
      if (cur.priority <= 0) {
        this.interrupt(false);
        this.start(it);
        return true;
      }
      if (this.q.length >= MAX_QUEUE) {
        const i = this.q.findIndex((x) => x.priority < 2);
        if (i < 0) return false;
        this.q.splice(i, 1);
      }
      this.q.push(it);
      return true;
    }
    if (it.priority === 1) {
      if (cur.priority >= 3) return false;
      if (cur.priority === 2 && !cur.interruptible) return false;
      // реакция — сейчас или никогда: старые реакции из очереди убираем
      this.q = this.q.filter((x) => x.priority >= 2);
      this.interrupt(false);
      this.start(it);
      return true;
    }
    return false; // фон — только в тишине
  }

  /** сменился характер: выкинуть чужие реплики, звучащую — мягко дорезать */
  switchPersona(to: PersonaId) {
    this.q = this.q.filter((x) => x.persona === to);
    if (this.cur && this.cur.persona !== to) {
      this.cur = null;
      this.stopping = true;
      void Promise.resolve(this.player.stop(true)).finally(() => {
        this.stopping = false;
        if (!this.cur) this.next();
      });
    }
  }

  clear() {
    this.q = [];
    this.stopping = false;
    this.interrupt(false);
    this.flushIdle();
  }

  /** дождаться тишины (для окна ответа: микрофон открывается после реплики) */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private interrupt(soft: boolean) {
    if (!this.cur) return;
    this.cur = null;
    this.player.stop(soft);
  }

  private start(it: QueueItem) {
    this.cur = it;
    let p: Promise<void>;
    try {
      p = it.run();
    } catch {
      p = Promise.resolve();
    }
    void p.catch(() => undefined).finally(() => {
      if (this.cur?.id !== it.id) return;
      this.cur = null;
      this.next();
    });
  }

  private next() {
    const n = this.q.shift();
    if (n) this.start(n);
    else this.flushIdle();
  }

  private flushIdle() {
    if (this.cur || this.q.length || this.stopping) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    w.forEach((f) => f());
  }
}
