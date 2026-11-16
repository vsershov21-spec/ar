/** Маленький типизированный эмиттер событий. */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.map.get(type)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[emitter] ${String(type)}`, e);
      }
    });
  }
}
