/**
 * Складки лица в шейдере тела (рельеф по весу эмоции, без лишних текстур): «гусиные лапки» у внешних уголков глаз при
 * смехе и прищуре, морщинки на переносице при недовольстве, вертикальные складки между бровей, носогубные дуги при
 * улыбке, складка-«мешочек» под глазом, когда щёки подняты, и полоски на лбу при поднятых бровях.
 * Высота считается по позиции вершины в позе привязки (координаты меша, ориентиры — extras.marks узла Brows от
 * scripts/models/face_detail.py), нормаль возмущается через производные экрана (как bumpMap), сила не зависит от
 * разрешения. При нулевых весах ветка пропускается целиком.
 */
import * as THREE from 'three';

export interface FaceMarks {
  s: number;
  eyeOuterL: number[];
  eyeOuterR: number[];
  eyeInnerL: number[];
  eyeInnerR: number[];
  eyeBottomL: number[];
  eyeBottomR: number[];
  eyeTopL: number;
  eyeTopR: number;
  noseTop: number[];
  nose: number[];
  mouthL: number[];
  mouthR: number[];
  noseHalfW: number;
}

const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

export class FaceWrinkles {
  readonly uniforms = {
    uWrA: { value: new THREE.Vector4() }, // смех/прищур, нос, между бровей, улыбка
    uWrB: { value: new THREE.Vector4() }, // брови вверх, щёки вверх, румянец, общий масштаб
    uWrEyeL: { value: new THREE.Vector3() },
    uWrEyeR: { value: new THREE.Vector3() },
    uWrBotL: { value: new THREE.Vector3() },
    uWrBotR: { value: new THREE.Vector3() },
    uWrNose: { value: new THREE.Vector3() },
    uWrMouthL: { value: new THREE.Vector3() },
    uWrMouthR: { value: new THREE.Vector3() },
    uWrBrow: { value: new THREE.Vector3() }, // x — между бровей, y — линия бровей, z — полуширина носа
  };

  /** модель со стадией «лицо» → складки на материале тела; null — нет ориентиров */
  static attach(model: THREE.Object3D): FaceWrinkles | null {
    const marks = model.getObjectByName('Brows')?.userData?.marks as FaceMarks | undefined;
    if (!marks?.eyeOuterL) return null;
    // тело — самый большой скин-меш
    let body: THREE.SkinnedMesh | null = null;
    let best = 0;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh && m.geometry.attributes.position.count > best) {
        best = m.geometry.attributes.position.count;
        body = m;
      }
    });
    if (!body) return null;
    const w = new FaceWrinkles();
    const U = w.uniforms;
    U.uWrEyeL.value.copy(V(marks.eyeOuterL));
    U.uWrEyeR.value.copy(V(marks.eyeOuterR));
    U.uWrBotL.value.copy(V(marks.eyeBottomL));
    U.uWrBotR.value.copy(V(marks.eyeBottomR));
    U.uWrNose.value.copy(V(marks.noseTop));
    U.uWrMouthL.value.copy(V(marks.mouthL));
    U.uWrMouthR.value.copy(V(marks.mouthR));
    U.uWrBrow.value.set((marks.eyeInnerL[0] + marks.eyeInnerR[0]) / 2, (marks.eyeTopL + marks.eyeTopR) / 2, marks.noseHalfW);
    U.uWrB.value.w = marks.s || 1;
    const mesh = body as THREE.SkinnedMesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) w.patch(m as THREE.MeshStandardMaterial);
    return w;
  }

  /** веса лица за кадр → сила складок */
  update(W: Record<string, number>) {
    const g = (k: string) => W[k] ?? 0;
    const laugh = Math.max(g('eyes_laugh'), 0.7 * g('eyes_squint'), 0.6 * g('eyes_smug'), 0.45 * g('smile'), 0.8 * Math.max(g('wink_L'), g('wink_R')));
    this.uniforms.uWrA.value.set(laugh, Math.max(g('nose_wrinkle'), 0.5 * g('brow_down')), g('brow_down'), Math.max(g('smile'), 0.7 * g('smirk')));
    this.uniforms.uWrB.value.x = g('brow_up');
    this.uniforms.uWrB.value.y = Math.max(g('cheek_up'), 0.8 * g('eyes_laugh'));
    this.uniforms.uWrB.value.z = g('blush');
  }

  private patch(m: THREE.MeshStandardMaterial) {
    const U = this.uniforms;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev?.call(m, sh, r);
      Object.assign(sh.uniforms, U);
      sh.vertexShader = 'varying vec3 vWrP;\n' + sh.vertexShader.replace('#include <morphtarget_vertex>', '#include <morphtarget_vertex>\n  vWrP = transformed;');
      sh.fragmentShader =
        `varying vec3 vWrP;
uniform vec4 uWrA; uniform vec4 uWrB;
uniform vec3 uWrEyeL; uniform vec3 uWrEyeR; uniform vec3 uWrBotL; uniform vec3 uWrBotR; uniform vec3 uWrNose;
uniform vec3 uWrMouthL; uniform vec3 uWrMouthR; uniform vec3 uWrBrow;
float wrFan(vec2 d, float sgn, float s) {
  // три луча от внешнего уголка глаза наружу
  vec2 q = vec2(d.x * sgn, d.y) / s;
  float r = length(q);
  float a = atan(q.y, q.x);
  float rays = exp(-pow((a - 0.42) / 0.11, 2.0)) + exp(-pow(a / 0.11, 2.0)) + exp(-pow((a + 0.4) / 0.11, 2.0));
  return -rays * smoothstep(0.003, 0.008, r) * (1.0 - smoothstep(0.014, 0.026, r)) * step(0.0, q.x);
}
float wrSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float wrHeight(vec3 P) {
  float s = uWrB.w;
  float h = 0.0;
  if (uWrA.x > 0.01) h += uWrA.x * (wrFan(P.xy - uWrEyeL.xy, 1.0, s) + wrFan(P.xy - uWrEyeR.xy, -1.0, s));
  if (uWrA.y > 0.01) {
    vec2 c = (P.xy - (uWrNose.xy + vec2(0.0, 0.013 * s))) / s;
    float m = exp(-pow(c.x / 0.013, 2.0) - pow(c.y / 0.008, 2.0));
    h -= uWrA.y * m * (0.5 + 0.5 * sin(c.y * 6.2832 / 0.0042));
  }
  if (uWrA.z > 0.01) {
    vec2 c = (P.xy - vec2(uWrBrow.x, uWrBrow.y - 0.004 * s)) / s;
    float m = exp(-pow(c.y / 0.009, 2.0));
    h -= uWrA.z * m * (exp(-pow((abs(c.x) - 0.006) / 0.0015, 2.0)));
  }
  if (uWrA.w > 0.01) {
    for (int i = 0; i < 2; i++) {
      float sg = i == 0 ? 1.0 : -1.0;
      vec3 mc = i == 0 ? uWrMouthL : uWrMouthR;
      vec2 a = vec2(uWrNose.x + sg * (uWrBrow.z * 1.25 + 0.004 * s), uWrNose.y - 0.006 * s);
      vec2 b = mc.xy + vec2(sg * 0.007 * s, -0.004 * s);
      float d = wrSeg(P.xy, a, b) / s;
      h -= uWrA.w * 0.7 * exp(-pow(d / 0.0035, 2.0));
    }
  }
  if (uWrB.y > 0.01) {
    for (int i = 0; i < 2; i++) {
      vec3 bc = i == 0 ? uWrBotL : uWrBotR;
      vec2 c = (P.xy - (bc.xy - vec2(0.0, 0.007 * s))) / s;
      float arc = c.y - 0.12 * c.x * c.x / 0.01;
      h -= uWrB.y * 0.45 * exp(-pow(arc / 0.0042, 2.0)) * exp(-pow(c.x / 0.018, 2.0));
    }
  }
  if (uWrB.x > 0.01) {
    vec2 c = (P.xy - vec2(uWrBrow.x, uWrBrow.y + 0.03 * s)) / s;
    float m = exp(-pow(c.x / 0.05, 2.0) - pow(c.y / 0.016, 2.0));
    h -= uWrB.x * 0.3 * m * (0.5 + 0.5 * sin(c.y * 6.2832 / 0.009));
  }
  return h;
}
vec3 wrPerturb(vec3 surfPos, vec3 n, float fd, float hh) {
  vec3 dpx = dFdx(surfPos), dpy = dFdy(surfPos);
  float lx = max(length(dpx), 1e-6), ly = max(length(dpy), 1e-6);
  vec2 dH = vec2(dFdx(hh) / lx, dFdy(hh) / ly);
  vec3 sx = dpx / lx, sy = dpy / ly;
  vec3 R1 = cross(sy, n), R2 = cross(n, sx);
  float det = dot(sx, R1) * fd;
  vec3 g = sign(det) * (dH.x * R1 + dH.y * R2);
  return normalize(abs(det) * n - g);
}
` +
        sh.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
  if (uWrB.z > 0.01) {
    // румянец: мягкие розовые пятна на щеках (как на референсе — крупнее накладки Blush)
    float s = uWrB.w;
    float bl = 0.0;
    for (int i = 0; i < 2; i++) {
      vec3 bc = i == 0 ? uWrBotL : uWrBotR;
      vec2 c = (vWrP.xy - (bc.xy + vec2((i == 0 ? 1.0 : -1.0) * 0.012 * s, -0.026 * s))) / s;
      bl += exp(-pow(c.x / 0.03, 2.0) - pow(c.y / 0.018, 2.0));
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.98, 0.42, 0.5) * 0.95, clamp(bl, 0.0, 1.0) * 0.75 * uWrB.z * step(0.0, vWrP.z - uWrMouthL.z + 0.04));
  }`,
        ).replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
  if (uWrA.x + uWrA.y + uWrA.z + uWrA.w + uWrB.x + uWrB.y > 0.02 && vWrP.y > uWrMouthL.y - 0.05) {
    // высота складки в единицах модели (≈ 1 мм при росте 1) → наклон нормали
    float wrH = wrHeight(vWrP) * 0.006 * uWrB.w;
    normal = wrPerturb(-vViewPosition, normal, faceDirection, wrH);
  }`,
        );
    };
    const prevKey = m.customProgramCacheKey?.bind(m);
    m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|face-wrinkles-v2';
    m.needsUpdate = true;
  }
}
