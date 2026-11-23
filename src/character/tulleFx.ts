/**
 * Фатин юбки Блёстки по рефу design/cut/glitter: полупрозрачная мятная пачка с мелкой сеткой, золотыми блёстками
 * и золотой полосой по подолу. Только у фатина с разметкой (scripts/models/persona_tune.py: узел Skirt_Glitter,
 * extras.tulleUV — UV0 = (угол/2π, t), t = 0 у пояса … 1 у подола; модели v2, по умолчанию). Без текстур: процедурно
 * в шейдере, десяток ALU; блики блёсток мерцают от взгляда (без времени — без перерисовки).
 */
import * as THREE from 'three';

export interface TulleLook {
  /** доля высоты от подола под золотую полосу */
  band: number;
  /** плотность блёсток 0..1 */
  sparkle: number;
  /** цвет золота (линейный) */
  gold: [number, number, number];
  /** сила кромки по подолу 0..1 (смешение с золотом; блёстки — всегда в полную силу) */
  bandK: number;
}

/**
 * 20.11 (кадр КотоТом 17-11, design/sheets/glitter_turnaround.jpg): у подола тонкая мягкая золотистая кромка, блёстки
 * гуще к подолу, общий тон мятно-золотой. Было band 0.1 / смешение 0.85 — толстое жёлтое кольцо.
 */
export const TULLE_GLITTER: TulleLook = { band: 0.1, sparkle: 0.28, gold: [0.82, 0.6, 0.24], bandK: 0.72 };
// 23.11 (разворот design/refs/glitter_turnaround_1123.png): у каждого слоя — широкая золотая блестящая кайма с фестонами
// (край волной по окружности), блёстки по всей пачке гуще; было band 0.04 / sparkle 0.16 / bandK 0.6 — тонкая кромка

/**
 * Вторичная анимация фатина (живой покой Блёстки, 20.11): сдвиг к подолу (∝ t^1.5) — пружина от скорости таза
 * (GlbCharacter.applyTulle), и мелкая рябь по нормали. Униформы — в userData.tulle материала.
 */
export interface TulleMotion {
  /** сдвиг подола в системе меша */
  sway: { value: THREE.Vector3 };
  /** x — время, с; y — амплитуда ряби (в единицах меша) */
  flut: { value: THREE.Vector2 };
}
const tulleMeshes = new WeakSet<THREE.Mesh>();
export function tulleMotion(m: THREE.Mesh): TulleMotion | null {
  return ((m.material as THREE.Material).userData?.tulle as TulleMotion | undefined) ?? null;
}
/** меши фатина модели (после attachTulle) */
export function tulleOf(model: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  model.traverse((o) => {
    if (tulleMeshes.has(o as THREE.Mesh)) out.push(o as THREE.Mesh);
  });
  return out;
}

/** подключить к фатину модели (если есть разметка); вернуть число мешей */
export function attachTulle(model: THREE.Object3D, look: TulleLook = TULLE_GLITTER): number {
  let n = 0;
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.userData?.tulleUV) return;
    const uv = m.geometry.getAttribute('uv');
    if (!uv) return;
    m.geometry.setAttribute('tulleT', uv);
    const mat = m.material as THREE.MeshStandardMaterial;
    patch(mat, look);
    tulleMeshes.add(m);
    n++;
  });
  return n;
}

function patch(m: THREE.MeshStandardMaterial, look: TulleLook) {
  const prev = m.onBeforeCompile;
  const motion: TulleMotion = { sway: { value: new THREE.Vector3() }, flut: { value: new THREE.Vector2() } };
  m.userData.tulle = motion;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.uniforms.uTuGold = { value: new THREE.Vector3(...look.gold) };
    sh.uniforms.uTuK = { value: new THREE.Vector3(look.band, look.sparkle, look.bandK) };
    sh.uniforms.uTuSway = motion.sway;
    sh.uniforms.uTuFlut = motion.flut;
    sh.vertexShader =
      'attribute vec2 tulleT;\nvarying vec2 vTu;\nuniform vec3 uTuSway;\nuniform vec2 uTuFlut;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vTu = tulleT;
  {
    // пачка качается от пояса к подолу (пружина от таза) и чуть дышит рябью по нормали
    float tt = clamp(tulleT.y, 0.0, 1.0);
    transformed += uTuSway * pow(tt, 1.5);
    transformed += objectNormal * uTuFlut.y * tt * sin(uTuFlut.x * 5.0 + tulleT.x * 6.2832 * 6.0);
  }`,
      );
    sh.fragmentShader =
      'varying vec2 vTu;\nuniform vec3 uTuGold;\nuniform vec3 uTuK;\nfloat tuHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  {
    float t = vTu.y;
    // мелкая сетка фатина: чуть плотнее по нитям
    vec2 g = vec2(vTu.x * 900.0, t * 140.0);
    float mesh = 0.5 + 0.5 * max(sin(g.x * 3.1416) * sin(g.y * 3.1416), 0.0);
    diffuseColor.a *= 0.82 + 0.25 * mesh;
    // золотая полоса по подолу (мягкий край) и блёстки, гуще к подолу
    float scal = 0.65 + 0.7 * abs(sin(vTu.x * 6.2832 * 13.0));
    float band = smoothstep(1.0 - uTuK.x * scal - 0.02, 1.0 - uTuK.x * scal + 0.012, t) * uTuK.z;
    band *= 0.75 + 0.25 * tuHash(floor(vec2(vTu.x * 700.0, t * 120.0)));
    vec2 cell = floor(vec2(vTu.x * 420.0, t * 64.0));
    float h = tuHash(cell);
    vec2 f = fract(vec2(vTu.x * 420.0, t * 64.0)) - 0.5;
    float dens = uTuK.y * (0.25 + 0.75 * t * t);
    float sp = step(1.0 - dens, h) * (1.0 - smoothstep(0.18, 0.42, length(f)));
    vec3 gold = uTuGold;
    diffuseColor.rgb = mix(diffuseColor.rgb, gold, max(band, sp));
    diffuseColor.a = max(diffuseColor.a, max(band * 1.1, sp));
    tuSpark = sp + band * 0.2;
  }`,
        )
        .replace('void main() {', 'float tuSpark = 0.0;\nvoid main() {')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  totalEmissiveRadiance += uTuGold * tuSpark * 0.35;`,
        );
  };
  const prevKey = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|tulle-fx-v4';
  m.needsUpdate = true;
}
