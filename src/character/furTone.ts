/**
 * Тон меха (рантайм, без пересборки текстур): альбедо Tripo у всех трёх котов тёмное и насыщенно-синее
 * (медиана sRGB ≈ 107,120,165), а на референсах (design/refs — официальные рендеры СберКота) мех холодный
 * серый с лёгкой голубизной (≈ 145,150,170), морда, щёки, подбородок и кольцо вокруг глаз почти белые, макушка и
 * затылок темнее, нос лососево-розовый, внутренность ушей розовая.
 * В шейдере каждого «мехового» материала (тело, мех-оболочки, карточки, веки, брови) цвет после карты и цвета
 * вершин переводится в sRGB, пиксели меха (по оттенку: синее красного, зелёный ≈ красный, не тёмные) сдвигаются к
 * целевому тону с ослабленным контрастом (рисунок шерсти остаётся), чуть обесцвечиваются. Одежда, золото, глаза
 * под маску не попадают (другой оттенок).
 * Маска лица (тело, оболочки, карточки — у них общие координаты покоя): по точкам лица из GLB (extras.marks узла
 * Brows, стадия face_detail) — светлая морда/щёки/подбородок/вокруг глаз, тёмная макушка. Стоимость — десяток ALU.
 */
import * as THREE from 'three';

export interface FurToneParams {
  /** средний цвет меха в альбедо (sRGB 0..1) */
  src: [number, number, number];
  /** целевой средний цвет (sRGB 0..1) */
  dst: [number, number, number];
  /** сохранение контраста шерсти (0 — плоский цвет, 1 — как в текстуре) */
  contrast: number;
  /** обесцвечивание 0..1 */
  desat: number;
  /** цвет светлой морды (sRGB) */
  white?: [number, number, number];
  /** сила светлой морды 0..1 */
  face?: number;
  /** густота тёмных бровей 0..1 */
  brow?: number;
}

const S = (r: number, g: number, b: number): [number, number, number] => [r / 255, g / 255, b / 255];

/** по design/refs/sbercat_*.png (мех на лбу, щеках, морде) и design/sheets/*_turnaround.jpg */
export const FUR_TONE: Record<string, FurToneParams> = {
  glitter: { src: S(110, 122, 166), dst: S(146, 152, 178), contrast: 0.78, desat: 0.22, white: S(214, 218, 230), face: 0.6, brow: 0.3 },
  hooligan: { src: S(118, 131, 174), dst: S(138, 145, 168), contrast: 0.8, desat: 0.3, white: S(214, 218, 226), face: 0.85, brow: 0.85 },
  kind: { src: S(120, 132, 172), dst: S(144, 151, 176), contrast: 0.78, desat: 0.26, white: S(220, 223, 232), face: 0.85, brow: 0.7 },
};

/** точки лица в координатах покоя тела (extras.marks узла Brows) */
interface Marks {
  nose: number[];
  eyeOuterL: number[];
  eyeOuterR: number[];
  eyeInnerL: number[];
  eyeInnerR: number[];
  eyeBottomL: number[];
  eyeBottomR: number[];
  eyeTopL: number;
  eyeTopR: number;
}

export class FurTone {
  readonly uniforms = {
    uFtSrc: { value: new THREE.Vector3(...FUR_TONE.kind.src) },
    uFtDst: { value: new THREE.Vector3(...FUR_TONE.kind.dst) },
    uFtK: { value: new THREE.Vector2(FUR_TONE.kind.contrast, FUR_TONE.kind.desat) },
    uFtOn: { value: 1 },
    uFtWhite: { value: new THREE.Vector4(...(FUR_TONE.kind.white as [number, number, number]), FUR_TONE.kind.face ?? 0) },
    /** нос (xyz) и межглазье (w) */
    uFtNose: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFtEyeL: { value: new THREE.Vector3() },
    uFtEyeR: { value: new THREE.Vector3() },
    uFtBrow: { value: FUR_TONE.kind.brow ?? 0 },
  };
  private done = new WeakSet<THREE.Material>();

  setPersona(id: string) {
    const p = FUR_TONE[id] ?? FUR_TONE.kind;
    this.uniforms.uFtSrc.value.set(...p.src);
    this.uniforms.uFtDst.value.set(...p.dst);
    this.uniforms.uFtK.value.set(p.contrast, p.desat);
    const w = p.white ?? p.dst;
    this.uniforms.uFtWhite.value.set(w[0], w[1], w[2], p.face ?? 0);
    this.uniforms.uFtBrow.value = p.brow ?? 0;
  }

  /** все меховые материалы модели (после buildFurShells — оболочки и карточки тоже) */
  attach(model: THREE.Object3D) {
    const marks = model.getObjectByName('Brows')?.userData?.marks as Marks | undefined;
    if (marks?.nose && marks.eyeOuterL) {
      const v = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
      const eyeD = v(marks.eyeOuterL).distanceTo(v(marks.eyeOuterR));
      this.uniforms.uFtNose.value.set(marks.nose[0], marks.nose[1], marks.nose[2], eyeD);
      const eye = (o: number[], i: number[], b: number[], top: number) => new THREE.Vector3((o[0] + i[0]) / 2, (b[1] + top) / 2, (o[2] + i[2]) / 2);
      this.uniforms.uFtEyeL.value.copy(eye(marks.eyeOuterL, marks.eyeInnerL, marks.eyeBottomL, marks.eyeTopL));
      this.uniforms.uFtEyeR.value.copy(eye(marks.eyeOuterR, marks.eyeInnerR, marks.eyeBottomR, marks.eyeTopR));
    }
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !FurTone.isFur(m.name)) return;
      const spatial = FurTone.isSpatial(m);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) this.patch(mat as THREE.MeshStandardMaterial, spatial);
    });
  }

  /** чьи материалы тонировать: тело и всё «меховое»; не глаза, рот, нос-накладки, румянец, усы, подушечки */
  static isFur(name: string) {
    return !/^(EyeBall|Mouth|Blush|Whiskers|BD_Pads|BD_Metal|BD_Cloth|Emblem|Tear)/.test(name);
  }

  /** маска лица — только у сеток в координатах покоя тела: само тело (скин, морфы), оболочки, карточки */
  static isSpatial(m: THREE.Mesh) {
    return /^BD_Fur/.test(m.name) || ((m as THREE.SkinnedMesh).isSkinnedMesh && !/^BD_|^Blush|^Brows/.test(m.name) && (m.geometry.attributes.position?.count ?? 0) > 5000);
  }

  patch(m: THREE.MeshStandardMaterial, spatial = false) {
    if (!m || this.done.has(m) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
    this.done.add(m);
    const U = this.uniforms;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev?.call(m, sh, r);
      Object.assign(sh.uniforms, U);
      if (spatial) {
        sh.vertexShader = 'varying vec3 vFtP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFtP = position;');
      }
      sh.fragmentShader =
        (spatial ? '#define FT_SPATIAL\nvarying vec3 vFtP;\n' : '') +
        'uniform vec3 uFtSrc; uniform vec3 uFtDst; uniform vec2 uFtK; uniform float uFtOn; uniform vec4 uFtWhite; uniform vec4 uFtNose; uniform vec3 uFtEyeL; uniform vec3 uFtEyeR; uniform float uFtBrow;\n' +
        'float ftEll(vec3 p, vec3 c, vec3 r) { vec3 q = (p - c) / r; return 1.0 - smoothstep(0.55, 1.0, length(q)); }\n' +
        sh.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  if (uFtOn > 0.5) {
    vec3 ftS = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
    float ftL = dot(ftS, vec3(0.299, 0.587, 0.114));
    // мех: синее красного, зелёный близко к красному, не тёмная линия
    float ftM = smoothstep(0.045, 0.12, ftS.b - ftS.r) * exp(-pow((ftS.g - ftS.r - 0.05) / 0.075, 2.0)) * smoothstep(0.16, 0.3, ftL);
    vec3 ftC = uFtDst + (ftS - uFtSrc) * uFtK.x;
    ftC = mix(ftC, vec3(dot(ftC, vec3(0.299, 0.587, 0.114))), uFtK.y);
    // нос и внутренность ушей: тёмно-лиловые у Tripo → лососевый нос и розовые уши, как на референсе
    float ftN = smoothstep(0.08, 0.18, ftS.r - ftS.g) * smoothstep(0.0, 0.06, ftS.r - ftS.b) * smoothstep(-0.02, 0.04, ftS.b - ftS.g) * (1.0 - ftM);
    vec3 ftP = vec3(0.93, 0.6, 0.66) + (ftS - vec3(0.6, 0.38, 0.45)) * 0.5;
#ifdef FT_SPATIAL
    if (uFtNose.w > 0.0) {
      float D = uFtNose.w;
      vec3 n0 = uFtNose.xyz;
      vec3 p = vFtP;
      // морда, подбородок, нижние щёки, кольцо вокруг глаз — светлые; макушка и затылок — темнее
      float w = ftEll(p, n0 + vec3(0.0, -0.3, -0.12) * D, vec3(0.62, 0.42, 0.5) * D);
      w = max(w, ftEll(p, n0 + vec3(0.0, -0.62, -0.3) * D, vec3(0.5, 0.3, 0.5) * D));
      w = max(w, ftEll(p, n0 + vec3(0.6, -0.32, -0.45) * D, vec3(0.45, 0.36, 0.5) * D) * 0.9);
      w = max(w, ftEll(p, n0 + vec3(-0.6, -0.32, -0.45) * D, vec3(0.45, 0.36, 0.5) * D) * 0.9);
      w = max(w, ftEll(p, uFtEyeL + vec3(0.0, -0.05, 0.0) * D, vec3(0.42, 0.36, 0.42) * D) * 0.6);
      w = max(w, ftEll(p, uFtEyeR + vec3(0.0, -0.05, 0.0) * D, vec3(0.42, 0.36, 0.42) * D) * 0.6);
      vec3 ftW = uFtWhite.rgb + (ftS - uFtSrc) * 0.35;
      ftC = mix(ftC, ftW, w * uFtWhite.a);
      float crown = smoothstep(0.15, 0.7, (p.y - uFtEyeL.y) / D) * (1.0 - 0.5 * smoothstep(-0.2, 0.3, (p.z - n0.z) / D + 0.6));
      float back = smoothstep(0.2, 1.0, (n0.z - p.z) / D - 0.6) * smoothstep(-0.8, 0.0, (p.y - uFtEyeL.y) / D);
      ftC *= 1.0 - (0.06 * crown + 0.02 * back) * (1.0 - w);
      // брови: густая тёмная дуга над глазом от внутреннего уголка вверх-наружу (как на рефах)
      float brow = 0.0;
      for (int i = 0; i < 2; i++) {
        vec3 ec = i == 0 ? uFtEyeL : uFtEyeR;
        float sx = sign(ec.x - n0.x);
        float bx = (p.x - ec.x) * sx / D, by = (p.y - ec.y) / D;
        float yb = 0.29 + 0.07 * bx - 0.4 * bx * bx;
        brow = max(brow, exp(-pow((by - yb) / (0.05 + 0.025 * (1.0 - smoothstep(-0.3, 0.4, bx))), 2.0)) * smoothstep(-0.4, -0.26, bx) * (1.0 - smoothstep(0.28, 0.44, bx)) * step(ec.z - 0.25 * D, p.z));
      }
      ftC = mix(ftC, vec3(0.36, 0.37, 0.44) + (ftS - uFtSrc) * 0.3, brow * uFtBrow);
      // уши выше макушки — розовые, ниже — нос лососевый
      float ear = smoothstep(0.35, 0.6, (p.y - uFtEyeL.y) / D);
      ftP = mix(vec3(0.8, 0.54, 0.52) + (ftS - vec3(0.6, 0.38, 0.45)) * 0.35, vec3(0.92, 0.55, 0.63) + (ftS - vec3(0.6, 0.38, 0.45)) * 0.6, ear);
    }
#endif
    ftC = mix(ftC, ftP, ftN);
    diffuseColor.rgb = mix(diffuseColor.rgb, pow(clamp(ftC, 0.0, 1.0), vec3(2.2)), max(ftM, ftN * 0.85));
  }`,
        );
    };
    const prevKey = m.customProgramCacheKey?.bind(m);
    m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + (spatial ? '|fur-tone-v2s' : '|fur-tone-v2');
    m.needsUpdate = true;
  }
}
