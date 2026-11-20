/**
 * Мех: оболочки (shells) по шерсти + пряди-карточки (cards) по силуэту.
 *
 * Оболочки. Геометрию готовят стадии scripts/models/body_detail.py (руки, ноги, хвост) и fur_volume.py (голова):
 * меш BD_FurShell — треугольники меха на тех же буферах, что и тело, + атрибут _FURLEN (длина шерсти в ед. модели:
 * морда короткая, щёки длинные, вокруг глаз/носа/рта 0), на голове — морфы тела (рот и щёки двигают мех).
 * Каждая оболочка — тот же SkinnedMesh (общий скелет и буферы), вершины выталкиваются по скинованной нормали на
 * _FURLEN·h, провисают вниз и чуть колышутся. Во фрагменте — пряди: два масштаба клеточного шума в координатах
 * покоя (не плывёт при анимации, не рвётся на швах UV), прядь тоньше к кончику, край — alpha test,
 * без сортировки прозрачности (alpha test). У корня темнее (самозатенение), кончики светлее и
 * подсвечены по контуру (мягкий «ободок», как на рефах).
 *
 * Карточки. Меш BD_FurCards (fur_volume.py): пучки из двух изогнутых полосок крест-накрест на щеках, макушке,
 * затылке, подбородке, в ушах, на хвосте; UV0 — тексель тела у корня (цвет меха), UV1 — по карточке. Пряди рисует
 * процедурная альфа-текстура (без файлов), мягкие кончики — смешивание без записи глубины, кончики светлее, у карточек «в лоб» к зрителю
 * альфа слабее (не наклейка).
 *
 * Качество: ?fur=0 — без меха, 1 — 4 оболочки, 2 — 8, 3 — 12 (по умолчанию — модели v2: телефон
 * PHONE_SHELLS_V2, ПК 12; ?models=v1 — телефон 8); ?fur=N≥4 — N оболочек.
 *
 * Вид прядей — по поколению моделей (character/modelVariant.ts): v2 (по умолчанию) — FUR_V2, v1 (?models=v1) — как на 841b373.
 * LOD (furLod): видимая доля оболочек = качество (src/core/perf.ts, setFurQuality) × энергия (setFurEnergy:
 * calm 0.75, doze 0.5 и без колыхания) × размер кота на экране (мелкий — меньше слоёв); оставшиеся оболочки
 * перераспределяются по той же длине шерсти, силуэт тот же. Карточки при качестве 0 скрыты.
 */
import * as THREE from 'three';
import { modelsV2 } from './modelVariant';

export interface FurParams {
  layers: number;
  density: number;
  tip: [number, number, number];
}

const DEF: FurParams = { layers: 4, density: 150, tip: [1.06, 1.06, 1.08] };
/** оболочек на уровень ?fur=0..3 */
export const FUR_LEVELS = [0, 4, 8, 12];
/** телефон, модели v2: 6 оболочек + пряди ≈ 1.4× кадра без меха (SwiftShader, 585×1266; 8 — уже 1.5×) */
export const PHONE_SHELLS_V2 = 6;

function isMobile() {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const ua = nav?.userAgent ?? '';
  const cores = nav?.hardwareConcurrency ?? 8;
  const mem = (nav as { deviceMemory?: number } | undefined)?.deviceMemory ?? 8;
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  return mobile || cores <= 4 || mem <= 3;
}

/** ?fur=… (0..3 — уровень, ≥4 — число оболочек); без параметра: телефон/слабое — уровень 2 (v2 — PHONE_SHELLS_V2), ПК — уровень 3 */
export function furLevelParam(search = typeof location !== 'undefined' ? location.search : ''): number | null {
  const s = new URLSearchParams(search).get('fur');
  if (s === null || s === '') return null;
  const q = Number(s);
  return Number.isFinite(q) && q >= 0 ? q : null;
}

/** число оболочек */
export function furLayersFor(_n?: number, search?: string, mobile = isMobile()) {
  const q = furLevelParam(search);
  if (q !== null) return q < 4 ? FUR_LEVELS[Math.round(q)] : Math.min(16, Math.round(q));
  return mobile ? (modelsV2(search) ? PHONE_SHELLS_V2 : FUR_LEVELS[2]) : FUR_LEVELS[3];
}

/** общие для всех котов: время колыхания, энергия, видимая доля по качеству */
const G = {
  time: { value: 0 },
  energy: 1,
  still: false,
};

/** энергобюджет (src/core/energy.ts): в «спокойном» и «дрёме» меньше слоёв, в дрёме мех не колышется */
export function setFurEnergy(mode: string) {
  G.energy = mode === 'doze' ? 0.5 : mode === 'calm' ? 0.75 : 1;
  G.still = mode === 'doze' || mode === 'calm';
}

interface FurLod {
  shells: THREE.SkinnedMesh[];
  h: { value: number }[];
  quality: number;
  visible: number;
  cards: THREE.Mesh | null;
  /** высота кота на экране, px (последний кадр) */
  px: number;
  /** мех включён (?fur≠0) */
  on: boolean;
}

const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v2 = new THREE.Vector2();

/** сколько оболочек показывать: качество × энергия × размер на экране (≥ 2, если вообще есть мех) */
export function furVisibleCount(n: number, quality: number, energy: number, px: number) {
  if (!n || quality <= 0) return 0;
  const dist = px <= 0 ? 1 : THREE.MathUtils.clamp((px - 120) / (520 - 120), 0.3, 1);
  return Math.max(Math.min(n, 2), Math.min(n, Math.round(n * quality * energy * dist)));
}

function applyLod(lod: FurLod) {
  const n = lod.shells.length;
  const m = furVisibleCount(n, lod.quality, G.energy, lod.px);
  if (lod.cards) lod.cards.visible = lod.on && lod.quality > 0;
  if (m === lod.visible) return;
  lod.visible = m;
  // видимые — равномерно по длине шерсти (последняя, внешняя, всегда), их h пересчитан под m слоёв
  const keep = new Map<number, number>();
  for (let j = 1; j <= m; j++) keep.set(Math.round((j * n) / m) - 1, j / m);
  lod.shells.forEach((s, i) => {
    const h = keep.get(i);
    s.visible = h !== undefined;
    if (h !== undefined) lod.h[i].value = h;
  });
}

let TUFT: THREE.DataTexture | null = null;
/** альфа пучка: 15 тонких прядей разной длины, сужаются и тают к кончику, чуть изогнуты (G — альфа) */
export function tuftTexture() {
  if (TUFT) return TUFT;
  const W = 64, H = 128;
  const d = new Uint8Array(W * H * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const strands = Array.from({ length: 15 }, (_, i) => ({ x: 0.08 + (0.84 * (i + 0.5)) / 15 + (rnd() - 0.5) * 0.05, len: 0.55 + 0.45 * rnd(), w: 0.022 + 0.018 * rnd(), bend: (rnd() - 0.5) * 0.18 }));
  for (let y = 0; y < H; y++) {
    const t = (y + 0.5) / H; // 0 — корень
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      let a = 0;
      for (const s of strands) {
        if (t > s.len) continue;
        const k = t / s.len;
        const cx = s.x + s.bend * k * k + (0.5 - s.x) * 0.3 * k; // кончики чуть сходятся
        const w = s.w * (1 - 0.75 * k) + 0.006;
        const dd = Math.abs(u - cx) / w;
        a = Math.max(a, THREE.MathUtils.clamp(1.25 - dd, 0, 1) * (1 - k * k * 0.85));
      }
      // у корня пучок сплошной (уходит в шерсть)
      a = Math.max(a, THREE.MathUtils.clamp(1 - t / 0.2, 0, 1) * THREE.MathUtils.clamp(1.2 - Math.abs(u - 0.5) * 2.4, 0, 1));
      const o = (y * W + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = Math.round(a * 255);
      d[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(d, W, H, THREE.RGBAFormat);
  tex.channel = 1;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  TUFT = tex;
  return tex;
}

/**
 * Вид прядей по поколению моделей. v1 — ровно как на 841b373 (модели bb768e9). v2 — под модели v2 (fur_volume v2):
 * нижняя граница цвета (тёмные тексели обводки и складок не дают тёмных точек), мягкие кончики карточек.
 */
interface FurLook {
  key: string;
  /** нижняя граница цвета пряди (линейный), null — нет */
  floor: string | null;
  /** радиусы прядей (GLSL, h — доля длины) */
  rad1: string;
  rad2: string;
  /** карточки: альфа тает к кончику (1 − k·t²) */
  cardTip: number;
  /** карточки: альфа «в лоб» и на силуэте, начало перехода */
  cardFacing: [number, number, number];
}
const FUR_V1: FurLook = {
  key: '2',
  floor: null,
  rad1: '0.48 * (1.0 - 0.75 * h) * (0.85 + 0.3 * r1.z) * step(h, 0.55 + 0.5 * r1.x)',
  rad2: '0.42 * (1.0 - 0.8 * h) * step(h, 0.35 + 0.45 * r2.x)',
  cardTip: 0,
  cardFacing: [1.0, 0.45, 0.55],
};
export const FUR_V2: FurLook = {
  key: 'v2b',
  floor: 'vec3(0.15, 0.165, 0.22)',
  rad1: '0.52 * (1.0 - 0.7 * h) * (0.85 + 0.3 * r1.z) * step(h, 0.55 + 0.5 * r1.x)',
  rad2: '0.46 * (1.0 - 0.75 * h) * step(h, 0.4 + 0.45 * r2.x)',
  // v2b: кончики тают слабее (светлые кончики — это яркость меха; 0.7 и «в лоб» 0.4 делали кота темнее v1)
  cardTip: 0.4,
  cardFacing: [1.0, 0.45, 0.55],
};
const furLook = () => (modelsV2() ? FUR_V2 : FUR_V1);
const glf = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const SHELL_COMMON = `
uniform float uShell;
uniform float uDensity;
uniform vec3 uTip;
varying vec3 vRest;
varying vec3 vRestN;
varying float vFur;
vec3 furHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
// расстояние до ближайшей пряди в касательной плоскости (в долях клетки) и её случайные числа
float furStrand(vec3 q, vec3 nn, out vec3 r) {
  vec3 c = floor(q);
  vec3 f = fract(q);
  r = furHash(c);
  vec3 v = f - (0.25 + 0.5 * r);
  return length(v - nn * dot(v, nn));
}`;

export function buildFurShells(model: THREE.Object3D, body?: THREE.MeshStandardMaterial): THREE.SkinnedMesh[] {
  const shells: THREE.SkinnedMesh[] = [];
  let src: THREE.SkinnedMesh | null = null;
  let cardsSrc: THREE.SkinnedMesh | null = null;
  let bodyMat = body ?? null;
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    if (/^BD_FurShell/.test(m.name)) src = m;
    else if (/^BD_FurCards/.test(m.name)) cardsSrc = m;
    else if (!bodyMat && !/^BD_/.test(m.name) && (m.geometry.attributes.position?.count ?? 0) > 5000) bodyMat = m.material as THREE.MeshStandardMaterial;
  });
  const n = furLayersFor();
  const cards = cardsSrc as THREE.SkinnedMesh | null;
  const lod: FurLod = { shells, h: [], quality: 1, visible: -1, cards, px: 0, on: n > 0 };
  model.userData.furLod = lod;
  if (cards) setupCards(cards, bodyMat, n > 0);
  const sm = src as THREE.SkinnedMesh | null;
  if (!sm || !sm.geometry.attributes._furlen) return shells;
  sm.visible = false;
  sm.raycast = () => {};
  const p: FurParams = { ...DEF, ...((sm.userData?.fur as Partial<FurParams>) ?? {}) };
  const tip = new THREE.Vector3(...p.tip);
  const look = furLook();
  for (let k = 1; k <= n; k++) {
    const uShell = { value: k / n };
    lod.h.push(uShell);
    const mat = new THREE.MeshStandardMaterial({
      map: bodyMat?.map ?? null,
      roughness: 0.9,
      metalness: 0,
      side: THREE.FrontSide,
    });
    mat.name = `BD_fur_${k}`;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uShell = uShell;
      sh.uniforms.uDensity = { value: p.density };
      sh.uniforms.uTip = { value: tip };
      sh.uniforms.uFurTime = G.time;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float _furlen;\nuniform float uShell;\nuniform float uFurTime;\nvarying vec3 vRest;\nvarying vec3 vRestN;\nvarying float vFur;')
        .replace(
          '#include <skinning_vertex>',
          `#include <skinning_vertex>
  {
    float h = uShell;
    // по шерсти: наружу, провисание вниз (кончики тяжелее), лёгкое колыхание кончиков
    transformed += normalize(objectNormal) * _furlen * h;
    transformed.y -= _furlen * 0.45 * h * h;
    float ph = dot(position, vec3(31.0, 17.0, 23.0));
    transformed.xz += vec2(sin(uFurTime * 1.7 + ph), cos(uFurTime * 1.3 + ph * 1.3)) * _furlen * 0.18 * h * h;
  }
  vRest = position;
  vRestN = normal;
  vFur = _furlen;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>' + SHELL_COMMON)
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>${look.floor ? `\n  diffuseColor.rgb = max(diffuseColor.rgb, ${look.floor});` : ''}
  {
    vec3 nn = normalize(vRestN);
    vec3 r1, r2;
    // крупные пряди-пучки + мелкий подшёрсток (свой масштаб и сдвиг)
    float d1 = furStrand(vRest * uDensity, nn, r1);
    float d2 = furStrand(vRest * uDensity * 2.3 + 17.0, nn, r2);
    float h = uShell;
    // у каждой пряди своя длина; тоньше к кончику
    float rad1 = ${look.rad1};
    float rad2 = ${look.rad2};
    float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
    // в лоб к зрителю — реже (шерсть видна по контуру), на силуэте — гуще
    float edge = mix(1.0, 0.72, smoothstep(0.5, 0.98, facing));
    float e1 = rad1 * edge - d1, e2 = rad2 * edge - d2;
    // alpha test (discard): alphaToCoverage на прядях в 1 px давал шум и полупрозрачный холст поверх камеры
    if (vFur < 0.0008 || max(e1, e2) < 0.0) discard;
    // корень темнее (самозатенение), кончик светлее; на контуре — мягкая подсветка кончиков
    float ao = mix(0.86, 1.0, smoothstep(0.0, 0.8, h));
    diffuseColor.rgb *= ao * mix(vec3(1.0), uTip, h);
    diffuseColor.rgb += diffuseColor.rgb * 0.35 * h * pow(1.0 - facing, 2.0);
  }`,
        );
    };
    // слой задаётся униформой uShell — шейдер у всех оболочек один: компилируется один раз, а не по разу на слой
    mat.customProgramCacheKey = () => 'bdfur' + look.key;
    const m = new THREE.SkinnedMesh(sm.geometry, mat);
    m.name = `BD_FurShell_${k}`;
    m.position.copy(sm.position);
    m.quaternion.copy(sm.quaternion);
    m.scale.copy(sm.scale);
    m.bind(sm.skeleton, sm.bindMatrix);
    if (sm.morphTargetDictionary) {
      m.morphTargetDictionary = { ...sm.morphTargetDictionary };
      m.morphTargetInfluences = new Array(Object.keys(sm.morphTargetDictionary).length).fill(0);
    }
    m.frustumCulled = false;
    m.raycast = () => {};
    sm.parent?.add(m);
    shells.push(m);
  }
  // внешняя оболочка видна всегда — по ней раз в кадр: время, размер кота на экране → LOD на следующий кадр
  const outer = shells[shells.length - 1];
  if (outer) {
    let last = 0;
    outer.onBeforeRender = (r, _s2, cam) => {
      const now = performance.now() / 1000;
      if (!G.still) G.time.value += Math.min(0.1, Math.max(0, now - (last || now)));
      last = now;
      const persp = cam as THREE.PerspectiveCamera;
      if (persp.isPerspectiveCamera) {
        outer.getWorldPosition(_v);
        const dist = _v.distanceTo(cam.getWorldPosition(_s)) || 1;
        outer.getWorldScale(_s);
        const hgt = (model.userData.furHeight ?? 1) * Math.max(_s.x, _s.y, _s.z);
        const bh = r.getDrawingBufferSize(_v2).y;
        lod.px = (hgt / dist / (2 * Math.tan((persp.fov * Math.PI) / 360))) * bh;
      }
      applyLod(lod);
    };
  }
  applyLod(lod);
  return shells;
}

function setupCards(cards: THREE.SkinnedMesh, bodyMat: THREE.MeshStandardMaterial | null, on: boolean) {
  const mat = new THREE.MeshStandardMaterial({
    map: bodyMat?.map ?? null,
    alphaMap: tuftTexture(),
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
    // мягкие кончики: смешивание без записи глубины (поверх непрозрачного тела, порядок внутри пучков не виден)
    transparent: true,
    depthWrite: false,
  });
  mat.name = 'BD_FurCards_rt';
  const look = furLook();
  const [fa, fb, fc] = look.cardFacing.map(glf);
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>${look.floor ? `\n  diffuseColor.rgb = max(diffuseColor.rgb, ${look.floor});` : ''}`,
    ).replace(
      '#include <alphamap_fragment>',
      `#include <alphamap_fragment>
  {
    float t = vAlphaMapUv.y;${look.cardTip ? `\n    // мягкий кончик: альфа тает к концу пряди (облако, а не щётка)\n    diffuseColor.a *= 1.0 - ${glf(look.cardTip)} * t * t;` : ''}
    float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
    // пучок на поверхности «в лоб» к зрителю — прозрачнее (не наклейка), на силуэте — целиком
    diffuseColor.a *= mix(${fa}, ${fb}, smoothstep(${fc}, 0.95, facing));
    if (diffuseColor.a < 0.03) discard;
    diffuseColor.rgb *= mix(0.78, 1.04, t);
    diffuseColor.rgb += diffuseColor.rgb * 0.22 * t * pow(1.0 - facing, 2.0);
  }`,
    );
  };
  mat.customProgramCacheKey = () => 'bdcards' + look.key;
  cards.material = mat;
  cards.frustumCulled = false;
  cards.raycast = () => {};
  cards.visible = on;
}

/**
 * Адаптивное качество (src/core/perf.ts): доля оболочек (1 — все), с энергией и размером на экране — furLod.
 * Без пересборки шейдеров.
 */
export function setFurQuality(root: THREE.Object3D, frac: number) {
  let lod: FurLod | undefined;
  root.traverse((o) => {
    if (!lod && o.userData.furLod) lod = o.userData.furLod as FurLod;
  });
  if (!lod) return;
  lod.quality = frac;
  lod.visible = -1;
  applyLod(lod);
}
