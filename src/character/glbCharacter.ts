/**
 * 3D-режим: GLB + AnimationMixer. Клипы — по id каталога content/animations.json (имена анимаций в GLB
 * должны совпадать с id, регистр не важен); переход — blendInMs из каталога; additive-клипы (уши, хвост)
 * — отдельными действиями поверх. Нет клипа в GLB — процедурная поза-заглушка (procedural.ts).
 * Лицо — блендшейпы с именами из content/face.json (morphTargets) + кости ушей + масштаб зрачков.
 * Скин — показ/скрытие мешей по meta.glb (show/hide — подстроки имён).
 * Модуль грузится лениво (?char=glb): GLTFLoader и Draco не попадают в основной бандл.
 */
import * as THREE from 'three';
import type { Character, ClipName, Emote, PlayOptions, TouchZone } from './types';
import { procFor, type ProcPose } from './procedural';
import type { Persona } from '../persona/types';
import { asset, clamp } from '../core/util';
import { fetchModel, modelUrl } from '../core/modelUrl';
import { makeGltfLoader } from './gltfLoad';
import { type MouthShape, type Viseme } from '../lipsync/visemes';
import { FaceLife } from './faceLife';
import { ClipState } from './clipState';
import { clipDef, CUT_CLIPS, FALLBACK_CLIPS, MESHY_IDS, meshyDef } from './clips';
import { prepareClipsAsync, spliceClip, trimStill, type ClipPrepInfo } from './animPrep';
import { loadMeshyClips, meshyStatus, meshyWanted, skelFrom, type Skel } from './meshyClips';
import { feature } from '../config/edition';
import { AnimBlender } from './animBlend';
import { TailRig, type TailOutput } from './tailRig';
import { PropRig } from './props';
import { ToolIK, type AimRequest } from './toolIK';
import { BodyCollider, CAT_MM, worstPair, type CollidersJson } from './bodyCollide';
import { FootPin } from './footPin';
import { buildFurShells } from './furShell';
import { FaceMixer, EMOTE_FACE, MORPH_TARGETS, facePreset, type FacePreset } from './face';
import { EyeRig } from './eyeRig';
import { FaceWrinkles } from './faceWrinkles';
import { FurTone } from './furTone';
import { collidersUrl, modelsV2 } from './modelVariant';
import { MouthRig } from './mouthRig';
import { personaMeta } from './personaMeta';
import type { AnchorName } from '../fx/core';

const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'LeftShoulder', 'RightShoulder', 'Jaw', 'Tail1', 'Tail2', 'Tail3', 'Tail4', 'LeftEar1', 'RightEar1', 'LeftEye', 'RightEye'];

/** кость → зона касания (ближайшая к точке попадания) */
const BONE_ZONE: Record<string, TouchZone> = {
  Head: 'head', Neck: 'head', LeftHand: 'paw', RightHand: 'paw', LeftForeArm: 'paw', RightForeArm: 'paw', LeftFoot: 'paw', RightFoot: 'paw',
  Spine: 'belly', Spine1: 'body', Spine2: 'body', Hips: 'body', Tail1: 'tail', Tail2: 'tail', Tail3: 'tail', Tail4: 'tail',
};

/**
 * Точка касания на коте — по «капсулам» вокруг костей (отрезок кость → дочерняя кость, радиус в долях роста кота),
 * а не лучом по скинованной сетке: тот пересчитывает каждую вершину по костям — 15–20 мс на телефоне (QA-стенд, хаос:
 * в среднем 69 мс на касание при CPU ×4, кадры по 1 с при 10 тапах в секунду; docs/qa/BUGS.md № 26). Капсулы — ~40
 * отрезков, микросекунды. Зона, как и раньше, — ближайшая кость к точке. ?hit=mesh — старый путь (сравнение).
 */
const CAPSULE_R: [RegExp, number][] = [
  [/Head/, 0.17], [/Neck/, 0.1], [/Spine|Hips/, 0.16], [/Shoulder/, 0.07], [/ForeArm|Hand/, 0.06], [/Arm/, 0.065],
  [/UpLeg/, 0.08], [/Leg/, 0.07], [/Foot|Toe/, 0.06], [/Tail/, 0.05], [/Ear/, 0.06],
];
/** клипы «через голову»: держим голову и лапы над полом (groundClamp) */
const ACRO = /flip|tumble|cartwheel|somersault/;
/** без удержания лап: лёжа, сон, кровать, прыжки с места, ходьба/бег */
const NO_PIN = /sleep|bed|lie_|walk|run|jump|dive|appear|fall|sit_|stand_up|wake_up|turn_step|skate/;
/** клип Meshy отвергается при загрузке, если рука/нога после коррекции BodyCollider глубже этого (мм на карте) */
export const MESHY_PEN_MAX_MM = 5;
/** кости и их «радиус» (рост модели ≈ 1) */
const GROUND_BONES: [string, number][] = [['Head', 0.15], ['Neck', 0.08], ['LeftHand', 0.04], ['RightHand', 0.04], ['Spine2', 0.12]];
const FINGER = /Thumb|Index|Middle|Ring|Pinky|_End$|Eye|Jaw|Tongue/;
const HIT_MESH = typeof location !== 'undefined' && /[?&]hit=mesh\b/.test(location.search);
const HP_A = new THREE.Vector3();
const HP_B = new THREE.Vector3();
const HP_P = new THREE.Vector3();


/**
 * Пресеты Tripo (скелет Mixamo) → id каталога content/animations.json. Клип из GLB с таким именем
 * регистрируется под нашим id (если под этим id ещё ничего нет). Первый подходящий выигрывает.
 */
export const TRIPO_ALIAS: Record<string, string[]> = {
  idle: ['idle_breathe'],
  standing_relax: ['sit_idle'],
  look_around: ['idle_look_around'],
  stretch: ['idle_stretch'],
  warm_up: ['idle_hooligan_skate'],
  walk: ['walk'],
  run: ['run'],
  jump: ['jump', 'celebrate'],
  jump_down: ['appear_jump_in'],
  flip: ['flip'],
  turn: ['turn_left', 'turn_right'],
  sit: ['sit_down'],
  fall: ['fall_off_card', 'tumble'],
  dive: ['dive_out'],
  greet_01: ['wave'],
  greet_02: ['point_button'],
  wave_goodbye_01: ['wave_goodbye'],
  laugh_01: ['laugh', 'sticker_react'],
  laugh_02: ['talk_excited'],
  cheer: ['celebrate', 'proud'],
  clap: ['clap'],
  scared_01: ['surprised', 'wake_startle'],
  frightened: ['flinch', 'cover_ears'],
  cry: ['cry'],
  depressed: ['sad'],
  hug: ['comfort', 'idle_kind_hug_self', 'hug_screen'],
  fold_arms: ['offended'],
  swagger: ['idle_hooligan_headphones'],
  complain_01: ['talk_casual'],
  agree: ['listen'],
  bow: ['bow'],
  heart_pose: ['idle_glitter_mirror'],
  sing_01: ['sing'],
  dance_01: ['dance_hooligan'],
  dance_02: ['dance_kind'],
  dance_03: ['dance_glitter', 'idle_glitter_twirl'],
  dance_04: ['dance_04'],
  dance_05: ['dance_05'],
  dance_06: ['dance_06'],
  play_mobile_game: ['card'],
  wait: ['think'],
  frustrated_01: ['dizzy'],
  defeat_02: ['tumble'],
  scratch: ['shy'],
  afraid: ['shy'],
  'knock on glass': ['knock_glass'],
};

/** постоянный минимум весов лица по характеру (поверх пресета; хмурость его гасит) */
const PERSONA_FACE: Record<string, Record<string, number>> = {
  glitter: { blush: 0.32, smile: 0.12 },
};
/** то же для моделей v2 (?models=v2): румянец Блёстки слабее — под персиковый тон faceWrinkles v2 */
const PERSONA_FACE_V2: Record<string, Record<string, number>> = {
  glitter: { blush: 0.14, smile: 0.12 },
};

let ENV: THREE.Texture | null = null;
/** маленькая equirect-карта «комната»: светлый верх, тёплый горизонт, тёмный низ (стол); PMREM делает рендерер */
function softEnv() {
  if (ENV) return ENV;
  const W = 64, H = 32;
  const d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = 1 - y / (H - 1); // 1 — зенит
    for (let x = 0; x < W; x++) {
      const win = Math.exp(-(((x / W - 0.3) * 6) ** 2) - (((v - 0.7) * 5) ** 2)); // мягкое «окно»
      const r = v > 0.5 ? 200 + 55 * (v - 0.5) * 2 : 120 + 80 * v * 2;
      const g = v > 0.5 ? 200 + 50 * (v - 0.5) * 2 : 100 + 90 * v * 2;
      const b = v > 0.5 ? 205 + 50 * (v - 0.5) * 2 : 85 + 100 * v * 2;
      const i = (y * W + x) * 4;
      d[i] = Math.min(255, r + 60 * win);
      d[i + 1] = Math.min(255, g + 60 * win);
      d[i + 2] = Math.min(255, b + 60 * win);
      d[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, W, H);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  ENV = t;
  return t;
}

const TAIL = ['Tail1', 'Tail2', 'Tail3', 'Tail4'];
const TAIL_EARS = [...TAIL, 'LeftEar1', 'RightEar1'];

/** освободить геометрию, материалы и текстуры поддерева (общие — ENV — пропускаем; повторный dispose безвреден) */
export function disposeObject(root: THREE.Object3D) {
  const mats = new Set<THREE.Material>();
  const geos = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    const list = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const x of list) mats.add(x);
    for (const k of ['origMat', 'tintMat']) if (m.userData?.[k]) mats.add(m.userData[k] as THREE.Material);
    if ((m as unknown as THREE.SkinnedMesh).isSkinnedMesh) (m as unknown as THREE.SkinnedMesh).skeleton?.dispose();
  });
  const texs = new Set<THREE.Texture>();
  for (const mat of mats) {
    for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture && v !== ENV) texs.add(v as THREE.Texture);
    mat.dispose();
  }
  for (const t of texs) t.dispose();
  for (const g of geos) g.dispose();
}

export class GlbCharacter implements Character {
  readonly kind = 'glb' as const;
  readonly object = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private inner = new THREE.Group();
  mixer: THREE.AnimationMixer | null = null;
  readonly actions = new Map<string, THREE.AnimationAction>();
  private aliased = new Set<string>();
  readonly tailRig = new TailRig();
  private props: PropRig | null = null;
  collider: BodyCollider | null = null;
  /** последний результат хвоста/ушей (для debug и тестов) */
  tailOut: TailOutput | null = null;
  private personaId = 'kind';
  private hipsPrev: { yaw: number; y: number } | null = null;
  private tq = new THREE.Quaternion();
  private tq2 = new THREE.Quaternion();
  private tv = new THREE.Vector3();
  private bones = new Map<string, THREE.Bone>();
  private rest = new Map<string, THREE.Quaternion>();
  readonly clips = new ClipState();
  /** переходы, темп и слой покоя (animBlend.ts); подготовка клипов — animPrep.ts */
  anim: AnimBlender | null = null;
  animInfo = new Map<THREE.AnimationClip, ClipPrepInfo>();
  readonly faceMix = new FaceMixer();
  private playing = '';
  private mouth = 0;
  private look: THREE.Vector3 | null = null;
  private hitBox = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1, 0.4), new THREE.MeshBasicMaterial({ visible: false }));
  /** габарит с запасом (уши, лапы в стороны) — для движения пальца при поглаживании (hitCoarse) */
  private coarseBox = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.15, 0.6), new THREE.MeshBasicMaterial({ visible: false }));
  private faces = new Map<string, THREE.Object3D>();
  /** капсулы костей для касаний (hitProxy) */
  private capsules: { b: THREE.Object3D; c: THREE.Object3D | null; r: number }[] = [];
  private morphMeshes: THREE.Mesh[] = [];
  private time = 0;
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private visemeW: Record<string, number> = {};
  /** живость: микромимика в покое, движения головы во время речи, дыхание (faceLife.ts) */
  readonly life = new FaceLife();
  /** 3D-глаза и веки (модели после scripts/models/face_detail.py); null — старая модель с нарисованными глазами */
  eyes: EyeRig | null = null;
  /** складки лица в шейдере тела (по весам эмоции) */
  wrinkles: FaceWrinkles | null = null;
  /** тон меха под референс (светлый серо-лавандовый, furTone.ts) */
  readonly furTone = new FurTone();
  /** рот-накладка с шейдером (модели после face_detail v3); null — старая полость Mouth */
  mouthRig: MouthRig | null = null;
  /** эмоция поверх пресета реплики (setEmotion) */
  private emo: { p: FacePreset; w: number; t: number; dur: number; from: number; inS?: number } | null = null;
  /** слой эмоции: сглаженные веса пресета (смена эмоции — перетекание весов, а не провал в нейтраль) и его сила */
  private emoL: { w: Record<string, number>; pupils: number; ears: number; s: number } = { w: {}, pupils: 1, ears: 0, s: 0 };
  /** итоговые веса лица за кадр (для глаз, debug и тестов) */
  readonly W: Record<string, number> = {};
  private gazeV = new THREE.Vector3();
  private lookYaw = 0;
  private lookPitch = 0;

  constructor(private url = 'models/character.glb', private animsUrl?: string) {
    this.object.name = 'character-glb';
    this.hitBox.position.y = 0.5;
    this.coarseBox.position.y = 0.55;
    this.object.add(this.inner, this.hitBox, this.coarseBox);
  }

  get currentClip(): ClipName {
    return this.clips.requested;
  }

  async load() {
    // meshopt + KTX2 (сжатие при сборке, src/character/gltfLoad.ts); Draco — только если GLB реально сжат им
    const loader = makeGltfLoader();
    const url = modelUrl(this.url);
    const raw = await fetchModel(this.url);
    if (new TextDecoder().decode(new Uint8Array(raw, 0, Math.min(raw.byteLength, 4096))).includes('KHR_draco_mesh_compression')) {
      const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
      loader.setDRACOLoader(new DRACOLoader());
    }
    const gltf = await loader.parseAsync(raw, asset(url).replace(/[^/]*$/, ''));
    const model = gltf.scene;
    this.model = model;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const size = box.getSize(new THREE.Vector3());
    const k = 1 / (size.y || 1);
    model.scale.setScalar(k);
    model.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
    this.inner.add(model);
    // поза покоя/привязки скелета — до миксера (перенос внешних клипов Meshy, meshyClips.ts)
    this.skel = skelFrom(model);
    // мех по силуэту (оболочки) — если стадия body_detail положила в GLB меш BD_FurShell
    buildFurShells(model);

    this.capsules = [];
    model.traverse((o) => {
      const name = o.name.replace(/^mixamorig:?/, '');
      if ((o as THREE.Bone).isBone && !FINGER.test(name)) {
        const r = CAPSULE_R.find(([re]) => re.test(name))?.[1] ?? 0.05;
        // голова: до макушки (HeadTop_End), остальные — до первой дочерней кости
        const c = o.children.find((x) => (x as THREE.Bone).isBone && (!FINGER.test(x.name) || /HeadTop/.test(x.name))) ?? null;
        this.capsules.push({ b: o, c, r });
      }
      if ((o as THREE.Bone).isBone && BONES.includes(name)) {
        this.bones.set(name, o as THREE.Bone);
        this.rest.set(name, o.quaternion.clone());
      }
      if (/emotion_(happy|angry|usual)/i.test(o.name)) this.faces.set(o.name.match(/emotion_(\w+?)_/i)![1].toLowerCase(), o);
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.frustumCulled = false;
        const mat = m.material as THREE.MeshStandardMaterial;
        // мягкое окружение: без него металл (золото Блёстки) чернеет, а мех и ткань выглядят плоско
        if (mat?.isMeshStandardMaterial) {
          mat.envMap = softEnv();
          mat.envMapIntensity = 0.4;
          // карточки меха щёк: край по alphaToCoverage (MSAA) — мягкий контур вместо «пилы» alphaTest
          if (/^Tuft/.test(mat.name)) mat.alphaToCoverage = true;
        }
        if (m.morphTargetDictionary) this.morphMeshes.push(m);
      }
    });

    let anims = gltf.animations;
    // общая библиотека движений (тот же скелет Mixamo): Добряк и Блёстка берут клипы Хулигана
    if (this.animsUrl && this.animsUrl !== this.url) {
      try {
        const libUrl = modelUrl(this.animsUrl);
        const lib = await makeGltfLoader().parseAsync(await fetchModel(this.animsUrl), asset(libUrl).replace(/[^/]*$/, ''));
        anims = [...anims, ...lib.animations];
      } catch (e) {
        console.warn('[glb] библиотека анимаций не загрузилась', e);
      }
    }
    if (anims.length) {
      this.mixer = new THREE.AnimationMixer(model);
      // перепривязка, сглаживание, обрезка, швы петель, высота корня, темп (animPrep.ts)
      // ?anim=raw — как было (для сравнения в debug)
      const raw = typeof location !== 'undefined' && /[?&]anim=raw/.test(location.search);
      // монтаж по каталогу (cut): короткие реакции из длинных T2M-клипов — до подготовки, из сырого клипа
      const cuts = raw ? [] : GlbCharacter.cutClips(anims);
      anims = [...anims, ...cuts.map((c) => c.clip)];
      if (!raw) {
        this.animInfo = await prepareClipsAsync(model, this.inner, anims, {
          isLoop: (n) => GlbCharacter.aliasIds(n).some((id) => clipDef(id)?.loop),
          keepSpeed: (n) => /dance|run|jump|flip|dive|fall|tumble|celebrate|cheer/.test(n),
        });
      }
      for (const { clip, speed } of cuts) {
        const inf = this.animInfo.get(clip);
        if (inf && speed) inf.timeScale *= speed;
      }
      for (const clip of anims) this.addClip(clip);
      this.addFallbacks();
      if (!raw) this.anim = new AnimBlender(model, (a) => this.animInfo.get(a.getClip()));
      // одноразовые клипы играют до конца движения, а не по ориентиру каталога
      this.actions.forEach((a, id) => this.clips.realDuration.set(id, this.anim?.realDuration(a) ?? a.getClip().duration));
    }
    // клипы Meshy (lab): лениво, после того как кот уже стоит; ?meshy=0 — без них
    if (this.mixer && meshyWanted(feature('anims.meshy'))) void this.loadMeshy();
    this.setFaceObj('usual');
    this.furTone.attach(model);
    this.mouthRig = MouthRig.find(model);
    this.eyes = EyeRig.find(model);
    this.wrinkles = FaceWrinkles.attach(model);
    if (this.eyes) console.info('[glb] 3D-глаза');
    this.collider = new BodyCollider(this.object, (n) => this.bones.get(n) ?? model.getObjectByName('mixamorig' + n) ?? undefined);
    if (this.personaId) this.collider.setPersona(this.personaId);
    // ?collide=legacy — коррекция рук как до 18.11 (сравнение на стенде), ?collide=0 — без коррекции
    const cm = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('collide') : null;
    this.collider.legacy = cm === 'legacy';
    this.collider.enabled = cm !== '0';
    console.info('[glb] объёмы тела', this.collider.build(model));
    // прокси одежды от модельщика (public/models/v2/<кот>_colliders.json, docs/animations/COLLISION.md): есть — главнее
    const restSnap: [THREE.Object3D, THREE.Quaternion, THREE.Vector3][] = [];
    model.traverse((o) => restSnap.push([o, o.quaternion.clone(), o.position.clone()]));
    void this.loadColliders(model, restSnap);
    const propLoader = makeGltfLoader();
    this.props = new PropRig(
      async (u) => (await propLoader.loadAsync(asset(modelUrl(u)))).scene,
      (n) => this.bones.get(n) ?? model.getObjectByName('mixamorig' + n) ?? undefined,
      this.inner,
    );
  }

  setPersona(p: Persona) {
    this.personaId = p.id;
    this.collider?.setPersona(p.id);
    this.furTone.setPersona(p.id);
    const meta = personaMeta(p.id);
    this.clips.setIdles(meta.idles, p.id);
    if (!this.model) return;
    const glb = { ...meta.glb, ...(p.glb ?? {}) };
    const show = glb.show ?? [];
    const hide = glb.hide ?? [];
    this.model.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh && !o.children.some((c) => (c as THREE.Mesh).isMesh)) return;
      if (/emotion/i.test(o.name)) return;
      if (hide.some((h) => o.name.includes(h))) o.visible = false;
      else if (show.length && show.some((s) => o.name.includes(s))) o.visible = true;
    });
    const tint = glb.tint ?? {};
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const key = Object.keys(tint).find((k) => m.name.includes(k) || m.parent?.name.includes(k));
      const mat = m.material as THREE.MeshStandardMaterial;
      if (!mat || !('color' in mat)) return;
      if (!m.userData.origMat) m.userData.origMat = mat;
      // прошлая перекраска — освободить (раньше клон копился на каждую смену характера)
      const prevTint = m.userData.tintMat as THREE.Material | undefined;
      if (key) {
        const c = (m.userData.origMat as THREE.MeshStandardMaterial).clone();
        c.color = new THREE.Color(tint[key]);
        m.material = c;
        m.userData.tintMat = c;
      } else {
        m.material = m.userData.origMat;
        m.userData.tintMat = undefined;
      }
      if (prevTint && prevTint !== m.material) prevTint.dispose();
    });
  }

  /** клип под своим именем + под нашими id по TRIPO_ALIAS; корневое смещение по X/Z убираем — место кота держит сцена */
  private addClip(clip: THREE.AnimationClip) {
    if (!this.mixer) return;
    clip.tracks = clip.tracks.filter((t) => !/hips\.position$/i.test(t.name) || this.keepY(t));
    const key = clip.name.toLowerCase().replace(/^.*\|/, '');
    const action = this.mixer.clipAction(clip);
    // своё имя (уже id каталога) важнее псевдонима; псевдонимы заполняют только пустые места
    this.actions.set(key, action);
    this.aliased.delete(key);
    for (const n of TRIPO_ALIAS[key] ?? []) {
      if (!this.actions.has(n) || this.aliased.has(n)) {
        if (this.aliased.has(n)) continue; // первый псевдоним выигрывает
        this.actions.set(n, action);
        this.aliased.add(n);
      }
    }
  }

  /**
   * Клипы каталога, которых ещё нет в библиотеке (поле fallback в content/animations.json: кровать, сон в кровати…):
   * играет клип-опора, а путь корня и поправки поз добавляет сцена (poseTweak). Своё имя в GLB важнее — пришёл
   * настоящий клип, опора не нужна.
   */
  private addFallbacks() {
    for (const d of FALLBACK_CLIPS) {
      if (this.actions.has(d.id) && !this.aliased.has(d.id)) continue;
      const base = this.actions.get(d.fallback!);
      if (!base) continue;
      this.actions.set(d.id, base);
      this.aliased.add(d.id);
      this.procedural.add(d.id);
    }
  }
  /** скелет модели в позе привязки (для переноса внешних клипов) */
  skel: Skel | null = null;
  /** внешние клипы (Meshy), уже зарегистрированные под id ТЗ — для вкладки «Тест» */
  readonly externalClips: { id: string; dur: number; src: string }[] = [];

  private async loadMeshy() {
    // состояния клипов — стенду реакций и meshy-check (scripts/qa): window.__meshyStatus
    (globalThis as { __meshyStatus?: typeof meshyStatus }).__meshyStatus = meshyStatus;
    try {
      await loadMeshyClips(this, {
        fetchJson: async (u) => {
          const r = await fetch(asset(u));
          return r.ok ? r.json() : null;
        },
        loadGlb: async (u) => {
          const r = await fetch(asset(u));
          if (!r.ok) throw new Error(`${u}: ${r.status}`);
          return makeGltfLoader().parseAsync(await r.arrayBuffer(), asset(u).replace(/[^/]*$/, ''));
        },
        log: (m) => console.info(m),
        expected: MESHY_IDS,
        // петля — по правилу каталога (meshy.loop из спеки), иначе манифест
        loopOf: (id, l) => clipDef(id)?.meshy?.loop ?? l,
      });
    } catch (e) {
      console.warn('[meshy] клипы не загрузились', e);
    }
  }

  /**
   * Внешний клип (уже на наших костях) под id каталога: animPrep (обрезка, швы, высота корня, темп) и регистрация.
   * Своё имя важнее всего: заменяет и клип-опору (fallback), и псевдоним, и старый клип anims_v1 с тем же id.
   */
  async addExternalClip(id: string, clip: THREE.AnimationClip, loop: boolean, src: string): Promise<string | void> {
    if (!this.mixer || !this.model) return 'кот ещё не загружен';
    clip.name = id;
    // Meshy генерирует не меньше 2 с: у коротких реакций срезаем «стоит и чуть плывёт» в конце
    const trimmed = loop ? 0 : trimStill(clip);
    const info = await prepareClipsAsync(this.model, this.inner, [clip], {
      isLoop: () => loop,
      keepSpeed: (n) => /dance|run|jump|flip|dive|fall|tumble|celebrate|cheer|skate/.test(n),
    });
    if (!this.mixer || !this.model) return; // кота сменили, пока готовили
    // руки/ноги сквозь тело и одежду даже после коррекции — клип не берём, играет прежний
    const pen = this.penetration(clip);
    this.meshyPen.set(id, +pen.mm.toFixed(1));
    if (pen.mm > MESHY_PEN_MAX_MM) return `проникновение ${pen.mm.toFixed(1)} мм (${pen.pair}) после коррекции`;
    info.forEach((v, k) => this.animInfo.set(k, v));
    const action = this.mixer.clipAction(clip);
    this.actions.set(id, action);
    this.aliased.delete(id);
    // клип пришёл — опора не нужна: сцена снимает свои поправки позы (bedFlow: крен, ноги; procedural.has(id) = false)
    this.procedural.delete(id);
    this.meshy.add(id);
    const dur = this.anim?.realDuration(action) ?? clip.duration;
    this.clips.realDuration.set(id, dur);
    // монтаж cut и опора fallback — для старого клипа; петля и переходы — из правила meshy
    const def = clipDef(id);
    if (def) this.clips.defOverride.set(id, meshyDef({ ...def, meshy: def.meshy ? { ...def.meshy, loop } : undefined, loop }, dur));
    const i = this.externalClips.findIndex((e) => e.id === id);
    const rec = { id, dur: +clip.duration.toFixed(2), src: trimmed > 0 ? `${src}, −${trimmed.toFixed(1)} с хвоста` : src };
    if (i >= 0) this.externalClips[i] = rec;
    else this.externalClips.push(rec);
  }

  /** клипы Meshy, которые сейчас играют (своё имя) */
  readonly meshy = new Set<string>();
  /** остаток проникновения после коррекции по клипам Meshy, мм (проверка при загрузке) */
  readonly meshyPen = new Map<string, number>();

  /**
   * Откуда клип id у этого кота: 'meshy' — клип Meshy; 'own' — свой клип библиотеки (или монтаж); 'alias' — пресет Tripo
   * под чужим именем; 'fallback' — опора (procedural); null — нет (процедурная заглушка).
   */
  clipSource(id: string): 'meshy' | 'own' | 'alias' | 'fallback' | null {
    if (this.meshy.has(id)) return 'meshy';
    if (!this.actions.has(id)) return null;
    if (this.procedural.has(id)) return 'fallback';
    return this.aliased.has(id) ? 'alias' : 'own';
  }

  /**
   * Проникновение рук/ног после коррекции BodyCollider на 8 кадрах клипа (временный миксер, поза модели потом
   * восстанавливается): глубина самой глубокой пары, мм на карте (рост кота ≈ CAT_MM).
   */
  penetration(clip: THREE.AnimationClip, frames = 8): { mm: number; pair: string } {
    const col = this.collider, model = this.model;
    if (!col || !model || !col.proxies.length) return { mm: 0, pair: '' };
    const saved: [THREE.Object3D, THREE.Quaternion, THREE.Vector3][] = [];
    model.traverse((o) => saved.push([o, o.quaternion.clone(), o.position.clone()]));
    const mx = new THREE.AnimationMixer(model);
    const a = mx.clipAction(clip);
    a.play();
    let worst = { pair: '', depth: 0 };
    try {
      for (let i = 0; i < frames; i++) {
        mx.setTime((clip.duration * (i + 0.5)) / frames);
        col.reset();
        col.apply(0);
        const w = worstPair(col.measurePairs());
        if (w.depth > worst.depth) worst = w;
      }
    } finally {
      a.stop();
      mx.uncacheRoot(model);
      for (const [o, q, p] of saved) {
        o.quaternion.copy(q);
        o.position.copy(p);
      }
      col.reset();
      model.updateMatrixWorld(true);
    }
    return { mm: worst.depth * CAT_MM, pair: worst.pair };
  }

  /** коллайдеры модельщика рядом с моделью v2 (models/v2/hooligan_v2.glb → models/v2/hooligan_colliders.json); у v1 их нет */
  private async loadColliders(model: THREE.Object3D, restSnap: [THREE.Object3D, THREE.Quaternion, THREE.Vector3][]) {
    // только у моделей v2 (геометрия и прокси связаны); v1 — прокси из меша (как на 841b373), без запроса
    const u = collidersUrl(this.url);
    if (!u) return;
    try {
      const r = await fetch(asset(u));
      if (!r.ok) return;
      const j = (await r.json()) as CollidersJson;
      if (this.model !== model || !this.collider) return;
      // прокси строятся в позе покоя: снимок текущей позы → покой → build → назад
      const saved: [THREE.Object3D, THREE.Quaternion, THREE.Vector3][] = [];
      model.traverse((o) => saved.push([o, o.quaternion.clone(), o.position.clone()]));
      for (const [o, q, p] of restSnap) {
        o.quaternion.copy(q);
        o.position.copy(p);
      }
      const names = this.collider.build(model, j);
      for (const [o, q, p] of saved) {
        o.quaternion.copy(q);
        o.position.copy(p);
      }
      console.info('[glb] объёмы тела из', u, names);
    } catch {
      /* нет файла — прокси из меша */
    }
  }

  /** id клипов, которые сейчас играют опорой (настоящего клипа в GLB нет) — для сцены и debug */
  readonly procedural = new Set<string>();
  /**
   * Поправки поверх клипа после миксера (сцена: кот в кровати ворочается, потягивается): rot(кость, ось модели, угол).
   * Оси — модели (up/side/fwd), а не локальные оси костей: у моделей Tripo они повёрнуты.
   */
  poseTweak: ((rot: (bone: string, axis: 'up' | 'side' | 'fwd', a: number) => void, dt: number) => void) | null = null;

  /** мировая позиция кости (имя Mixamo без префикса): сцена кладёт кота на матрас и укрывает одеялом по силуэту */
  boneWorld(name: string, out: THREE.Vector3): boolean {
    const b = this.bones.get(name);
    if (!b) return false;
    b.getWorldPosition(out);
    return true;
  }

  /**
   * Клипы с монтажом (content/animations.json, cut): исходник — cut.src, иначе клип с именем id, иначе первый пресет
   * Tripo, который по TRIPO_ALIAS играет этот id. Новый клип называется id и регистрируется последним — своё имя
   * важнее и исходника, и псевдонима.
   */
  static cutClips(anims: THREE.AnimationClip[]): { clip: THREE.AnimationClip; speed?: number }[] {
    const byKey = new Map<string, THREE.AnimationClip>();
    for (const c of anims) byKey.set(c.name.toLowerCase().replace(/^.*\|/, ''), c);
    const out: { clip: THREE.AnimationClip; speed?: number }[] = [];
    for (const d of CUT_CLIPS) {
      const cut = d.cut!;
      const alias = Object.keys(TRIPO_ALIAS).find((k) => TRIPO_ALIAS[k].includes(d.id) && byKey.has(k));
      const src = byKey.get(cut.src ?? '') ?? byKey.get(d.id) ?? (alias ? byKey.get(alias) : undefined);
      if (!src) continue;
      out.push({ clip: spliceClip(src, cut.keep, d.id), speed: cut.speed });
    }
    return out;
  }

  /** имя клипа GLB → id каталога (своё имя + TRIPO_ALIAS) */
  static aliasIds(name: string) {
    const key = name.toLowerCase().replace(/^.*\|/, '');
    return [key, ...(TRIPO_ALIAS[key] ?? [])];
  }

  /** у Hips оставляем только вертикаль (прыжки, приседания) */
  private keepY(t: THREE.KeyframeTrack) {
    const v = t.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
    return true;
  }

  play(clip: ClipName, opts: PlayOptions = {}) {
    this.clips.play(clip, opts);
  }

  /** синхронизация действий миксера с ClipState (кроссфейд blendInMs) */
  private syncMixer() {
    if (!this.mixer) return;
    const cs = this.clips;
    const id = cs.cur.id;
    if (this.anim) {
      this.anim.sync(cs, this.actions, (this.object.userData.moveSpeed as number) ?? 0);
      this.playing = id;
    } else if (id !== this.playing) {
      const next = this.actions.get(id);
      const prev = this.actions.get(this.playing);
      const fade = cs.cur.def.blendInMs / 1000;
      if (next) {
        next.reset();
        next.setLoop(cs.cur.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        next.clampWhenFinished = !cs.cur.loop;
        next.fadeIn(fade).play();
      }
      prev?.fadeOut(fade);
      this.playing = id;
    }
    for (const a of cs.additive) {
      const act = this.actions.get(a.id);
      if (act && !act.isRunning()) {
        act.blendMode = THREE.AdditiveAnimationBlendMode;
        act.reset().setLoop(a.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity).fadeIn(a.def.blendInMs / 1000).play();
      }
    }
  }

  private setFaceObj(name: string) {
    if (!this.faces.size) return;
    const target = this.faces.has(name) ? name : 'usual';
    this.faces.forEach((o, k) => (o.visible = k === target));
  }

  /** то же, что face() — так зовёт director (эмоция реплики → пресет) */
  setFace(preset: string) {
    this.face(preset);
  }

  face(preset: string, ms = 0) {
    this.faceMix.set(preset, ms);
    // старая модель-заглушка: три объекта-эмоции
    this.setFaceObj(/happy|smile|excited|proud|celebr/.test(preset) ? 'happy' : /annoyed|offended/.test(preset) ? 'angry' : 'usual');
  }

  /**
   * Эмоция поверх текущего пресета лица: пресет content/face.json (happy, laugh, smug, wink_l, wink_r, surprised, pout,
   * shy, sad, sleepy, dizzy, sleep…), сила 0..1, длительность мс (0 — пока не сменят). Плавно входит и уходит.
   */
  setEmotion(name: string, weight = 1, durationMs = 1500, inS = 0.18) {
    const p = facePreset(name);
    if (!p) return;
    // сила стартует с текущей (смена эмоции на ходу — без провала), веса перетекают в слое emoL
    this.emo = { p, w: clamp(weight, 0, 1), t: 0, dur: durationMs / 1000, from: this.emoL.s, inS };
  }

  clearEmotion() {
    if (this.emo) this.emo.dur = Math.min(this.emo.dur || Infinity, this.emo.t + 0.5); // гаснет за 0.5 с
  }

  /** текущая эмоция (id) или null */
  get emotion() {
    return this.emo?.p.id ?? null;
  }

  /** «стук в стекло»: в 3D лапа не тянется, но глаза быстро глядят на точку тапа */
  holdProp(id: string | null, tint: string | null = null) {
    this.props?.hold(id, tint);
  }

  /** раскраска карты: присед, наклон, лапа с инструментом к точке (toolIK.ts) */
  readonly toolIK = new ToolIK();
  aimTool(r: AimRequest | null) {
    this.toolIK.set(r);
  }
  toolRay() {
    return this.props?.tip() ?? null;
  }

  reach(target: { dx: number; dy: number } | null) {
    if (target) this.eyes?.glanceAt(target.dx, target.dy);
  }

  /**
   * Палец коснулся кота (до распознавания жеста, app.ts touch_down): глаза на палец и лёгкое «ой?» бровями за 1–2 кадра —
   * отклик виден сразу, а реакция жеста (тап, глажка) приходит следом и плавно перекрывает эмоцию.
   */
  notice(target: { dx: number; dy: number }) {
    this.eyes?.glanceAt(target.dx, target.dy);
    if (this.emo && this.emoL.s > 0.4) return; // уже есть эмоция (мурчит, смеётся) — не сбиваем
    this.setEmotion('surprised', 0.55, 450, 0.08);
  }

  emote(e: Emote, ms = 1200) {
    if (e === 'blink') return this.faceMix.blink();
    this.face(EMOTE_FACE[e] ?? 'neutral', ms);
  }

  lookAt(world: THREE.Vector3 | null) {
    this.look = world ? world.clone() : null;
  }

  /**
   * Липсинк → блендшейпы. Берём не только доминирующую визему, а сглаженные параметры рта (open/wide/round —
   * уже смешаны с коартикуляцией): рот открывается плавно и заметно, «О»/«У» — из округлости.
   */
  setMouth(v: Viseme, w: number, shape: MouthShape) {
    this.mouth = clamp(shape.open, 0, 1);
    this.visemeW = FaceLife.mouthWeights(v, w, shape);
  }

  private applyPose(pose: ProcPose, w: number, root: THREE.Vector3, rootRot: THREE.Vector3, s: { v: number }) {
    for (const [name, [x, y, z]] of Object.entries(pose.bones)) {
      const b = this.bones.get(name);
      if (!b) continue;
      b.quaternion.multiply(this.q.setFromEuler(this.e.set(x * w, y * w, z * w)));
    }
    const r = pose.root;
    root.x += (r.x ?? 0) * w;
    root.y += (r.y ?? 0) * w;
    root.z += (r.z ?? 0) * w;
    rootRot.x += (r.rx ?? 0) * w;
    rootRot.y += (r.ry ?? 0) * w;
    rootRot.z += (r.rz ?? 0) * w;
    s.v *= 1 + ((r.s ?? 1) - 1) * w;
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    const cs = this.clips;
    cs.update(dt);
    this.syncMixer();
    const f = this.faceMix.update(dt);

    if (this.mixer && this.actions.has(cs.cur.id)) {
      this.mixer.update(dt);
      this.anim?.post(dt, cs, this.model ?? this.object);
      this.groundClamp(dt, cs.cur.id);
      this.pinFeet(dt, cs.cur.id);
    } else {
      this.lift = 0;
      this.mixer?.update(dt);
      this.rest.forEach((q, n) => this.bones.get(n)!.quaternion.copy(q));
      const root = new THREE.Vector3();
      const rot = new THREE.Vector3();
      const sc = { v: 1 };
      if (cs.prev && cs.blend < 1) this.applyPose(procFor(cs.prev.id)(ClipState.k(cs.prev), cs.prev.t), 1 - cs.blend, root, rot, sc);
      this.applyPose(procFor(cs.cur.id)(ClipState.k(cs.cur), cs.cur.t), cs.prev ? cs.blend : 1, root, rot, sc);
      if (!cs.idleMode) this.applyPose(procFor('idle')(0, this.time), 0.4, root, rot, sc);
      const head = this.bones.get('Head');
      if (head && this.mouth > 0 && !this.morphMeshes.length) head.quaternion.multiply(this.q.setFromEuler(this.e.set(-0.12 * this.mouth, 0, 0)));
      this.inner.position.copy(root);
      this.inner.rotation.set(rot.x, rot.y, rot.z);
      this.inner.scale.setScalar(sc.v);
      if (rot.x) this.inner.position.y += 0.5 - 0.5 * Math.cos(rot.x);
    }

    // лицо: пресет + микромимика → эмоция поверх → моргание → липсинк (mouth_* поверх, рот при речи виден всегда)
    const emo = this.emo;
    let ee = 0;
    const L = this.emoL;
    if (emo) {
      emo.t += dt;
      // вход ~0.3 с и выход ~0.5 с по smoothstep: эмоция «наплывает», а не щёлкает
      const kin = clamp(emo.t / (emo.inS ?? 0.3), 0, 1), kout = emo.dur ? clamp((emo.dur - emo.t) / 0.5, 0, 1) : 1;
      const sin = kin * kin * (3 - 2 * kin);
      ee = (emo.from + (emo.w - emo.from) * sin) * kout * kout * (3 - 2 * kout);
      // веса слоя тянутся к пресету (~0.12 с): из смеха в удивление лицо перетекает, а не перескакивает
      const a = 1 - Math.exp(-dt / 0.12);
      const ew = emo.p.weights;
      for (const k in L.w) L.w[k] += ((ew[k] ?? 0) - L.w[k]) * a;
      for (const k in ew) if (!(k in L.w)) L.w[k] = L.s > 0.02 ? ew[k] * a : ew[k];
      L.pupils += (emo.p.pupils - L.pupils) * (L.s > 0.02 ? a : 1);
      L.ears += (emo.p.ears - L.ears) * (L.s > 0.02 ? a : 1);
      if (emo.dur && emo.t >= emo.dur) this.emo = null;
    }
    L.s = ee;
    const facePresetId = emo && ee > 0.4 ? emo.p.id : this.faceMix.preset;
    const lw = this.life.update(dt, { persona: this.personaId, preset: facePresetId, open: this.mouth, idle: cs.idleMode });
    const W = this.W;
    for (const k in W) W[k] = 0;
    for (const k in f.weights) W[k] = f.weights[k];
    for (const k in lw) W[k] = Math.max(W[k] ?? 0, lw[k]);
    let pupils = f.pupils, ears = f.ears;
    if (ee > 0) {
      const ew = L.w;
      for (const k in W) W[k] += ((ew[k] ?? 0) - W[k]) * ee;
      for (const k in ew) if (!(k in W)) W[k] = ew[k] * ee;
      pupils += (L.pupils - pupils) * ee;
      ears += (L.ears - ears) * ee;
    }
    const noBlink = emo && ee > 0.4 ? !!emo.p.noBlink : false;
    if (!noBlink) {
      W.blink_L = Math.max(W.blink_L ?? 0, f.blink);
      W.blink_R = Math.max(W.blink_R ?? 0, f.blink);
    }
    // характер в покое (референс): у Блёстки всегда чуть розовые щёчки и мягкая полуулыбка
    const base = (modelsV2() ? PERSONA_FACE_V2 : PERSONA_FACE)[this.personaId];
    if (base) for (const k in base) W[k] = Math.max(W[k] ?? 0, base[k] * (1 - (W.frown ?? 0)));
    // складки и мягкость: щёки поднимаются при улыбке, морщинка у носа при хмурых бровях
    W.cheek_up = Math.max(W.cheek_up ?? 0, 0.5 * (W.smile ?? 0), 0.3 * (W.smirk ?? 0));
    W.nose_wrinkle = Math.max(W.nose_wrinkle ?? 0, 0.35 * (W.brow_down ?? 0));
    for (const k in this.visemeW) W[k] = Math.max((W[k] ?? 0) * 0.5, this.visemeW[k]);
    this.wrinkles?.update(W);
    this.mouthRig?.update(W);
    for (const m of this.morphMeshes) {
      const d = m.morphTargetDictionary!;
      const inf = m.morphTargetInfluences!;
      for (const key of MORPH_TARGETS) {
        const i = d[key];
        if (i === undefined) continue;
        // старые веки-накладки не нужны, когда есть 3D-глаза
        inf[i] = W[key] ?? 0;
      }
    }
    this.applyTailEars(dt, ears, facePresetId);
    this.bones.get('LeftEye')?.scale.setScalar(pupils);
    this.bones.get('RightEye')?.scale.setScalar(pupils);

    const head = this.bones.get('Head');
    if (head) {
      // взгляд на камеру + движения головы во время речи — вокруг осей персонажа в мире
      // (локальные оси кости Head у моделей Tripo повёрнуты: локальный X смотрит вперёд, поворот по нему — крен)
      const local = this.object.worldToLocal(this.tLocal.copy(this.look ?? camera.getWorldPosition(this.tLocal)));
      // поворот головы к камере/точке — сглаженно (≈ 0,12 с, не быстрее 3 рад/с): дрожь позы карты и смена цели
      // (палец → камера) не дёргают голову
      const yawT = clamp(Math.atan2(local.x, local.z), -0.6, 0.6);
      const pitchT = clamp(Math.atan2(local.y - 0.85, Math.hypot(local.x, local.z)), -0.4, 0.4);
      const lk = 1 - Math.exp(-dt / 0.12), vmax = 3 * dt;
      this.lookYaw += clamp((yawT - this.lookYaw) * lk, -vmax, vmax);
      this.lookPitch += clamp((pitchT - this.lookPitch) * lk, -vmax, vmax);
      const yaw = this.lookYaw, pitch = this.lookPitch;
      const { up, side, fwd } = this.modelAxes();
      const h = this.life.head;
      const neck = this.bones.get('Neck');
      // часть движения — шеей: голова не «отламывается»
      if (neck) {
        this.rotWorld(neck, up, yaw * 0.25 + h.yaw * 0.4);
        this.rotWorld(neck, side, -(pitch * 0.15 + h.pitch * 0.4));
      }
      this.rotWorld(head, up, yaw * 0.4 + h.yaw * 0.6);
      this.rotWorld(head, side, -(pitch * 0.35 + h.pitch * 0.6));
      this.rotWorld(head, fwd, h.roll);
      const chest = this.bones.get('Spine2');
      if (chest) this.rotWorld(chest, side, h.breath);
    }
    // поправки сцены поверх клипа (кровать: кот ворочается, потягивается лёжа) — в осях модели
    if (this.poseTweak) {
      const ax = this.modelAxes();
      this.poseTweak((n, a, ang) => {
        const b = this.bones.get(n);
        if (b) this.rotWorld(b, ax[a], ang);
      }, dt);
    }
    // руки и голени — из тела и одежды (bodyCollide.ts): после клипа, взгляда головы и поправок сцены (кровать) —
    // иначе поправка позы (потягивание лёжа) или поворот головы вносили руку обратно в тело
    this.collider?.apply(dt);
    // раскраска карты: присед, наклон, лапа с баллончиком / кистью к точке на карте — после клипа и тела; реквизит — следом
    const ik = this.toolIK;
    if (ik.mode !== 'off' || ik.weight > 0.002 || ik.crouch > 0.002) ik.apply(dt, { bones: this.bones, object: this.object, inner: this.inner, axes: this.modelAxes(), rot: (b, a, ang) => this.rotWorld(b, a, ang) });
    this.props?.aim(ik.aimW > 0.01 ? ik.aimPoint : null, ik.aimW);
    this.props?.update(this.clips.cur.id);
    // глаза — после головы: взгляд на зрителя (или на точку lookAt), веки, зрачки
    if (this.eyes) {
      const tgt = this.look ?? camera.getWorldPosition(this.gazeV);
      const gz = (emo && ee > 0.4 ? emo.p.gaze : facePreset(this.faceMix.preset)?.gaze) ?? null;
      this.eyes.update(dt, { weights: W, pupils, target: tgt, idle: cs.idleMode && this.life.talk < 0.1, bias: gz });
    }
  }

  /**
   * Акробатика (сальто, кувырок) из GLB: корень клипа поднимается мало — вверх ногами голова уходила под пол
   * (дома пол виден, запись 18.11). Пока идёт такой клип, поднимаем кота так, чтобы голова и лапы были не ниже пола
   * (центр кости минус её радиус), опускаем плавно.
   */
  private lift = 0;
  private groundClamp(dt: number, id: string) {
    let want = 0;
    if (ACRO.test(id)) {
      let minY = Infinity;
      for (const [n, r] of GROUND_BONES) {
        const b = this.bones.get(n);
        if (!b) continue;
        const y = this.object.worldToLocal(b.getWorldPosition(this.tLocal)).y - this.lift - r;
        if (y < minY) minY = y;
      }
      if (Number.isFinite(minY) && minY < 0) want = Math.min(0.6, -minY);
    }
    // вверх — сразу (иначе голова успевает «нырнуть»), вниз — за ~0,15 с
    this.lift = want > this.lift ? want : this.lift + (want - this.lift) * Math.min(1, dt / 0.15);
    if (this.lift < 1e-4) this.lift = 0;
    this.inner.position.y = this.lift;
  }

  /** опорные лапы не едут (footPin.ts): сдвиг тела по горизонтали; выкл. — ходьба, акробатика, лёжа, кровать */
  readonly footPin = new FootPin();
  private footBuf: [number, number, number][] = [[0, 0, 0], [0, 0, 0]];
  private pinFeet(dt: number, id: string) {
    const L = this.bones.get('LeftFoot'), R = this.bones.get('RightFoot');
    if (!L || !R) return;
    const moving = ((this.object.userData.moveSpeed as number) ?? 0) > 0;
    const enabled = !moving && !this.poseTweak && !ACRO.test(id) && !NO_PIN.test(id) && this.lift < 0.01;
    // положения стоп без прошлого сдвига
    this.inner.position.x = this.inner.position.z = 0;
    this.inner.updateMatrixWorld(true);
    [L, R].forEach((b, i) => {
      const p = this.object.worldToLocal(b.getWorldPosition(this.tLocal));
      this.footBuf[i][0] = p.x;
      this.footBuf[i][1] = p.y;
      this.footBuf[i][2] = p.z;
    });
    const off = this.footPin.update(dt, this.footBuf, enabled);
    this.inner.position.x = off.x;
    this.inner.position.z = off.z;
    this.inner.updateMatrixWorld(true);
  }

  /** хвост и уши: сброс к покою и вторичная анимация TailRig поверх тела */
  private applyTailEars(dt: number, faceEars: number, facePresetId = this.faceMix.preset) {
    for (const n of TAIL_EARS) {
      const b = this.bones.get(n);
      const r = this.rest.get(n);
      if (b && r) b.quaternion.copy(r);
    }
    if (!this.bones.has('Tail1') && !this.bones.has('LeftEar1')) return;
    // скорость таза в пространстве персонажа (дрожание трекинга не трогает хвост)
    let yawVel = 0;
    let upVel = 0;
    const hips = this.bones.get('Hips');
    if (hips && dt > 0) {
      hips.updateWorldMatrix(true, false);
      const objQ = this.object.getWorldQuaternion(this.tq2).invert();
      const hq = hips.getWorldQuaternion(this.tq).premultiply(objQ);
      const fwd = this.tv.set(0, 0, 1).applyQuaternion(hq);
      const yaw = Math.atan2(fwd.x, fwd.z);
      const y = this.object.worldToLocal(hips.getWorldPosition(this.tLocal)).y;
      if (this.hipsPrev) {
        let dy = yaw - this.hipsPrev.yaw;
        if (dy > Math.PI) dy -= 2 * Math.PI;
        if (dy < -Math.PI) dy += 2 * Math.PI;
        yawVel = clamp(dy / dt, -12, 12);
        upVel = clamp((y - this.hipsPrev.y) / dt, -4, 4);
      }
      this.hipsPrev = { yaw, y };
    }
    const out = this.tailRig.update(dt, {
      clip: this.clips.cur.id,
      face: facePresetId,
      faceEars: faceEars,
      additive: this.clips.additive.map((a) => a.id),
      persona: this.personaId,
      speaking: this.mouth,
      hipsYawVel: yawVel,
      hipsUpVel: upVel,
    });
    this.tailOut = out;
    const { up, side, fwd } = this.modelAxes();
    for (let i = 0; i < 4; i++) {
      const b = this.bones.get(TAIL[i]);
      if (!b) continue;
      this.rotWorld(b, up, out.tail[i][0]);
      this.rotWorld(b, side, out.tail[i][1]);
    }
    const eL = this.bones.get('LeftEar1');
    if (eL) {
      this.rotWorld(eL, side, out.earL[0]);
      this.rotWorld(eL, fwd, -out.earL[1]);
    }
    const eR = this.bones.get('RightEar1');
    if (eR) {
      this.rotWorld(eR, side, out.earR[0]);
      this.rotWorld(eR, fwd, out.earR[1]);
    }
  }

  /** оси модели в мире (вверх, вбок, вперёд) — во временных векторах: без new Vector3 на каждый кадр */
  private modelAxes() {
    const mq = (this.model ?? this.object).getWorldQuaternion(this.tq2);
    return { up: this.axUp.set(0, 1, 0).applyQuaternion(mq), side: this.axSide.set(1, 0, 0).applyQuaternion(mq), fwd: this.axFwd.set(0, 0, 1).applyQuaternion(mq) };
  }
  private axUp = new THREE.Vector3();
  private axSide = new THREE.Vector3();
  private axFwd = new THREE.Vector3();
  private tLocal = new THREE.Vector3();
  private rq = new THREE.Quaternion();
  private rq2 = new THREE.Quaternion();

  /** поворот кости вокруг оси в мировых координатах (ось — уже в мире) */
  private rotWorld(b: THREE.Object3D, axis: THREE.Vector3, angle: number) {
    if (!angle || !b.parent) return;
    b.parent.updateWorldMatrix(true, false);
    const pq = b.parent.getWorldQuaternion(this.tq);
    const d = this.rq.setFromAxisAngle(axis, angle);
    const local = this.rq2.copy(pq).invert().multiply(d).multiply(pq);
    b.quaternion.premultiply(local);
    b.updateMatrixWorld(false);
  }

  hitTest(ray: THREE.Raycaster) {
    return ray.intersectObject(this.hitBox, false).length > 0;
  }

  hitCoarse(ray: THREE.Raycaster) {
    return ray.intersectObject(this.coarseBox, false).length > 0;
  }

  /** первая по лучу капсула кости: точка на луче против неё (или null — мимо капсул) */
  private hitProxy(ray: THREE.Raycaster): THREE.Vector3 | null {
    const s = this.object.getWorldScale(this.tv).x;
    let best = Infinity, out: THREE.Vector3 | null = null;
    for (const k of this.capsules) {
      k.b.getWorldPosition(HP_A);
      if (k.c) k.c.getWorldPosition(HP_B);
      else HP_B.copy(HP_A);
      const d2 = ray.ray.distanceSqToSegment(HP_A, HP_B, HP_P);
      const R = k.r * s;
      if (d2 > R * R) continue;
      const t = HP_P.distanceTo(ray.ray.origin) - Math.sqrt(R * R - d2);
      if (t < best) {
        best = t;
        out = (out ?? new THREE.Vector3()).copy(HP_P);
      }
    }
    return out;
  }

  /** зона: ближайшая к точке попадания кость (щека — голова сбоку от морды) */
  hitZone(ray: THREE.Raycaster): TouchZone | null {
    return this.zoneAtPoint(HIT_MESH || !this.capsules.length ? this.meshPoint(ray) : this.hitProxy(ray) ?? ray.intersectObject(this.hitBox, false)[0]?.point ?? null);
  }

  /** старый путь — луч по скинованной сетке (дорого; ?hit=mesh и сверка в QA-стенде) */
  hitZoneMesh(ray: THREE.Raycaster): TouchZone | null {
    return this.zoneAtPoint(this.meshPoint(ray));
  }

  private meshPoint(ray: THREE.Raycaster): THREE.Vector3 | null {
    const hit = this.model ? ray.intersectObject(this.model, true)[0] : undefined;
    return hit?.point ?? ray.intersectObject(this.hitBox, false)[0]?.point ?? null;
  }

  private zoneAtPoint(p: THREE.Vector3 | null): TouchZone | null {
    if (!p) return null;
    let best: TouchZone = 'body', bd = Infinity;
    const wp = new THREE.Vector3();
    for (const [name, zone] of Object.entries(BONE_ZONE)) {
      const b = this.bones.get(name);
      if (!b) continue;
      b.getWorldPosition(wp);
      const d = wp.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = zone;
      }
    }
    if (best === 'head') {
      // щека: сбоку от морды и не выше глаз (в координатах кота: рост 1)
      const po = this.object.worldToLocal(p.clone());
      const ho = this.object.worldToLocal(this.bones.get('Head')!.getWorldPosition(new THREE.Vector3()));
      if (Math.abs(po.x - ho.x) > 0.12 && po.y < ho.y + 0.12) best = 'cheek';
    }
    return best;
  }

  anchorLocal(name: AnchorName): THREE.Vector3 | null {
    const bone = ({ head: 'Head', mouth: 'Jaw', earL: 'LeftEar1', earR: 'RightEar1', pawR: 'RightHand', body: 'Spine', feet: 'Hips' } as Record<AnchorName, string>)[name];
    const b = this.bones.get(bone) ?? (name === 'mouth' ? this.bones.get('Head') : undefined);
    if (!b) return null;
    const p = b.getWorldPosition(new THREE.Vector3());
    const l = this.object.worldToLocal(p);
    if (name === 'feet') l.y = 0.02;
    if (name === 'head' && bone === 'Head') l.y += 0.12;
    // без кости челюсти рот — спереди головы: кость Head стоит у основания черепа (рост модели ≈ 1)
    if (name === 'mouth' && !this.bones.has('Jaw')) {
      const k = this.inner.scale.x || 1;
      l.y += 0.075 * k;
      l.z += 0.15 * k;
    }
    return l;
  }

  posterImage() {
    return null;
  }

  /**
   * Смена характера грузит другую модель: освобождаем всё своё на GPU — геометрию, материалы (и перекраски), текстуры,
   * кэш миксера. Раньше освобождалась только геометрия: каждая смена образа оставляла в памяти GPU текстуры
   * прошлой модели (KTX2 2–3 карты по 1–2К) и программы шейдеров. Общая карта окружения (softEnv) не трогается.
   */
  dispose() {
    this.mixer?.stopAllAction();
    if (this.mixer && this.model) this.mixer.uncacheRoot(this.model);
    this.mixer = null;
    this.actions.clear();
    disposeObject(this.object);

    this.model?.removeFromParent();
    this.model = null;
  }
}
