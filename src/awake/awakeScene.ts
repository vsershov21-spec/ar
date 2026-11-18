/**
 * 3D-часть сцены пробуждения — в плоскости карты (дочерние объекты tracker.anchor, единицы — ширины карты,
 * карта в XY, нормаль +Z): свечение контура карты, портал в центре, световой столб, искры, тень-силуэт кота,
 * маска карты (кот «выходит из-под поверхности»), граффити-брызги (Хулиган), скейт под лапами.
 * Всё создаётся один раз (warm — прогрев шейдеров и текстур заранее), в кадре — только uniforms и буферы частиц.
 * Кривые времени — timeline.ts; что включать в каком кадре — AwakeController (index.ts).
 */
import * as THREE from 'three';
import type { PersonaId } from '../persona/types';

const AQ = 85.6 / 53.98;
const CORNER = 3.18 / 85.6;

/** цвета образов: [основной, второй, акцент] + общий зелёный Сбера */
export const AWAKE_COLORS: Record<PersonaId, { a: string; b: string; parts: string[] }> = {
  hooligan: { a: '#B5E36A', b: '#2FD3C8', parts: ['#39FF88', '#FF3FA4', '#2FD3FF', '#FFE14D', '#B5E36A'] },
  kind: { a: '#7EE2A8', b: '#FFB3D1', parts: ['#FFFFFF', '#FFC6DD', '#B8F0D0', '#BFE6FF', '#FFE3A3'] },
  glitter: { a: '#FFD35C', b: '#E7A6FF', parts: ['#FFFFFF', '#FFD35C', '#FFB3EC', '#C8B6FF', '#FFF1A8'] },
};

// ───────────── шейдеры ─────────────
const VS_UV = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** контур карты: SDF скруглённого прямоугольника, две «кометы» бегут по периметру */
const FS_EDGE = /* glsl */ `
uniform float uK; uniform float uT; uniform vec3 uA; uniform vec3 uB; uniform vec2 uSize; uniform vec2 uHalf; uniform float uR;
varying vec2 vUv;
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = (vUv - 0.5) * uSize;
  float d = sdBox(p, uHalf, uR);
  float line = exp(-abs(d) * 90.0);
  float halo = exp(-max(d, 0.0) * 22.0) * step(0.0, d) * 0.55;
  float inner = exp(d * 9.0) * step(d, 0.0) * 0.16;
  float ang = atan(p.y, p.x * 0.63);
  float run = pow(0.5 + 0.5 * cos(ang * 2.0 - uT * 5.0), 10.0);
  float tw = 0.85 + 0.15 * sin(uT * 13.0 + ang * 7.0);
  vec3 col = mix(uA, uB, run);
  col = mix(col, vec3(1.0), line * 0.55 * (0.4 + run));
  float a = uK * ((line * 1.1 + halo) * (0.55 + 0.9 * run) * tw + inner);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

/** портал: закрученные лучи, яркий центр, кольцо по краю */
const FS_PORTAL = /* glsl */ `
uniform float uK; uniform float uT; uniform vec3 uA; uniform vec3 uB;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);
  float sw = 0.5 + 0.5 * sin(ang * 7.0 + r * 9.0 - uT * 7.0);
  float core = exp(-r * r * 9.0);
  float ring = exp(-pow((r - 0.86) * 9.0, 2.0));
  vec3 col = mix(uA, uB, sw * r);
  col = mix(col, vec3(1.0), core);
  float a = uK * (core * 1.2 + ring * 0.9 + sw * (1.0 - r) * 0.55) * smoothstep(1.0, 0.92, r);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

/** световой столб: прозрачнее к верху, бегущие кольца, края ярче (как стеклянный луч) */
const VS_PILLAR = /* glsl */ `
varying vec2 vUv; varying float vEdge;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vEdge = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const FS_PILLAR = /* glsl */ `
uniform float uK; uniform float uT; uniform vec3 uA; uniform vec3 uB; uniform float uCore;
varying vec2 vUv; varying float vEdge;
void main() {
  float v = vUv.y;
  float fade = pow(1.0 - v, 1.6) * smoothstep(0.0, 0.04, v);
  float bands = 0.6 + 0.4 * sin(v * 26.0 - uT * 9.0);
  float stripes = 0.75 + 0.25 * sin(vUv.x * 6.2832 * 6.0 + uT * 3.0);
  float e = mix(0.35 + 0.65 * pow(vEdge, 1.3), 1.0, uCore);
  vec3 col = mix(uA, uB, v);
  col = mix(col, vec3(1.0), uCore * 0.7);
  gl_FragColor = vec4(col, clamp(uK * fade * bands * stripes * e, 0.0, 1.0));
}`;

/** частицы: 0 — искра, 1 — звёздочка, 2 — сердечко, 3 — пузырь */
const VS_PTS = /* glsl */ `
attribute float aSize; attribute float aAlpha; attribute float aShape; attribute vec3 aColor;
uniform float uPx;
varying float vA; varying float vS; varying vec3 vC;
void main() {
  vA = aAlpha; vS = aShape; vC = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPx / max(0.01, -mv.z), 0.0, 96.0);
  gl_Position = projectionMatrix * mv;
}`;
const FS_PTS = /* glsl */ `
varying float vA; varying float vS; varying vec3 vC;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = 0.0; vec3 col = vC;
  if (vS < 0.5) {
    a = pow(smoothstep(0.5, 0.0, r), 1.6);
    col = mix(vC, vec3(1.0), smoothstep(0.18, 0.0, r));
  } else if (vS < 1.5) {
    float s = max(0.0, 1.0 - abs(c.x * c.y) * 70.0 - r * 1.6);
    a = clamp(s + pow(smoothstep(0.32, 0.0, r), 2.0), 0.0, 1.0);
    col = mix(vC, vec3(1.0), smoothstep(0.12, 0.0, r));
  } else if (vS < 2.5) {
    vec2 h = c * 2.7; h.y = -h.y + 0.15;
    float f = pow(h.x * h.x + h.y * h.y - 1.0, 3.0) - h.x * h.x * h.y * h.y * h.y;
    a = smoothstep(0.06, -0.06, f);
    col = mix(vC, vec3(1.0), smoothstep(-0.6, -1.4, f) * 0.5);
  } else {
    float ring = smoothstep(0.5, 0.44, r) * smoothstep(0.30, 0.45, r);
    float hl = smoothstep(0.13, 0.0, length(c - vec2(-0.16, -0.16)));
    float ir = 0.5 + 0.5 * sin(atan(c.y, c.x) * 2.0 + r * 12.0);
    col = mix(vec3(0.75, 0.95, 1.0), vec3(1.0, 0.8, 0.95), ir);
    a = ring * 0.85 + hl + smoothstep(0.5, 0.0, r) * 0.08;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a * vA);
}`;

// ───────────── частицы ─────────────
export interface PartSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; size: number; shape: number; color: THREE.Color;
  /** ускорение по Z (− — к карте, + — всплывает) */
  gz?: number;
  drag?: number;
  /** покачивание (пузыри) */
  wob?: number;
  /** закрутка вокруг оси столба (звёздная пыль), рад/с */
  swirl?: number;
}

class PartPool {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private shape: Float32Array;
  private v: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private baseSize: Float32Array;
  private gz: Float32Array;
  private drag: Float32Array;
  private wob: Float32Array;
  private swirl: Float32Array;
  private cursor = 0;
  live = 0;
  readonly mat: THREE.ShaderMaterial;

  constructor(n: number, blending: THREE.Blending) {
    this.n = n;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.shape = new Float32Array(n);
    this.v = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(1e9);
    this.life = new Float32Array(n).fill(1);
    this.baseSize = new Float32Array(n);
    this.gz = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.wob = new Float32Array(n);
    this.swirl = new Float32Array(n);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aShape', new THREE.BufferAttribute(this.shape, 1));
    // границы — с запасом (частицы не отсекаются по сфере геометрии)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.6), 3);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS_PTS, fragmentShader: FS_PTS, uniforms: { uPx: { value: 400 } },
      transparent: true, depthWrite: false, blending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(s: PartSpec) {
    // свободное место; если пул полон — заменяем самую старую по кругу
    let i = -1;
    for (let k = 0; k < this.n; k++) {
      const j = (this.cursor + k) % this.n;
      if (this.age[j] >= this.life[j]) {
        i = j;
        break;
      }
    }
    if (i < 0) i = this.cursor;
    this.cursor = (i + 1) % this.n;
    const i3 = i * 3;
    this.pos[i3] = s.x; this.pos[i3 + 1] = s.y; this.pos[i3 + 2] = s.z;
    this.v[i3] = s.vx; this.v[i3 + 1] = s.vy; this.v[i3 + 2] = s.vz;
    this.col[i3] = s.color.r; this.col[i3 + 1] = s.color.g; this.col[i3 + 2] = s.color.b;
    this.age[i] = 0;
    this.life[i] = s.life;
    this.baseSize[i] = s.size;
    this.shape[i] = s.shape;
    this.gz[i] = s.gz ?? -0.9;
    this.drag[i] = s.drag ?? 1.2;
    this.wob[i] = s.wob ?? 0;
    this.swirl[i] = s.swirl ?? 0;
    const g = this.points.geometry;
    (g.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aShape') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number, t: number) {
    let live = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      live++;
      const i3 = i * 3;
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.v[i3] *= dr; this.v[i3 + 1] *= dr; this.v[i3 + 2] = this.v[i3 + 2] * dr + this.gz[i] * dt;
      if (this.swirl[i]) {
        // по кругу вокруг оси столба (центр карты)
        const x = this.pos[i3], y = this.pos[i3 + 1], a = this.swirl[i] * dt;
        const c = Math.cos(a), s = Math.sin(a);
        this.pos[i3] = x * c - y * s;
        this.pos[i3 + 1] = x * s + y * c;
      }
      this.pos[i3] += this.v[i3] * dt + (this.wob[i] ? Math.sin(t * 3 + i) * this.wob[i] * dt : 0);
      this.pos[i3 + 1] += this.v[i3 + 1] * dt;
      this.pos[i3 + 2] += this.v[i3 + 2] * dt;
      this.alpha[i] = k < 0.12 ? k / 0.12 : 1 - Math.pow((k - 0.12) / 0.88, 1.5);
      this.size[i] = this.baseSize[i] * (this.shape[i] === 3 ? 0.6 + 0.4 * Math.min(1, k * 5) : 1 - 0.35 * k);
      if (this.shape[i] === 3 && k > 0.94) this.size[i] *= 1.3; // пузырь лопается
    }
    this.live = live;
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = live > 0;
  }

  clear() {
    this.age.fill(1e9);
    this.alpha.fill(0);
    this.live = 0;
    this.points.visible = false;
  }
}

// ───────────── сцена ─────────────
export class AwakeScene {
  readonly group = new THREE.Group();
  /** маска карты: пишет только глубину — часть кота «под картой» не видна */
  readonly occluder: THREE.Mesh;
  private edge: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private portal: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private pillar: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private core: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private silhouette: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private splats: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  readonly glowParts = new PartPool(260, THREE.AdditiveBlending);
  readonly softParts = new PartPool(140, THREE.NormalBlending);
  readonly skate: THREE.Group;
  private tmpC = new THREE.Color();
  private uT = { value: 0 };
  readonly aspect: number;

  constructor(aspect = AQ) {
    this.aspect = aspect;
    const H = 1 / aspect;
    this.group.name = 'awake';
    this.group.visible = false;
    const add = <T extends THREE.Object3D>(o: T, ro: number) => {
      o.renderOrder = ro;
      this.group.add(o);
      return o;
    };
    // маска карты (до кота: renderOrder −2; цвет не пишет)
    // «стол» шире карты: всё, что ниже плоскости карты, не видно и за её краем (кот близко к краю карты)
    this.occluder = add(new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true })), -2);
    this.occluder.name = 'awake-occluder';
    this.occluder.visible = false;
    // контур
    const m = 0.14;
    const edgeMat = new THREE.ShaderMaterial({
      vertexShader: VS_UV, fragmentShader: FS_EDGE, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uK: { value: 0 }, uT: this.uT, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uSize: { value: new THREE.Vector2(1 + 2 * m, H + 2 * m) }, uHalf: { value: new THREE.Vector2(0.5, H / 2) }, uR: { value: CORNER } },
    });
    this.edge = add(new THREE.Mesh(new THREE.PlaneGeometry(1 + 2 * m, H + 2 * m), edgeMat), 3);
    this.edge.position.z = 0.002;
    // портал
    const portMat = new THREE.ShaderMaterial({
      vertexShader: VS_UV, fragmentShader: FS_PORTAL, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uK: { value: 0 }, uT: this.uT, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() } },
    });
    this.portal = add(new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), portMat), 3);
    this.portal.position.z = 0.003;
    // столб: ось — нормаль карты (+Z), основание на карте
    const pil = (rTop: number, rBot: number, core: number) => {
      const g = new THREE.CylinderGeometry(rTop, rBot, 1, 40, 1, true);
      g.translate(0, 0.5, 0);
      g.rotateX(Math.PI / 2);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VS_PILLAR, fragmentShader: FS_PILLAR, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uK: { value: 0 }, uT: this.uT, uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uCore: { value: core } },
      });
      return new THREE.Mesh(g, mat);
    };
    this.pillar = add(pil(0.3, 0.19, 0), 4);
    this.core = add(pil(0.07, 0.05, 1), 4);
    // тень-силуэт кота
    this.silhouette = add(new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: silhouetteTexture(), transparent: true, depthWrite: false, opacity: 0 })), 2);
    this.silhouette.position.z = 0.0015;
    // граффити-брызги (Хулиган): три пятна у краёв карты
    // цвета — контрастные к зелёной карте: розовый, жёлтый, фиолетовый
    const spots: [number, number, number, string][] = [[-0.3, 0.1, 0.3, '#FF3FA4'], [0.31, -0.08, 0.28, '#FFE14D'], [0.27, 0.17, 0.22, '#A86BFF']];
    for (const [x, y, s, c] of spots) {
      const mesh = add(new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: splatTexture(c), transparent: true, depthWrite: false, opacity: 0 })), 2);
      mesh.position.set(x, y, 0.0025);
      mesh.rotation.z = Math.random() * 6;
      mesh.visible = false;
      this.splats.push(mesh);
    }
    this.group.add(this.glowParts.points, this.softParts.points);
    this.skate = makeSkate();
  }

  /** все объекты сцены и материалы видимы — для compileAsync/initTexture (прогрев) */
  forWarm(on: boolean) {
    this.group.visible = on;
    for (const o of this.group.children) o.visible = on;
    this.glowParts.points.visible = on;
    this.softParts.points.visible = on;
  }

  textures(): THREE.Texture[] {
    return [this.silhouette.material.map!, ...this.splats.map((s) => s.material.map!)];
  }

  setColors(p: PersonaId) {
    const c = AWAKE_COLORS[p] ?? AWAKE_COLORS.hooligan;
    const sber = new THREE.Color('#21A038');
    for (const m of [this.edge.material, this.portal.material, this.pillar.material, this.core.material]) {
      (m.uniforms.uA.value as THREE.Color).set(c.a);
      (m.uniforms.uB.value as THREE.Color).set(c.b);
    }
    (this.edge.material.uniforms.uB.value as THREE.Color).lerp(sber, 0.35);
  }

  /** точка-размер частиц: px на единицу мира на расстоянии 1 */
  setPointScale(px: number) {
    this.glowParts.mat.uniforms.uPx.value = px;
    this.softParts.mat.uniforms.uPx.value = px;
  }

  color(hex: string) {
    return this.tmpC.set(hex).clone();
  }

  /** кадр: значения кривых → uniforms, видимость */
  apply(s: { t: number; glow: number; portal: number; pillarH: number; pillarK: number; silhouette: number; splat: number[]; occlude: boolean; catXY: THREE.Vector2; flair: PersonaId | null }) {
    this.uT.value = s.t;
    this.edge.material.uniforms.uK.value = s.glow;
    this.edge.visible = s.glow > 0.003;
    this.portal.material.uniforms.uK.value = Math.min(1.6, s.portal);
    const ps = 0.45 + 0.55 * Math.min(1, s.portal);
    this.portal.scale.setScalar(ps);
    this.portal.visible = s.portal > 0.003;
    const h = Math.max(0.001, s.pillarH * 1.35);
    this.pillar.scale.set(1, 1, h);
    this.core.scale.set(1, 1, h * 0.9);
    this.pillar.material.uniforms.uK.value = s.pillarK * 0.85;
    this.core.material.uniforms.uK.value = s.pillarK * 0.9;
    this.pillar.visible = this.core.visible = s.pillarK > 0.003 && s.pillarH > 0.003;
    this.silhouette.material.opacity = s.silhouette;
    this.silhouette.visible = s.silhouette > 0.003;
    this.silhouette.position.x = s.catXY.x;
    this.silhouette.position.y = s.catXY.y + 0.02;
    // столб и портал — под котом
    for (const o of [this.portal, this.pillar, this.core]) {
      o.position.x = s.catXY.x;
      o.position.y = s.catXY.y;
    }
    this.splats.forEach((m, i) => {
      const k = s.splat[i] ?? 0;
      m.visible = k > 0.003;
      m.material.opacity = Math.min(1, k) * 0.92;
      m.scale.setScalar(0.25 + 0.75 * Math.min(1.12, k));
    });
    this.occluder.visible = s.occlude;
  }

  update(dt: number, t: number) {
    this.glowParts.update(dt, t);
    this.softParts.update(dt, t);
  }

  get particlesLive() {
    return this.glowParts.live + this.softParts.live;
  }

  clear() {
    this.glowParts.clear();
    this.softParts.clear();
    this.apply({ t: 0, glow: 0, portal: 0, pillarH: 0, pillarK: 0, silhouette: 0, splat: [], occlude: false, catXY: new THREE.Vector2(), flair: null });
  }
}

// ───────────── текстуры и скейт ─────────────
function canvas(n: number) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return c;
}

/** силуэт сидящего кота сверху-спереди, размытый (размытие — через тень: работает и в Safari без ctx.filter) */
function silhouetteTexture(): THREE.Texture {
  const N = 128, c = canvas(N), g = c.getContext('2d')!;
  g.shadowColor = 'rgba(0,10,8,0.95)';
  g.shadowBlur = 14;
  g.shadowOffsetX = N * 4;
  g.translate(-N * 4, 0);
  g.fillStyle = '#000';
  g.beginPath();
  g.ellipse(64, 78, 30, 24, 0, 0, Math.PI * 2); // тело
  g.moveTo(64 + 22, 44);
  g.arc(64, 44, 22, 0, Math.PI * 2); // голова
  g.fill();
  g.beginPath(); // уши
  g.moveTo(46, 34); g.lineTo(42, 12); g.lineTo(58, 26);
  g.moveTo(82, 34); g.lineTo(86, 12); g.lineTo(70, 26);
  g.fill();
  g.lineWidth = 9; // хвост
  g.lineCap = 'round';
  g.strokeStyle = '#000';
  g.beginPath();
  g.moveTo(90, 92);
  g.quadraticCurveTo(116, 90, 110, 64);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** граффити-клякса: пятно с каплями и потёками, неоновый цвет с белым бликом */
function splatTexture(color: string): THREE.Texture {
  const N = 128, c = canvas(N), g = c.getContext('2d')!;
  let seed = color.charCodeAt(1) * 31 + color.charCodeAt(3);
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 10;
  g.beginPath();
  for (let i = 0; i <= 18; i++) {
    const a = (i / 18) * Math.PI * 2, r = 26 + rnd() * 14;
    const x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
  g.fill();
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, r = 40 + rnd() * 20, s = 2 + rnd() * 5;
    g.beginPath();
    g.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, s, 0, Math.PI * 2);
    g.fill();
  }
  g.shadowBlur = 0;
  g.globalAlpha = 0.6;
  g.fillStyle = '#fff';
  g.beginPath();
  g.ellipse(56, 54, 9, 5, -0.6, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function deckTexture(): THREE.Texture {
  const c = canvas(128), g = c.getContext('2d')!;
  g.fillStyle = '#B5E36A';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#FF3FA4';
  for (let i = -2; i < 8; i++) {
    g.beginPath();
    g.moveTo(i * 24, 0);
    g.lineTo(i * 24 + 12, 0);
    g.lineTo(i * 24 + 40, 128);
    g.lineTo(i * 24 + 28, 128);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** мини-скейт Хулигана (единицы — рост кота): дека лайм с чёрной шкуркой, розовые колёса */
function makeSkate(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'awake-skate';
  // дека: сверху — лайм с розовыми полосами (видно сверху-спереди), снизу — зелёный Сбера, кромка розовая
  const side = new THREE.MeshStandardMaterial({ color: '#FF3FA4', roughness: 0.45, emissive: new THREE.Color('#FF3FA4'), emissiveIntensity: 0.25 });
  const top = new THREE.MeshStandardMaterial({ map: deckTexture(), roughness: 0.6, emissive: new THREE.Color('#B5E36A'), emissiveIntensity: 0.15 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.03, 0.19), [side, side, top, new THREE.MeshStandardMaterial({ color: '#21A038', roughness: 0.5 }), side, side]);
  g.add(deck);
  const wm = new THREE.MeshStandardMaterial({ color: '#FF3FA4', roughness: 0.35, emissive: new THREE.Color('#FF3FA4'), emissiveIntensity: 0.35 });
  const wg = new THREE.CylinderGeometry(0.035, 0.035, 0.035, 14);
  wg.rotateX(Math.PI / 2);
  for (const x of [-0.21, 0.21])
    for (const z of [-0.07, 0.07]) {
      const w = new THREE.Mesh(wg, wm);
      w.position.set(x, -0.045, z);
      g.add(w);
    }
  g.position.y = -0.035;
  g.visible = false;
  return g;
}
