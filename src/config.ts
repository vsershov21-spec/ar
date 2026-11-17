/**
 * Геометрия «кот на карте». Все длины — в ширинах карты (система MindAR: ширина маркера = 1).
 * Значения по умолчанию подобраны для карты ID-1 (85.60×53.98 мм), см. docs/MECHANICS.md.
 * В ?debug правятся слайдерами и сохраняются в localStorage.
 */
export const CARD_W_MM = 85.6;
export const CARD_H_MM = 53.98;
export const CARD_ASPECT = CARD_W_MM / CARD_H_MM; // 1.586

/**
 * Кот садится только на карту Сбера (знак Сбера на лицевой стороне, любой дизайн). true — и на карты других
 * банков, и на оборот карты (тогда для них нет подсказки «я живу в картах Сбера»). См. docs/CARD_DETECTION.md.
 * ?anycard — старое поведение: любой прямоугольник с пропорциями карты, без проверки содержимого.
 */
export const ACCEPT_OTHER_BANKS = false;

export interface StageConfig {
  /** точка опоры (между лап) относительно центра карты, +X вправо по картинке */
  footX: number;
  /** +Y — к верхнему краю картинки. Чуть ниже центра, чтобы кот «стоял» на карте и не закрывал её целиком */
  footY: number;
  /** подъём над плоскостью карты (+Z — из карты к зрителю) */
  footZ: number;
  /** рост кота в ширинах карты */
  height: number;
  /** доля поворота спрайта-плоскости к камере по наклону (0 — стоит вертикально, 1 — полностью к камере) */
  billboardTilt: number;
  /** поворачивать кота к камере вокруг нормали карты */
  yawFollow: boolean;
  /** какую долю высоты экрана занимает кот «у стекла» */
  glassHeightFrac: number;
  /** сколько держим позу в экранных координатах после потери карты, мс */
  lostHoldMs: number;
  /** скорость ходьбы, ширин карты в секунду */
  walkSpeed: number;
  /** радиус прогулки в режиме мирового трекинга, ширин карты */
  worldWalkRadius: number;
}

export const defaultStage: StageConfig = {
  footX: 0,
  footY: -0.1,
  footZ: 0.0,
  height: 1.1,
  billboardTilt: 0.35,
  yawFollow: true,
  glassHeightFrac: 0.5,
  lostHoldMs: 2500,
  walkSpeed: 0.55,
  worldWalkRadius: 3,
};

const KEY = 'sber-ar-cat:stage';
export function loadStage(): StageConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultStage, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...defaultStage };
}
export function saveStage(s: StageConfig) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Пути ассетов (относительно base). Замена файлов не требует правки кода. */
export const ASSETS = {
  target: 'targets/card.mind',
  cardImage: 'targets/card.png',
  /** 3D-модель: Хулиган из Tripo (скелет Mixamo). Свою модель можно подставить через ?glb=путь */
  glb: 'models/hooligan_v1.glb',
  /** библиотека движений Mixamo (пресеты Tripo) — подмешивается к любой модели с тем же скелетом */
  glbAnims: 'models/anims_v1.glb',
  /** своя 3D-модель у каждого характера (Tripo → retopo → Mixamo-скелет) */
  glbByPersona: { hooligan: 'models/hooligan_v1.glb', kind: 'models/kind_v1.glb', glitter: 'models/glitter_v1.glb' },
  spriteManifest: 'video/sprites/manifest.json',
  sfx: 'sounds/sfx.json',
  voice: 'sounds/voice/manifest.json',
  voskModel: 'models/vosk-ru-small/model.tar.gz',
  eighthWallTarget: 'targets/8thwall/card.json',
  debugBg: 'debug/table.jpg',
  /**
   * «В СберKids»: страница приложения в RuStore (проверена 17.11.2026). Прежняя sberbank.ru/ru/person/kids отдавала 404.
   * Поменять на диплинк/страницу Сбера, когда будет согласованный адрес.
   */
  sberKidsUrl: 'https://www.rustore.ru/catalog/app/ru.sberbank.sberkids',
};
