/**
 * База котов + скин (docs/models/BASE.md, ?models=base): одна модель кота models/base/cat_base.glb (тело и голова, скелет
 * Mixamo + уши/хвост, риг лица на морфах — scripts/models/base_build.py) и скин персонажа models/base/skin_<кот>.glb
 * (одежда отдельными мешами на тот же скелет + вид в asset.extras.catSkin — scripts/models/skin_build.py).
 *
 * Загрузка (glbCharacter.load): адрес — скин; по его extras.catSkin грузится база (тот же файл у всех котов: HTTP-кэш —
 * один раз), меши скина переезжают в сцену базы и привязываются к её костям по имени (inverseBindMatrices те же). Дальше
 * всё как у одной модели: мимика, eyeRig, хват, коллайдеры, footPin, кровать — один набор настроек; скин задаёт только
 * вид: лицо в покое, множители век, ресницы-лепестки, толщину подводки, тон бровей, эффекты (искры хвоста).
 */
import * as THREE from 'three';

export interface CatSkinLook {
  version: number;
  persona: string;
  /** файл базы рядом со скином */
  base: string;
  /** лицо в покое (ключи FacePreset, минимум веса) */
  rest?: Record<string, number>;
  /** множители весов век/румянца в покое и клипах */
  eyes?: Record<string, number>;
  /** верхнее веко в покое (доля, eyeRig extras.restUp) */
  restUp?: number;
  /** ресницы-лепестки у внешнего уголка: 0 — убрать (Хулиган, Добряк) */
  petals?: number;
  /** толщина подводки века (eyeRig extras.lash) */
  lash?: number;
  /** эффекты: 'tailSparkle' — блёстки хвоста */
  fx?: string[];
  /** меши базы, скрытые у этого скина (подстрока имени) */
  hide?: string[];
  /** кости, под которыми мех-оболочки выключены (стопы в кедах/сапожках): _FURLEN → 0 */
  furOff?: string[];
  /** тон бровей (множитель цвета материала Brows) */
  brow?: [number, number, number] | null;
}

/** адрес скина → адрес базы (models/base/skin_kind.glb → models/base/cat_base.glb) */
export function skinBaseUrl(skinUrl: string, look: Pick<CatSkinLook, 'base'>): string {
  return skinUrl.replace(/[^/]*$/, '') + (look.base || 'cat_base.glb');
}

/** скин ли это по адресу (до загрузки: прелоад базы вместе со скином) */
export function isSkinUrl(url: string): boolean {
  return /(^|\/)models\/base\/skin_[a-z]+\.glb$/.test(url);
}

/** база по адресу скина без extras (прелоад) */
export function baseOfSkinUrl(url: string): string | null {
  return isSkinUrl(url) ? url.replace(/[^/]*$/, 'cat_base.glb') : null;
}

const strip = (n: string) => n.replace(/^mixamorig:?/, '');

/**
 * меши скина → в сцену базы: кости по имени, тот же bindMatrix и boneInverses; родитель — узел базы с тем же именем
 * (Armature), иначе корень. Возвращает число перенесённых мешей.
 */
export function graftSkin(base: THREE.Object3D, skin: THREE.Object3D): number {
  const bones = new Map<string, THREE.Bone>();
  const nodes = new Map<string, THREE.Object3D>();
  base.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(strip(o.name), o as THREE.Bone);
    if (o.name && !nodes.has(o.name)) nodes.set(o.name, o);
  });
  base.updateMatrixWorld(true);
  skin.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  skin.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  let n = 0;
  for (const m of meshes) {
    m.userData.skinPart = true;
    const parent = (m.parent && nodes.get(m.parent.name)) || base;
    const sm = m as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton) {
      const bs = sm.skeleton.bones.map((b) => bones.get(strip(b.name)));
      if (bs.some((b) => !b)) {
        console.warn('[skin] кость скина не найдена в базе', m.name);
        continue;
      }
      const skel = new THREE.Skeleton(bs as THREE.Bone[], sm.skeleton.boneInverses.map((x) => x.clone()));
      const bindMatrix = sm.bindMatrix.clone();
      parent.add(sm);
      sm.bind(skel, bindMatrix);
    } else {
      parent.add(m);
    }
    n++;
  }
  return n;
}

/** вид скина до разбора характера: веки, ресницы, скрытые меши (вызывается до EyeRig.find) */
export function applySkinLook(model: THREE.Object3D, look: CatSkinLook) {
  const lidLo = new Map<string, number>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && /^LidLo_[LR]$/.test(m.name)) lidLo.set(m.name.slice(-1), m.geometry.getAttribute('position').count);
  });
  model.traverse((o) => {
    if (/^Eye_[LR]$/.test(o.name)) {
      if (look.restUp !== undefined) o.userData.restUp = look.restUp;
      if (look.lash !== undefined) o.userData.lash = look.lash;
    }
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (look.hide?.some((h) => m.name.includes(h))) m.visible = false;
    // мех не сквозь обувь: у вершин с весом костей furOff длина шерсти 0 (атрибут общий у оболочек — до buildFurShells)
    const fl = m.geometry.getAttribute('_furlen') ?? m.geometry.getAttribute('_FURLEN');
    const sm = m as THREE.SkinnedMesh;
    if (look.furOff?.length && fl && sm.isSkinnedMesh && sm.skeleton) {
      const off = new Set(sm.skeleton.bones.map((b, i) => (look.furOff!.includes(strip(b.name)) ? i : -1)).filter((i) => i >= 0));
      const si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
      if (off.size && si && sw) {
        let n = 0;
        for (let v = 0; v < fl.count; v++) {
          let w = 0;
          for (let c = 0; c < 4; c++) if (off.has(si.getComponent(v, c))) w += sw.getComponent(v, c);
          if (w > 0.15) {
            fl.setX(v, 0);
            n++;
          }
        }
        if (n) fl.needsUpdate = true;
      }
    }
    // ресницы-лепестки (persona_tune.petals: вершины после сетки века, их число — как у нижнего века)
    if (look.petals === 0 && /^LidUp_[LR]$/.test(m.name)) {
      const nb = lidLo.get(m.name.slice(-1));
      const idx = m.geometry.getIndex();
      if (nb && idx) {
        const a = idx.array;
        const keep: number[] = [];
        for (let i = 0; i < a.length; i += 3) if (a[i] < nb && a[i + 1] < nb && a[i + 2] < nb) keep.push(a[i], a[i + 1], a[i + 2]);
        if (keep.length < a.length) m.geometry.setIndex(keep);
      }
    }
    if (look.brow && /^Brows$/.test(m.name)) {
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat?.color) {
        m.material = mat.clone();
        (m.material as THREE.MeshStandardMaterial).color.multiply(new THREE.Color(...look.brow));
      }
    }
  });
}
