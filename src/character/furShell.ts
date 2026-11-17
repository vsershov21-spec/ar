/**
 * Мех по силуэту: несколько оболочек (shells) поверх меха тела. Геометрию готовит стадия
 * scripts/models/body_detail.py — меш BD_FurShell (треугольники меха рук, ног, хвоста на тех же буферах,
 * что и тело) с атрибутом _FURLEN (длина шерсти в единицах модели, у края меха плавно → 0).
 *
 * Каждая оболочка — тот же SkinnedMesh (общий скелет и буферы, память не растёт), вершины выталкиваются
 * по скинованной нормали на _FURLEN·k и чуть провисают вниз. Во фрагменте — «волоски»: клеточный шум
 * в координатах покоя (не плывёт при анимации, не рвётся на швах UV), чем дальше оболочка, тем тоньше.
 * Там, где поверхность смотрит прямо на зрителя, волоски реже — шерсть видна по контуру (как у Pixar),
 * а не рябью на всей поверхности. alphaTest через discard, без сортировки прозрачности.
 */
import * as THREE from 'three';

export interface FurParams {
  layers: number;
  density: number;
  tip: [number, number, number];
}

const DEF: FurParams = { layers: 4, density: 150, tip: [1.06, 1.06, 1.08] };

/** слабое устройство: меньше слоёв */
export function furLayersFor(n: number) {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const cores = nav?.hardwareConcurrency ?? 8;
  const mem = (nav as { deviceMemory?: number } | undefined)?.deviceMemory ?? 8;
  return cores <= 4 || mem <= 3 ? Math.max(2, n - 2) : n;
}

export function buildFurShells(model: THREE.Object3D, body?: THREE.MeshStandardMaterial): THREE.SkinnedMesh[] {
  const shells: THREE.SkinnedMesh[] = [];
  let src: THREE.SkinnedMesh | null = null;
  let bodyMat = body ?? null;
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    if (/^BD_FurShell/.test(m.name)) src = m;
    else if (!bodyMat && !/^BD_/.test(m.name) && (m.geometry.attributes.position?.count ?? 0) > 5000) bodyMat = m.material as THREE.MeshStandardMaterial;
  });
  const sm = src as THREE.SkinnedMesh | null;
  if (!sm || !sm.geometry.attributes._furlen) return shells;
  sm.visible = false;
  sm.raycast = () => {};
  const p: FurParams = { ...DEF, ...((sm.userData?.fur as Partial<FurParams>) ?? {}) };
  const n = furLayersFor(p.layers);
  for (let k = 1; k <= n; k++) {
    const h = k / n;
    const mat = new THREE.MeshStandardMaterial({
      map: bodyMat?.map ?? null,
      normalMap: bodyMat?.normalMap ?? null,
      roughness: 0.92,
      metalness: 0,
      side: THREE.FrontSide,
    });
    mat.name = `BD_fur_${k}`;
    const tip = new THREE.Vector3(...p.tip);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uShell = { value: h };
      sh.uniforms.uDensity = { value: p.density };
      sh.uniforms.uTip = { value: tip };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float _furlen;\nuniform float uShell;\nvarying vec3 vRest;\nvarying vec3 vRestN;\nvarying float vFur;')
        .replace(
          '#include <skinning_vertex>',
          '#include <skinning_vertex>\n  transformed += normalize(objectNormal) * _furlen * uShell;\n  transformed.y -= _furlen * 0.35 * uShell * uShell;\n  vRest = position;\n  vRestN = normal;\n  vFur = _furlen;',
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uShell;
uniform float uDensity;
uniform vec3 uTip;
varying vec3 vRest;
varying vec3 vRestN;
varying float vFur;
vec3 furHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
  {
    vec3 q = vRest * uDensity;
    vec3 c = floor(q);
    vec3 f = fract(q);
    vec3 r = furHash(c);
    // волосок — столбик вдоль нормали покоя: расстояние до центра клетки только в касательной плоскости
    vec3 v = f - (0.3 + 0.4 * r);
    vec3 nn = normalize(vRestN);
    float d = length(v - nn * dot(v, nn));
    // волосок тоньше к кончику; у каждого своя длина
    float rad = 0.5 * (1.0 - 0.55 * uShell) * (0.75 + 0.4 * r.z);
    float alive = step(uShell, 0.35 + 0.75 * r.x);
    float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
    float edge = 1.0 - smoothstep(0.55, 0.98, facing) * 0.75;
    if (vFur < 0.0008 || d > rad * edge || alive < 0.5) discard;
    diffuseColor.rgb *= mix(vec3(0.82), uTip, uShell);
  }`,
        );
    };
    mat.customProgramCacheKey = () => `bdfur${k}`;
    const m = new THREE.SkinnedMesh(sm.geometry, mat);
    m.name = `BD_FurShell_${k}`;
    m.position.copy(sm.position);
    m.quaternion.copy(sm.quaternion);
    m.scale.copy(sm.scale);
    m.bind(sm.skeleton, sm.bindMatrix);
    m.frustumCulled = false;
    m.raycast = () => {};
    sm.parent?.add(m);
    shells.push(m);
  }
  return shells;
}
