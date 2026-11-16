/**
 * Выбор вариантов без повторов подряд.
 * Для каждого ключа помним историю; исключаем последние min(memory, n-1) вариантов.
 * При n>=3 и memory=2 одна и та же реплика не прозвучит чаще чем раз в 3 срабатывания.
 */
export class NoRepeatPicker {
  private history = new Map<string, number[]>();
  constructor(private memory = 2, private random: () => number = Math.random) {}

  pickIndex(key: string, n: number): number {
    if (n <= 0) return -1;
    if (n === 1) return 0;
    const hist = this.history.get(key) ?? [];
    const banned = new Set(hist.slice(-Math.min(this.memory, n - 1)));
    const allowed: number[] = [];
    for (let i = 0; i < n; i++) if (!banned.has(i)) allowed.push(i);
    const idx = allowed[Math.floor(this.random() * allowed.length)];
    hist.push(idx);
    if (hist.length > 8) hist.shift();
    this.history.set(key, hist);
    return idx;
  }

  pick<T>(key: string, arr: readonly T[]): T | undefined {
    const i = this.pickIndex(key, arr.length);
    return i < 0 ? undefined : arr[i];
  }

  reset() {
    this.history.clear();
  }
}
