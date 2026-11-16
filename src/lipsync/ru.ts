/**
 * Русский липсинк: фонемы → виземы Rhubarb (A–H, X) → тайминг по сигналу.
 *
 * Зачем свой путь: rhubarb-lip-sync-wasm распознаёт английский (PocketSphinx), для русского формы
 * рта получаются случайными. Здесь фонемы известны заранее (это текст реплики), нужно только
 * разложить их по времени. Источник фонем — espeak-ng (`espeak-ng -v ru --ipa`, тот же фонемизатор,
 * что внутри Piper), а если его нет — буквенные правила (G2P-lite) ниже.
 *
 * Тайминг (`alignPhones`): принудительное выравнивание Витерби по двум признакам кадра 10 мс —
 * громкость (лог-RMS) и доля пересечений нуля (шипящие/свистящие). Гласные «хотят» громких тональных
 * кадров, фрикативные — шумных, смычные — тихих, паузы — тишины; у каждой фонемы минимальная длительность.
 * Длительности Piper не отдаёт (у C++-релиза 2023.11.14-2 нет вывода выравнивания), поэтому так.
 *
 * Маппинг (Rhubarb: https://github.com/DanielSWolf/rhubarb-lip-sync#mouth-shapes):
 *   A  м б п (+мягкие)              — губы сомкнуты
 *   B  и ы, т д н с з ц к г х й р, ш ж щ ч — «зубы сомкнуты, рот чуть открыт» (так Rhubarb делает и для SH/CH/ZH)
 *   C  э е, редуцированный [ə]      — открыт
 *   D  а я, [ɐ]                     — широко открыт
 *   E  о ё [ɵ]                      — округлый
 *   F  у ю                          — трубочкой; согласный перед «у» тоже округляется (предвосхищение)
 *   G  ф в                          — верхние зубы на нижней губе
 *   H  л                            — язык (только если «л» длиннее 50 мс, иначе B)
 *   X  пауза                        — покой
 */
import type { MouthCue, Viseme } from './visemes';

export type PhoneClass = 'V' | 'S' | 'F' | 'P' | 'X';
export interface Phone { p: string; v: Viseme; c: PhoneClass; stress?: boolean }

// ───────────────────── IPA (espeak-ng) ─────────────────────

const IPA: Record<string, [Viseme, PhoneClass]> = {
  a: ['D', 'V'], ɐ: ['D', 'V'], ɑ: ['D', 'V'], æ: ['D', 'V'], ʌ: ['D', 'V'],
  e: ['C', 'V'], ɛ: ['C', 'V'], ə: ['C', 'V'],
  i: ['B', 'V'], ɪ: ['B', 'V'], ɨ: ['B', 'V'], y: ['B', 'V'],
  o: ['E', 'V'], ɔ: ['E', 'V'], ɵ: ['E', 'V'],
  u: ['F', 'V'], ʊ: ['F', 'V'], ʉ: ['F', 'V'], w: ['F', 'S'],
  m: ['A', 'S'], p: ['A', 'P'], b: ['A', 'P'],
  f: ['G', 'F'], v: ['G', 'S'],
  l: ['H', 'S'], ɫ: ['H', 'S'], ɭ: ['H', 'S'], ʎ: ['H', 'S'],
  n: ['B', 'S'], ɲ: ['B', 'S'], ŋ: ['B', 'S'], r: ['B', 'S'], ɾ: ['B', 'S'], j: ['B', 'S'],
  t: ['B', 'P'], d: ['B', 'P'], k: ['B', 'P'], g: ['B', 'P'], ɡ: ['B', 'P'], c: ['B', 'P'], ɟ: ['B', 'P'],
  s: ['B', 'F'], z: ['B', 'F'], ʂ: ['B', 'F'], ʐ: ['B', 'F'], ʃ: ['B', 'F'], ʒ: ['B', 'F'], ɕ: ['B', 'F'], ʑ: ['B', 'F'],
  x: ['B', 'F'], ɣ: ['B', 'F'], h: ['B', 'F'], ç: ['B', 'F'],
};

/** Слова IPA (вывод `espeak-ng -v ru -q --ipa`, строки = клаузы) → фонемы с паузами между клаузами. */
export function phonesFromIpa(ipa: string): Phone[] {
  const out: Phone[] = [];
  const clauses = ipa.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  clauses.forEach((cl, ci) => {
    if (ci > 0) out.push({ p: '|', v: 'X', c: 'X' });
    cl.split(/\s+/).forEach((w, wi) => {
      if (wi > 0) out.push({ p: '_', v: 'X', c: 'X' }); // межсловная пауза — необязательная
      let stress = false;
      for (const ch of w) {
        if (ch === 'ˈ' || ch === 'ˌ') {
          stress = true;
          continue;
        }
        if (ch === 'ʲ' || ch === 'ː' || ch === '_' || ch === '͡' || ch === 'ʰ') continue;
        const m = IPA[ch];
        if (!m) continue;
        out.push({ p: ch, v: m[0], c: m[1], stress: m[1] === 'V' ? stress : undefined });
        if (m[1] === 'V') stress = false;
      }
    });
  });
  return out;
}

// ───────────────────── буквы (запасной G2P) ─────────────────────

const LET: Record<string, [Viseme, PhoneClass]> = {
  а: ['D', 'V'], я: ['D', 'V'], о: ['E', 'V'], ё: ['E', 'V'], у: ['F', 'V'], ю: ['F', 'V'],
  э: ['C', 'V'], е: ['C', 'V'], и: ['B', 'V'], ы: ['B', 'V'],
  м: ['A', 'S'], б: ['A', 'P'], п: ['A', 'P'], ф: ['G', 'F'], в: ['G', 'S'], л: ['H', 'S'],
  н: ['B', 'S'], р: ['B', 'S'], й: ['B', 'S'], т: ['B', 'P'], д: ['B', 'P'], к: ['B', 'P'], г: ['B', 'P'],
  с: ['B', 'F'], з: ['B', 'F'], ш: ['B', 'F'], ж: ['B', 'F'], щ: ['B', 'F'], ч: ['B', 'F'], ц: ['B', 'F'], х: ['B', 'F'],
};

/** Текст → фонемы по буквам (без ударений: безударное «о» остаётся E — это заметно лишь при замедлении). */
export function phonesFromText(text: string): Phone[] {
  const out: Phone[] = [];
  const t = text.toLowerCase();
  let prevSpace = false;
  for (const ch of t) {
    if (/[.!?…;:—()]/.test(ch) || ch === ',') {
      if (out.length && out[out.length - 1].c !== 'X') out.push({ p: '|', v: 'X', c: 'X' });
      prevSpace = false;
      continue;
    }
    if (/\s|-/.test(ch)) {
      prevSpace = true;
      continue;
    }
    const m = LET[ch];
    if (!m) continue;
    if (prevSpace && out.length && out[out.length - 1].c !== 'X') out.push({ p: '_', v: 'X', c: 'X' });
    prevSpace = false;
    out.push({ p: ch, v: m[0], c: m[1] });
  }
  while (out.length && out[out.length - 1].c === 'X') out.pop();
  return out;
}

// ───────────────────── выравнивание ─────────────────────

const MIN_FRAMES: Record<PhoneClass, number> = { V: 4, S: 3, F: 3, P: 3, X: 1 };

/** оценка «насколько кадр похож на класс»; e — громкость 0..1, z — шумность 0..1 */
function emit(c: PhoneClass, e: number, z: number, weak = false) {
  switch (c) {
    // безударные (редуцированные) гласные заметно тише ударных — ждём от них средней громкости
    case 'V': return weak ? -4 * Math.max(0, 0.7 - e) ** 2 - 1.5 * (e - 0.7) ** 2 - 2 * z * z : -4 * (1 - e) ** 2 - 2 * z * z;
    case 'S': return -4 * (e - 0.62) ** 2 - 1.5 * z * z;
    case 'F': return -3 * (e - 0.45) ** 2 - 3 * (1 - z) ** 2;
    case 'P': return -4 * (e - 0.25) ** 2 - 0.5 * (z - 0.4) ** 2;
    case 'X': return -10 * e * e;
  }
}

export interface AlignInput { rms: Float32Array; zcr: Float32Array; step: number }

/**
 * Принудительное выравнивание фонем по кадрам (Витерби, лево-правая модель).
 * Паузы между словами («_») можно пропустить; тишина в начале/конце допускается.
 * Возвращает [start, end) в секундах для каждой фонемы (у пропущенных пауз start === end).
 */
export function alignPhones(phones: Phone[], f: AlignInput): { start: number; end: number }[] {
  const T = f.rms.length;
  if (!phones.length || !T) return phones.map(() => ({ start: 0, end: 0 }));
  // нормализация признаков
  const db = Array.from(f.rms, (r) => 20 * Math.log10(Math.max(r, 1e-6)));
  const sorted = [...db].sort((a, b) => a - b);
  const hi = sorted[Math.floor(sorted.length * 0.95)], lo = Math.max(sorted[Math.floor(sorted.length * 0.05)], hi - 50);
  const E = db.map((d) => Math.min(1, Math.max(0, (d - lo) / Math.max(6, hi - lo))));
  const zs = [...f.zcr].sort((a, b) => a - b);
  const zhi = Math.max(zs[Math.floor(zs.length * 0.95)], 0.05);
  const Z = Array.from(f.zcr, (z) => Math.min(1, z / zhi));
  // состояния: [тишина начала] + фонемы, развёрнутые в цепочки minDur + [тишина конца]
  type St = { ph: number; c: PhoneClass; first: boolean; last: boolean; optional: boolean; weak?: boolean };
  const st: St[] = [{ ph: -1, c: 'X', first: true, last: true, optional: true }];
  const hasStress = phones.some((p) => p.stress);
  phones.forEach((p, i) => {
    const n = Math.max(1, Math.min(MIN_FRAMES[p.c], Math.floor(T / (phones.length + 2))));
    const weak = p.c === 'V' && p.stress === false && hasStress;
    for (let k = 0; k < n; k++) st.push({ ph: i, c: p.c, first: k === 0, last: k === n - 1, optional: p.p === '_' || p.p === '|', weak });
  });
  st.push({ ph: -2, c: 'X', first: true, last: true, optional: true });
  const S = st.length;
  // переходы: self (только у last), next; пропуск необязательной фонемы целиком
  const NEG = -1e18;
  let prev = new Float64Array(S).fill(NEG), cur = new Float64Array(S);
  const back = new Int32Array(T * S);
  // вход: начальная тишина или первая фонема (фраза не начинается с паузы)
  const entry = [0, 1];
  const nextFrom = (s: number): number[] => {
    const r: number[] = [];
    let n = s + 1;
    if (n >= S) return r;
    r.push(n);
    // если следующая фонема — необязательная пауза, можно перепрыгнуть её цепочку
    while (n < S && st[n].optional && st[n].first) {
      let m = n;
      while (m < S && st[m].ph === st[n].ph) m++;
      if (m < S) r.push(m);
      n = m;
    }
    return r;
  };
  const succ: number[][] = st.map((_, s) => nextFrom(s));
  for (const s of entry) {
    prev[s] = emit(st[s].c, E[0], Z[0], st[s].weak);
  }
  for (let t = 1; t < T; t++) {
    cur.fill(NEG);
    for (let s = 0; s < S; s++) {
      const v = prev[s];
      if (v <= NEG / 2) continue;
      if (st[s].last && v > cur[s]) {
        cur[s] = v;
        back[t * S + s] = s;
      }
      for (const n of succ[s]) {
        if (v > cur[n]) {
          cur[n] = v;
          back[t * S + n] = s;
        }
      }
    }
    for (let s = 0; s < S; s++) if (cur[s] > NEG / 2) cur[s] += emit(st[s].c, E[t], Z[t], st[s].weak);
    [prev, cur] = [cur, prev];
  }
  // выход: из конечной тишины или последнего состояния последней фонемы
  let best = S - 1;
  const lastPh = S - 2;
  if (prev[lastPh] > prev[best]) best = lastPh;
  if (prev[best] <= NEG / 2) {
    // не уложились (очень короткий звук) — равномерно
    const dur = T * f.step;
    return phones.map((_, i) => ({ start: (i / phones.length) * dur, end: ((i + 1) / phones.length) * dur }));
  }
  const path = new Int32Array(T);
  path[T - 1] = best;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t * S + path[t]];
  const res = phones.map(() => ({ start: -1, end: -1 }));
  for (let t = 0; t < T; t++) {
    const ph = st[path[t]].ph;
    if (ph < 0) continue;
    if (res[ph].start < 0) res[ph].start = t * f.step;
    res[ph].end = (t + 1) * f.step;
  }
  // пропущенные паузы — нулевой длины в месте стыка
  for (let i = 0; i < res.length; i++) {
    if (res[i].start < 0) {
      const at = i > 0 ? res[i - 1].end : 0;
      res[i] = { start: at, end: at };
    }
  }
  return res;
}

// ───────────────────── сборка cues ─────────────────────

/** Фонемы + тайминг → cues Rhubarb; короткие (< minSec) сливаются с соседями. */
export function cuesFromAlignment(phones: Phone[], times: { start: number; end: number }[], total: number, minSec = 0.04): MouthCue[] {
  const raw: MouthCue[] = [];
  for (let i = 0; i < phones.length; i++) {
    const { start, end } = times[i];
    if (end - start <= 0) continue;
    let v: Viseme = phones[i].v;
    // предвосхищение округления: согласный перед «у/о» уже с округлёнными губами
    if (phones[i].c !== 'V' && phones[i].c !== 'X' && v === 'B') {
      const nx = phones[i + 1];
      if (nx && (nx.v === 'F' || nx.v === 'E') && nx.c === 'V') v = nx.v;
    }
    if (v === 'H' && end - start < 0.05) v = 'B';
    raw.push({ start, end, value: v });
  }
  return finalizeCues(raw, total, minSec);
}

/** Слить одинаковые соседние, поглотить короткие, заполнить дыры X, обрезать по total. */
export function finalizeCues(raw: MouthCue[], total: number, minSec = 0.04): MouthCue[] {
  const a: MouthCue[] = [];
  let at = 0;
  for (const c of raw) {
    const s = Math.max(at, c.start), e = Math.min(total, c.end);
    if (e <= s) continue;
    if (s > at + 1e-6) a.push({ start: at, end: s, value: 'X' });
    a.push({ start: s, end: e, value: c.value });
    at = e;
  }
  if (at < total) a.push({ start: at, end: total, value: 'X' });
  mergeSame(a);
  // короткие → к соседу (кроме смыкания губ A: оно важно даже коротким, но не короче 30 мс)
  for (let i = 0; i < a.length; i++) {
    const d = a[i].end - a[i].start;
    const keep = a[i].value === 'A' ? d >= 0.03 : d >= minSec;
    if (keep || a.length < 2) continue;
    if (i > 0) a[i - 1].end = a[i].end;
    else a[i + 1].start = a[i].start;
    a.splice(i, 1);
    i = Math.max(-1, i - 2);
  }
  mergeSame(a);
  const out = a.map((c) => ({ start: +c.start.toFixed(3), end: +c.end.toFixed(3), value: c.value }));
  if (out.length) out[out.length - 1].end = +total.toFixed(3);
  return out;
}
function mergeSame(a: MouthCue[]) {
  for (let i = 1; i < a.length; i++) {
    if (a[i].value === a[i - 1].value) {
      a[i - 1].end = a[i].end;
      a.splice(i, 1);
      i--;
    }
  }
}

/**
 * Стратегия «амплитуда» (аналог wawa): форма рта только по громкости кадра.
 * Тихо → X/B, средне → C, громко → D; короткие провалы громкости внутри речи → A (смыкание).
 */
export function cuesFromAmplitude(f: AlignInput, total: number): MouthCue[] {
  const db = Array.from(f.rms, (r) => 20 * Math.log10(Math.max(r, 1e-6)));
  const sorted = [...db].sort((a, b) => a - b);
  const hi = sorted[Math.floor(sorted.length * 0.95)] ?? -20;
  const raw: MouthCue[] = [];
  for (let t = 0; t < db.length; t++) {
    const rel = db[t] - hi;
    let v: Viseme = rel < -32 ? 'X' : rel < -18 ? 'B' : rel < -8 ? 'C' : 'D';
    // провал между двумя громкими кадрами — смыкание губ
    if (v === 'B' && t > 2 && t < db.length - 3 && db[t - 3] - hi > -10 && db[t + 3] - hi > -10) v = 'A';
    raw.push({ start: t * f.step, end: (t + 1) * f.step, value: v });
  }
  return finalizeCues(raw, total, 0.05);
}

/** «Раскрытие рта» во времени (для сравнения стратегий): 0..1 по cues */
export const OPEN: Record<string, number> = { X: 0, A: 0, B: 0.2, C: 0.45, D: 0.9, E: 0.55, F: 0.25, G: 0.12, H: 0.4 };
export function opennessTrack(cues: MouthCue[], step: number, n: number): Float32Array {
  const o = new Float32Array(n);
  let ci = 0;
  for (let t = 0; t < n; t++) {
    const time = (t + 0.5) * step;
    while (ci < cues.length - 1 && cues[ci].end <= time) ci++;
    o[t] = OPEN[cues[ci]?.value] ?? 0;
  }
  return o;
}
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>) {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) (ma += a[i]), (mb += b[i]);
  ma /= n;
  mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
