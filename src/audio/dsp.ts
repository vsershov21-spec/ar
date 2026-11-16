/**
 * Обработка звука без зависимостей: работает и в браузере (повтор «эхо»), и в Node (сборка озвучки,
 * `node scripts/voice/piper.mjs` импортирует этот файл напрямую — поэтому здесь нет импортов).
 *
 *  - pitchShift: сдвиг тона с сохранением длительности (фазовый вокодер с фазовой привязкой к пикам
 *    спектра — Laroche & Dolson «identity phase locking»: меньше «металла» и «бочки», чем у простого
 *    вокодера, и без «бурундука» по темпу) + пересэмплирование окном Ланцоша;
 *  - timeStretch: изменение темпа без изменения тона;
 *  - loudnessLufs / normalizeLoudness: громкость по EBU R128 / ITU-R BS.1770 (K-фильтр, гейты −70 и −10 LU)
 *    и мягкий пиковый лимитер;
 *  - frames: огибающая (RMS) и доля пересечений нуля по кадрам — для VAD, липсинка и выравнивания.
 */

// ───────────────────────── FFT ─────────────────────────

/** Комплексное БПФ на месте (радикс-2), n — степень двойки. inverse — без деления на n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const hann = (n: number) => {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
};
const wrap = (p: number) => p - 2 * Math.PI * Math.round(p / (2 * Math.PI));

// ───────────────────── темп и тон ─────────────────────

export interface StretchOpts { /** размер окна (степень двойки); по умолчанию ~46 мс */ fftSize?: number }

/**
 * Растянуть/сжать по времени без изменения тона. factor — во сколько раз длиннее станет звук.
 * Фазовый вокодер, шаг синтеза N/4, фазовая привязка к локальным максимумам спектра.
 */
export function timeStretch(x: Float32Array, sampleRate: number, factor: number, opts: StretchOpts = {}): Float32Array {
  if (Math.abs(factor - 1) < 1e-4 || x.length === 0) return Float32Array.from(x);
  let N = opts.fftSize ?? 0;
  if (!N) {
    N = 256;
    while (N < sampleRate * 0.046) N <<= 1;
  }
  const Hs = N / 4;
  const Ha = Hs / factor;
  const win = hann(N);
  const outLen = Math.round(x.length * factor);
  const out = new Float64Array(outLen + N);
  const norm = new Float64Array(outLen + N);
  const bins = N / 2 + 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const mag = new Float64Array(bins), ph = new Float64Array(bins);
  const prevPh = new Float64Array(bins), synPh = new Float64Array(bins);
  const peaks = new Int32Array(bins), peakPh = new Float64Array(bins);
  const frames = Math.ceil(outLen / Hs) + 1;
  let prevPos = -1;
  for (let t = 0; t < frames; t++) {
    const pos = Math.round(t * Ha) - N / 2; // центр окна — на t*Ha
    for (let i = 0; i < N; i++) {
      const j = pos + i;
      re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
    }
    if (t === 0) {
      synPh.set(ph);
    } else {
      const da = pos - prevPos; // фактический шаг анализа (целые отсчёты)
      // пики спектра
      let nPeaks = 0;
      for (let k = 2; k < bins - 2; k++) {
        const m = mag[k];
        if (m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) peaks[nPeaks++] = k;
      }
      if (!nPeaks) peaks[nPeaks++] = 1;
      // фаза пиков: накопление по мгновенной частоте
      for (let q = 0; q < nPeaks; q++) {
        const p = peaks[q];
        const omega = (2 * Math.PI * p) / N;
        const inst = omega + wrap(ph[p] - prevPh[p] - omega * da) / da;
        peakPh[q] = synPh[p] + inst * Hs;
      }
      // остальные полосы — относительно ближайшего пика (граница — посередине между пиками)
      let q = 0;
      for (let k = 0; k < bins; k++) {
        while (q < nPeaks - 1 && Math.abs(peaks[q + 1] - k) < Math.abs(peaks[q] - k)) q++;
        synPh[k] = peakPh[q] + (ph[k] - ph[peaks[q]]);
      }
    }
    prevPh.set(ph);
    prevPos = pos;
    for (let k = 0; k < bins; k++) {
      re[k] = mag[k] * Math.cos(synPh[k]);
      im[k] = mag[k] * Math.sin(synPh[k]);
    }
    for (let k = 1; k < N / 2; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    fft(re, im, true);
    const o = t * Hs - N / 2;
    for (let i = 0; i < N; i++) {
      const j = o + i;
      if (j < 0 || j >= out.length) continue;
      out[j] += (re[i] / N) * win[i];
      norm[j] += win[i] * win[i];
    }
  }
  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) y[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return y;
}

/** Пересэмплирование (окно Ланцоша, a=8). ratio = новая частота / старая. */
export function resample(x: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-6) return Float32Array.from(x);
  const a = 8;
  const n = Math.max(1, Math.round(x.length * ratio));
  const y = new Float32Array(n);
  const cutoff = Math.min(1, ratio); // при понижении частоты — фильтр против наложения
  for (let i = 0; i < n; i++) {
    const c = i / ratio;
    const c0 = Math.floor(c);
    let s = 0, ws = 0;
    for (let j = c0 - a + 1; j <= c0 + a; j++) {
      if (j < 0 || j >= x.length) continue;
      const d = (c - j) * cutoff;
      const w = d === 0 ? 1 : (a * Math.sin(Math.PI * d) * Math.sin((Math.PI * d) / a)) / (Math.PI * Math.PI * d * d);
      s += x[j] * w;
      ws += w;
    }
    y[i] = ws ? s / ws : 0;
  }
  return y;
}

/**
 * Сдвиг тона на semitones полутонов; tempo — темп (1 — исходная длительность, 1.1 — на 10% быстрее).
 * Итоговая длина = длина / tempo.
 */
export function pitchShift(x: Float32Array, sampleRate: number, semitones: number, tempo = 1): Float32Array {
  const r = Math.pow(2, semitones / 12);
  if (Math.abs(semitones) < 1e-3) return timeStretch(x, sampleRate, 1 / tempo);
  const stretched = timeStretch(x, sampleRate, r / tempo);
  return resample(stretched, 1 / r);
}

// ───────────────────── громкость ─────────────────────

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }
/** K-фильтр BS.1770 для любой частоты дискретизации (как в pyloudnorm) */
function kFilters(sr: number): Biquad[] {
  // high shelf
  let G = 3.999843853973347, Q = 0.7071752369554196, fc = 1681.974450955533;
  let K = Math.tan((Math.PI * fc) / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  // high pass
  Q = 0.5003270373238773; fc = 38.13547087602444; G = 0;
  K = Math.tan((Math.PI * fc) / sr);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  void G;
  return [shelf, hp];
}
function biquad(x: Float32Array, f: Biquad) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** Интегральная громкость, LUFS (моно). -Infinity для тишины. */
export function loudnessLufs(x: Float32Array, sr: number): number {
  let y = x;
  for (const f of kFilters(sr)) y = biquad(y, f);
  const block = Math.round(0.4 * sr), step = Math.round(0.1 * sr);
  const ms: number[] = [];
  if (y.length < block) {
    let s = 0;
    for (let i = 0; i < y.length; i++) s += y[i] * y[i];
    ms.push(s / Math.max(1, y.length));
  } else {
    for (let o = 0; o + block <= y.length; o += step) {
      let s = 0;
      for (let i = o; i < o + block; i++) s += y[i] * y[i];
      ms.push(s / block);
    }
  }
  const L = (m: number) => -0.691 + 10 * Math.log10(m);
  const abs = ms.filter((m) => m > 0 && L(m) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter((m) => L(m) > rel);
  return L(g.reduce((a, b) => a + b, 0) / g.length);
}

/** Привести к targetLufs, пики не выше peakDb (мягкий лимитер с упреждением 5 мс). */
export function normalizeLoudness(x: Float32Array, sr: number, targetLufs = -16, peakDb = -1.5): Float32Array {
  const l = loudnessLufs(x, sr);
  if (!isFinite(l)) return Float32Array.from(x);
  const g = Math.pow(10, (targetLufs - l) / 20);
  const lim = Math.pow(10, peakDb / 20);
  let y: Float32Array = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  y = limit(y, sr, lim);
  // лимитер чуть снижает громкость — один шаг досогласования
  for (let it = 0; it < 2; it++) {
    const d = targetLufs - loudnessLufs(y, sr);
    if (!isFinite(d) || Math.abs(d) < 0.2) break;
    const k = Math.pow(10, d / 20);
    for (let i = 0; i < y.length; i++) y[i] *= k;
    y = limit(y, sr, lim);
  }
  return y;
}

/** Пиковый лимитер: упреждение 5 мс (минимум в окне + скользящее среднее — без щелчков), отпускание 60 мс. */
export function limit(x: Float32Array, sr: number, ceiling: number): Float32Array {
  const look = Math.max(1, Math.round(0.005 * sr));
  const rel = 1 - Math.exp(-1 / (0.06 * sr));
  const n = x.length;
  const need = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    need[i] = a > ceiling ? ceiling / a : 1;
    if (need[i] < 1) any = true;
  }
  if (!any) return Float32Array.from(x);
  const r = new Float32Array(n);
  let prev = 1;
  for (let i = 0; i < n; i++) {
    let m = 1;
    for (let j = i; j < Math.min(n, i + look); j++) if (need[j] < m) m = need[j];
    prev = m < prev ? m : prev + (m - prev) * rel;
    r[i] = prev;
  }
  const y = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += r[i];
    if (i >= look) acc -= r[i - look];
    y[i] = x[i] * (acc / Math.min(i + 1, look));
  }
  return y;
}

// ───────────────────── анализ по кадрам ─────────────────────

export interface FrameFeatures {
  /** шаг кадра, с */
  step: number;
  /** RMS по кадрам (линейный) */
  rms: Float32Array;
  /** доля пересечений нуля 0..1 */
  zcr: Float32Array;
}

export function frames(x: Float32Array, sr: number, stepSec = 0.01, winSec = 0.025): FrameFeatures {
  const step = Math.max(1, Math.round(stepSec * sr)), win = Math.max(step, Math.round(winSec * sr));
  const n = Math.max(0, Math.ceil(x.length / step));
  const rms = new Float32Array(n), zcr = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const c = f * step + step / 2;
    const a = Math.max(0, Math.round(c - win / 2)), b = Math.min(x.length, Math.round(c + win / 2));
    let s = 0, z = 0;
    for (let i = a; i < b; i++) {
      s += x[i] * x[i];
      if (i > a && (x[i] >= 0) !== (x[i - 1] >= 0)) z++;
    }
    const len = Math.max(1, b - a);
    rms[f] = Math.sqrt(s / len);
    zcr[f] = z / len;
  }
  return { step: step / sr, rms, zcr };
}

export const dbfs = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));

/** Обрезать тишину по краям (порог относительно пика), оставить padSec. */
export function trimSilence(x: Float32Array, sr: number, thresholdDb = -45, padSec = 0.06): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (!peak) return x;
  const f = frames(x, sr, 0.005, 0.01);
  const thr = peak * Math.pow(10, thresholdDb / 20);
  let a = 0, b = f.rms.length - 1;
  while (a < b && f.rms[a] < thr) a++;
  while (b > a && f.rms[b] < thr) b--;
  const s = Math.max(0, Math.round((a * f.step - padSec) * sr));
  const e = Math.min(x.length, Math.round(((b + 1) * f.step + padSec) * sr));
  return x.slice(s, e);
}

/** Плавные края (мс), чтобы не щёлкало */
export function fadeEdges(x: Float32Array, sr: number, ms = 8): Float32Array {
  const n = Math.min(Math.round((ms / 1000) * sr), x.length >> 1);
  const y = Float32Array.from(x);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    y[i] *= g;
    y[y.length - 1 - i] *= g;
  }
  return y;
}
