/**
 * Рисунки котов на карте — векторно на холсте 2D (без картинок, текста и логотипов), по зерну seed:
 *   graffiti (Хулиган) — стена в баллончиках: туман краски, «пузырьковые» граффити-кляксы с обводкой и тенью,
 *                        стрелки, закорючки-теги, брызги, звёзды, потёки;
 *   hearts (Добряк)    — пастель: горошек, сердечки с бликами, мыльные пузыри с радужным ободком, конфетти;
 *   stars (Блёстка)    — сияние: голографический перелив, блёстки-пыль, звёзды с градиентом и свечением, искорки.
 * Основной цвет — выбранный кружок, акценты — два других цвета той же палитры.
 * Холст целиком непрозрачный внутри скруглённого прямоугольника карты: номер и имя на карте не видны.
 */
import { rng, type PatternId, type Swatch } from './paintPlan';

type G = CanvasRenderingContext2D;

// ───────────── цвет ─────────────

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** смешать два цвета: t = 0 — a, 1 — b */
export const mix = (a: string, b: string, t: number) => {
  const x = hex(a), y = hex(b);
  return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
};
const rgba = (h: string, a: number) => {
  const [r, g, b] = hex(h);
  return `rgba(${r},${g},${b},${a})`;
};
const lighten = (h: string, t: number) => mix(h, '#ffffff', t);
const darken = (h: string, t: number) => mix(h, '#140a26', t);

// ───────────── фигуры ─────────────

function starPath(g: G, x: number, y: number, R: number, r: number, n = 5, rot = 0) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = rot - Math.PI / 2 + (i * Math.PI) / n;
    const k = i % 2 ? r : R;
    if (i) g.lineTo(x + Math.cos(a) * k, y + Math.sin(a) * k);
    else g.moveTo(x + Math.cos(a) * k, y + Math.sin(a) * k);
  }
  g.closePath();
}

/** сердечко: центр (x, y), ширина s */
function heartPath(g: G, x: number, y: number, s: number, rot = 0) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.scale(s / 2, s / 2);
  g.beginPath();
  g.moveTo(0, 0.95);
  g.bezierCurveTo(-0.35, 0.68, -1, 0.3, -1, -0.22);
  g.bezierCurveTo(-1, -0.66, -0.66, -0.95, -0.3, -0.95);
  g.bezierCurveTo(-0.12, -0.95, 0, -0.84, 0, -0.62);
  g.bezierCurveTo(0, -0.84, 0.12, -0.95, 0.3, -0.95);
  g.bezierCurveTo(0.66, -0.95, 1, -0.66, 1, -0.22);
  g.bezierCurveTo(1, 0.3, 0.35, 0.68, 0, 0.95);
  g.closePath();
  g.restore();
}

/** искорка: четыре вогнутых луча */
function twinklePath(g: G, x: number, y: number, R: number, rot = 0) {
  const r = R * 0.18;
  const pt = (i: number) => [x + Math.cos(rot + (i * Math.PI) / 2) * R, y + Math.sin(rot + (i * Math.PI) / 2) * R] as const;
  g.beginPath();
  g.moveTo(...pt(0));
  for (let i = 1; i <= 4; i++) {
    const m = rot + ((i - 0.5) * Math.PI) / 2;
    g.quadraticCurveTo(x + Math.cos(m) * r, y + Math.sin(m) * r, ...pt(i % 4));
  }
  g.closePath();
}

/** замкнутая гладкая клякса через точки по кругу (Catmull-Rom → Безье) */
function blobPath(g: G, pts: { x: number; y: number }[]) {
  const n = pts.length;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    if (!i) g.moveTo(p1.x, p1.y);
    g.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
  }
  g.closePath();
}

function blobPoints(R: () => number, x: number, y: number, rx: number, ry: number, n: number, wob: number, rot = 0) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const k = 1 + (R() - 0.5) * 2 * wob;
    out.push({ x: x + Math.cos(a) * rx * k, y: y + Math.sin(a) * ry * k });
  }
  return out;
}

/** раскладка без сильных наложений: n кругов радиусом из rad(), отказ после tries попыток */
function scatter(R: () => number, W: number, H: number, n: number, rad: (i: number) => number, gap = 0.9, pad = 0, tries = 60) {
  const out: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = rad(i);
    let best: { x: number; y: number; r: number } | null = null, bestD = -1;
    for (let k = 0; k < tries; k++) {
      const x = pad + R() * (W - pad * 2), y = pad + R() * (H - pad * 2);
      let d = Infinity;
      for (const o of out) d = Math.min(d, Math.hypot(o.x - x, o.y - y) - (o.r + r) * gap);
      if (d > bestD) {
        bestD = d;
        best = { x, y, r };
      }
      if (d > 0 && k > 8) break;
    }
    out.push(best!);
  }
  return out;
}

/** скруглённый прямоугольник карты (радиус углов как у банковской карты: 3,18 мм из 85,6) */
export function cardClip(g: G, W: number, H: number) {
  g.beginPath();
  g.roundRect(0, 0, W, H, W * 0.04);
}

// ───────────── Хулиган: граффити ─────────────

function graffiti(g: G, W: number, H: number, main: string, acc: [string, string], R: () => number) {
  const ink = '#1E1236';
  const [a1, a2] = acc;
  // стена: основной цвет с переходом в акцент по диагонали
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, lighten(main, 0.08));
  bg.addColorStop(0.55, main);
  bg.addColorStop(1, mix(main, a2, 0.35));
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // туман из баллончика: мягкие облака акцентов
  for (let i = 0; i < 12; i++) {
    const x = R() * W, y = R() * H, r = (0.12 + R() * 0.2) * W;
    const c = [a1, a2, lighten(main, 0.5), darken(main, 0.25)][i % 4];
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(c, 0.55));
    gr.addColorStop(0.6, rgba(c, 0.18));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // крап баллончика
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = R() < 0.55 ? rgba(ink, 0.05 + R() * 0.12) : rgba('#ffffff', 0.08 + R() * 0.18);
    const s = 0.6 + R() * 2.2;
    g.fillRect(R() * W, R() * H, s, s);
  }

  // кляксы-брызги
  for (let i = 0; i < 4; i++) {
    const x = R() * W, y = R() * H, r = (0.035 + R() * 0.05) * W;
    const c = [a2, '#ffffff', a1, ink, a2][i];
    g.fillStyle = c;
    blobPath(g, blobPoints(R, x, y, r, r, 12, 0.35));
    g.fill();
    for (let k = 0; k < 10; k++) {
      const a = R() * Math.PI * 2, d = r * (1.2 + R() * 1.4), s = r * (0.07 + R() * 0.16);
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, s, 0, Math.PI * 2);
      g.fill();
      // лучик к капле
      g.lineWidth = s * 0.9;
      g.strokeStyle = c;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
      g.lineTo(x + Math.cos(a) * d * 0.8, y + Math.sin(a) * d * 0.8);
      g.stroke();
    }
  }

  // закорючки-теги (петли, без букв) и стрелки
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < 2; i++) {
    const x0 = W * (0.05 + R() * 0.6), y0 = H * (0.12 + R() * 0.76), len = W * (0.18 + R() * 0.14), amp = H * (0.025 + R() * 0.03);
    const loops = 3 + Math.floor(R() * 3);
    const col = i === 1 ? 'rgba(255,255,255,.8)' : rgba(ink, 0.7);
    g.strokeStyle = col;
    g.lineWidth = W * 0.006;
    g.beginPath();
    for (let k = 0; k <= 120; k++) {
      const t = k / 120, ang = t * loops * Math.PI * 2;
      const x = x0 + t * len + Math.cos(ang) * amp * 0.7, y = y0 + Math.sin(ang) * amp - t * amp * 0.8;
      if (k) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < 2; i++) {
    const x0 = W * (0.1 + R() * 0.5), y0 = H * (0.2 + R() * 0.6), x1 = x0 + W * (0.2 + R() * 0.15), y1 = y0 + (R() - 0.5) * H * 0.4;
    const cx = (x0 + x1) / 2, cy = Math.min(y0, y1) - H * 0.18;
    const col = i ? a1 : '#ffffff';
    const w = W * 0.018;
    for (const [c, lw] of [[ink, w + 9], [col, w]] as const) {
      g.strokeStyle = c;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x0, y0);
      g.quadraticCurveTo(cx, cy, x1, y1);
      g.stroke();
      // наконечник
      const a = Math.atan2(y1 - cy, x1 - cx), hl = W * 0.045;
      g.beginPath();
      g.moveTo(x1 + Math.cos(a - 2.5) * hl, y1 + Math.sin(a - 2.5) * hl);
      g.lineTo(x1 + Math.cos(a) * hl * 0.35, y1 + Math.sin(a) * hl * 0.35);
      g.lineTo(x1 + Math.cos(a + 2.5) * hl, y1 + Math.sin(a + 2.5) * hl);
      g.stroke();
    }
  }

  // «пузырьковые» куски граффити без букв: кляксы с тенью, толстой обводкой и бликом, потёки снизу
  const pieces = scatter(R, W, H, 3, (i) => (i === 0 ? 0.15 : 0.11 - i * 0.012) * W, 0.85, W * 0.17);
  pieces.forEach((p, i) => {
    const fill = [a1, a2, lighten(main, 0.65)][i % 3];
    const pts = blobPoints(R, p.x, p.y, p.r * 1.25, p.r * 0.8, 9, 0.22, R() * Math.PI);
    // тень-объём (3D-эффект граффити)
    g.save();
    g.translate(p.r * 0.12, p.r * 0.14);
    blobPath(g, pts);
    g.fillStyle = rgba(ink, 0.85);
    g.fill();
    g.restore();
    blobPath(g, pts);
    const fg = g.createLinearGradient(p.x, p.y - p.r, p.x, p.y + p.r);
    fg.addColorStop(0, lighten(fill, 0.35));
    fg.addColorStop(1, fill);
    g.fillStyle = fg;
    g.fill();
    g.lineWidth = Math.max(8, p.r * 0.09);
    g.strokeStyle = ink;
    g.lineJoin = 'round';
    g.stroke();
    // внутренний светлый контур — как у бабл-граффити
    g.save();
    g.translate(p.x, p.y);
    g.scale(0.8, 0.76);
    g.translate(-p.x, -p.y + p.r * 0.04);
    blobPath(g, pts);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = Math.max(3, p.r * 0.035);
    g.stroke();
    // блик
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.lineCap = 'round';
    g.lineWidth = p.r * 0.08;
    g.beginPath();
    g.ellipse(p.x - p.r * 0.35, p.y - p.r * 0.32, p.r * 0.42, p.r * 0.22, -0.35, Math.PI * 1.1, Math.PI * 1.55);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(p.x + p.r * 0.18, p.y - p.r * 0.5, p.r * 0.05, 0, Math.PI * 2);
    g.fill();
    // потёки краски снизу
    for (let k = 0; k < 3; k++) {
      const dx = p.x + (R() - 0.5) * p.r * 1.6, len = p.r * (0.35 + R() * 0.6), w = p.r * (0.08 + R() * 0.06);
      const y0 = p.y + p.r * 0.55;
      g.fillStyle = fill;
      g.strokeStyle = ink;
      g.lineWidth = Math.max(4, w * 0.45);
      g.beginPath();
      g.moveTo(dx - w, y0);
      g.lineTo(dx - w, y0 + len);
      g.arc(dx, y0 + len, w, Math.PI, 0, true);
      g.lineTo(dx + w, y0);
      g.closePath();
      g.fill();
      g.stroke();
    }
  });

  // звёзды с толстой обводкой
  const stars = scatter(R, W, H, 6, () => (0.03 + R() * 0.04) * W, 1.1, W * 0.04);
  for (const s of stars) {
    starPath(g, s.x, s.y, s.r, s.r * 0.48, 5, (R() - 0.5) * 0.6);
    g.fillStyle = R() < 0.5 ? '#ffffff' : R() < 0.5 ? a1 : lighten(a2, 0.25);
    g.fill();
    g.lineWidth = Math.max(4, s.r * 0.14);
    g.strokeStyle = ink;
    g.stroke();
  }
  // крестики-блики
  g.strokeStyle = '#fff';
  for (let i = 0; i < 9; i++) {
    const x = R() * W, y = R() * H, s = W * (0.008 + R() * 0.014);
    g.lineWidth = s * 0.35;
    g.beginPath();
    g.moveTo(x - s, y);
    g.lineTo(x + s, y);
    g.moveTo(x, y - s);
    g.lineTo(x, y + s);
    g.stroke();
  }
  // потёки с верхнего края — краска стекает
  for (let i = 0; i < 6; i++) {
    const x = R() * W, len = H * (0.03 + R() * 0.09), w = W * (0.005 + R() * 0.006);
    g.fillStyle = [a1, a2, ink][i % 3];
    g.fillRect(x - w, 0, w * 2, len);
    g.beginPath();
    g.arc(x, len, w * 1.25, 0, Math.PI * 2);
    g.fill();
  }
}

// ───────────── Добряк: сердечки и пузыри ─────────────

function hearts(g: G, W: number, H: number, main: string, acc: [string, string], R: () => number) {
  const [a1, a2] = acc;
  const line = darken(main, 0.45);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, lighten(main, 0.55));
  bg.addColorStop(1, lighten(main, 0.12));
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // мягкие пятна акцентов
  for (let i = 0; i < 6; i++) {
    const x = R() * W, y = R() * H, r = (0.18 + R() * 0.18) * W;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const c = i % 2 ? a1 : a2;
    gr.addColorStop(0, rgba(lighten(c, 0.3), 0.45));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // горошек
  const step = W / 16;
  g.fillStyle = 'rgba(255,255,255,.42)';
  for (let y = step / 2, row = 0; y < H + step; y += step * 0.87, row++)
    for (let x = (row % 2) * step * 0.5; x < W + step; x += step) {
      g.beginPath();
      g.arc(x, y, step * 0.11, 0, Math.PI * 2);
      g.fill();
    }

  const items = scatter(R, W, H, 16, (i) => (i < 3 ? 0.11 - i * 0.012 : i < 9 ? 0.06 + R() * 0.02 : 0.035 + R() * 0.015) * W, 1.05, W * 0.03);
  items.forEach((it, i) => {
    if (i % 3 === 2) return bubble(g, it.x, it.y, it.r * 0.9, [a1, a2, main], R);
    const fill = [main, a1, a2, '#ffffff', darken(main, 0.08)][i % 5];
    const rot = (R() - 0.5) * 0.7;
    // мягкая тень
    g.save();
    g.translate(it.r * 0.06, it.r * 0.1);
    heartPath(g, it.x, it.y, it.r * 2, rot);
    g.fillStyle = rgba(line, 0.22);
    g.fill();
    g.restore();
    heartPath(g, it.x, it.y, it.r * 2, rot);
    const gr = g.createLinearGradient(it.x, it.y - it.r, it.x, it.y + it.r);
    gr.addColorStop(0, lighten(fill, 0.35));
    gr.addColorStop(1, fill === '#ffffff' ? '#FFF3F7' : fill);
    g.fillStyle = gr;
    g.fill();
    g.lineWidth = Math.max(3, it.r * 0.08);
    g.strokeStyle = fill === '#ffffff' ? darken(a1, 0.3) : darken(fill, 0.4);
    g.lineJoin = 'round';
    g.stroke();
    // блик
    g.save();
    g.translate(it.x, it.y);
    g.rotate(rot);
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.beginPath();
    g.ellipse(-it.r * 0.42, -it.r * 0.42, it.r * 0.2, it.r * 0.11, -0.7, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(-it.r * 0.15, -it.r * 0.6, it.r * 0.05, 0, Math.PI * 2);
    g.fill();
    // щёчки и улыбка у крупных — сердечко-друг
    if (i < 3) {
      g.fillStyle = darken(fill, 0.55);
      g.beginPath();
      g.arc(-it.r * 0.24, -it.r * 0.02, it.r * 0.07, 0, Math.PI * 2);
      g.arc(it.r * 0.24, -it.r * 0.02, it.r * 0.07, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = darken(fill, 0.55);
      g.lineWidth = it.r * 0.06;
      g.lineCap = 'round';
      g.beginPath();
      g.arc(0, it.r * 0.1, it.r * 0.14, 0.2 * Math.PI, 0.8 * Math.PI);
      g.stroke();
      g.fillStyle = rgba('#FF6F91', 0.35);
      g.beginPath();
      g.ellipse(-it.r * 0.42, it.r * 0.14, it.r * 0.11, it.r * 0.07, 0, 0, Math.PI * 2);
      g.ellipse(it.r * 0.42, it.r * 0.14, it.r * 0.11, it.r * 0.07, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  });
  // конфетти: маленькие сердечки и точки
  for (let i = 0; i < 26; i++) {
    const x = R() * W, y = R() * H, s = W * (0.012 + R() * 0.014);
    g.fillStyle = [a1, a2, '#ffffff', darken(main, 0.2)][i % 4];
    if (i % 2) {
      heartPath(g, x, y, s * 1.6, (R() - 0.5) * 0.8);
      g.fill();
    } else {
      g.beginPath();
      g.arc(x, y, s * 0.4, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function bubble(g: G, x: number, y: number, r: number, cols: string[], R: () => number) {
  const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  gr.addColorStop(0, 'rgba(255,255,255,.08)');
  gr.addColorStop(0.75, 'rgba(255,255,255,.18)');
  gr.addColorStop(1, 'rgba(255,255,255,.55)');
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  // радужный ободок
  const rim = g.createLinearGradient(x - r, y - r, x + r, y + r);
  rim.addColorStop(0, rgba(lighten(cols[0], 0.2), 0.95));
  rim.addColorStop(0.5, 'rgba(255,255,255,.95)');
  rim.addColorStop(1, rgba(lighten(cols[1], 0.2), 0.95));
  g.strokeStyle = rim;
  g.lineWidth = Math.max(2.5, r * 0.07);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.95)';
  g.lineCap = 'round';
  g.lineWidth = Math.max(2, r * 0.09);
  g.beginPath();
  g.arc(x, y, r * 0.7, Math.PI * 1.12, Math.PI * 1.42);
  g.stroke();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(x + r * 0.42, y + r * 0.38, r * 0.07, 0, Math.PI * 2);
  g.fill();
  void R;
}

// ───────────── Блёстка: звёзды и блёстки ─────────────

function stars(g: G, W: number, H: number, main: string, acc: [string, string], R: () => number) {
  const [a1, a2] = acc;
  const bg = g.createLinearGradient(0, H, W, 0);
  bg.addColorStop(0, darken(main, 0.38));
  bg.addColorStop(0.5, main);
  bg.addColorStop(1, lighten(main, 0.4));
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // голографический перелив: диагональные полосы акцентов
  g.save();
  g.globalCompositeOperation = 'screen';
  const holo = g.createLinearGradient(0, 0, W, H * 0.6);
  const hs = [a1, '#ffffff', a2, main, a1, '#ffffff', a2];
  hs.forEach((c, i) => holo.addColorStop(i / (hs.length - 1), rgba(c, i % 2 ? 0.28 : 0.2)));
  g.fillStyle = holo;
  g.fillRect(0, 0, W, H);
  g.restore();
  // мягкие ореолы
  for (let i = 0; i < 6; i++) {
    const x = R() * W, y = R() * H, r = (0.1 + R() * 0.16) * W;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(i % 2 ? a1 : '#ffffff', 0.4));
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // блёстки-пыль
  for (let i = 0; i < 2400; i++) {
    const k = R();
    g.fillStyle = k < 0.5 ? rgba('#ffffff', 0.25 + R() * 0.6) : k < 0.8 ? rgba(lighten(a1, 0.3), 0.4 + R() * 0.5) : rgba(lighten(a2, 0.3), 0.4 + R() * 0.5);
    const s = 0.7 + R() * R() * 3.4;
    g.beginPath();
    g.arc(R() * W, R() * H, s, 0, Math.PI * 2);
    g.fill();
  }
  // звёзды
  const ss = scatter(R, W, H, 9, (i) => (i < 2 ? 0.1 : i < 5 ? 0.065 : 0.04) * W * (0.9 + R() * 0.2), 1.05, W * 0.09);
  ss.forEach((s, i) => {
    const rot = (R() - 0.5) * 0.7;
    const c = [a1, '#ffffff', a2, lighten(main, 0.6)][i % 4];
    g.save();
    g.shadowColor = rgba(c === '#ffffff' ? a1 : c, 0.9);
    g.shadowBlur = s.r * 0.6;
    starPath(g, s.x, s.y, s.r, s.r * 0.5, 5, rot);
    const gr = g.createLinearGradient(s.x, s.y - s.r, s.x, s.y + s.r);
    gr.addColorStop(0, lighten(c === '#ffffff' ? a1 : c, 0.7));
    gr.addColorStop(0.5, lighten(c === '#ffffff' ? a1 : c, 0.2));
    gr.addColorStop(1, c === '#ffffff' ? a1 : darken(c, 0.08));
    g.fillStyle = gr;
    g.fill();
    g.restore();
    starPath(g, s.x, s.y, s.r, s.r * 0.5, 5, rot);
    g.lineJoin = 'round';
    g.lineWidth = Math.max(3, s.r * 0.08);
    g.strokeStyle = 'rgba(255,255,255,.95)';
    g.stroke();
    // грань-блик
    g.fillStyle = 'rgba(255,255,255,.55)';
    starPath(g, s.x - s.r * 0.05, s.y - s.r * 0.05, s.r * 0.45, s.r * 0.22, 5, rot);
    g.fill();
  });
  // искорки со свечением
  for (let i = 0; i < 16; i++) {
    const x = R() * W, y = R() * H, r = W * (0.012 + R() * R() * 0.045);
    g.save();
    g.shadowColor = 'rgba(255,255,255,.95)';
    g.shadowBlur = r * 0.8;
    g.fillStyle = i % 3 ? '#ffffff' : lighten(a1, 0.4);
    twinklePath(g, x, y, r, R() * 0.3);
    g.fill();
    g.restore();
  }
  // колечки
  g.strokeStyle = 'rgba(255,255,255,.7)';
  for (let i = 0; i < 8; i++) {
    g.lineWidth = 2 + R() * 2;
    g.beginPath();
    g.arc(R() * W, R() * H, W * (0.006 + R() * 0.01), 0, Math.PI * 2);
    g.stroke();
  }
}

const ART: Record<PatternId, typeof graffiti> = { graffiti, hearts, stars };

/** нарисовать рисунок на g в прямоугольнике W×H (скруглённый, непрозрачный) */
export function drawPattern(g: G, W: number, H: number, pattern: PatternId, swatch: Swatch, others: Swatch[], seed: number) {
  const R = rng(seed);
  g.save();
  g.clearRect(0, 0, W, H);
  cardClip(g, W, H);
  g.clip();
  ART[pattern](g, W, H, swatch.main, [others[0]?.main ?? '#ffffff', others[1]?.main ?? '#ffffff'], R);
  // тонкий светлый кант по краю — карта «в рамке»
  g.strokeStyle = 'rgba(255,255,255,.55)';
  g.lineWidth = Math.max(2, W * 0.006);
  cardClip(g, W, H);
  g.stroke();
  g.restore();
}

/** холст рисунка (в браузере) */
export function patternCanvas(W: number, H: number, pattern: PatternId, swatch: Swatch, others: Swatch[], seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (g) drawPattern(g, W, H, pattern, swatch, others, seed);
  return c;
}
