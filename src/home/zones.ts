/**
 * «Мир кота» без камеры: комнаты (зоны) и правила переходов — чистая логика без DOM и three.js (тесты — tests/home.test.ts).
 *
 * Одна длинная комната, три ракурса: кухня ← гостиная → спальня. Свайп влево/вправо (или стрелки у краёв) — соседняя
 * зона; кот перебегает туда вместе с камерой. В каждой зоне — своё действие-акцент (тамагочи-основа без системы
 * потребностей): гостиная — танец, кухня — угостить (миска) и какао, спальня — уложить спать (свет приглушается).
 */
export type ZoneId = 'kitchen' | 'living' | 'bedroom';

export interface ZoneAction {
  /** ключ чипа: home:<id> */
  id: string;
  label: string;
  /** иконка CAT_ICON / ICON (ui) */
  icon: string;
}

export interface ZoneDef {
  id: ZoneId;
  title: string;
  icon: string;
  /** центр зоны по X в комнате (единицы мира: рост кота ≈ 1,1) */
  x: number;
  /** пол под котом (кровать спальни — отдельно: src/home/bedFlow.ts кладёт кота на матрас) */
  floorY: number;
  /** где стоит кот (по умолчанию — центр зоны x, CAT_Z): спальня — сбоку от кровати */
  spot?: { x: number; z: number };
  /** ракурс зоны: сдвиг камеры по X, отдаление (1 — как в гостиной), подъём */
  cam?: { dx: number; zoom: number; dy: number };
  /** реплика кота при входе в зону (озвученная — звучит, иначе только подпись-иконка) */
  enterEvent: string;
  actions: ZoneAction[];
}

export const ZONES: readonly ZoneDef[] = [
  {
    id: 'kitchen', title: 'Кухня', icon: 'home_kitchen', x: -3.6, floorY: 0, enterEvent: 'home_kitchen',
    actions: [
      { id: 'home:treat', label: 'Угостить', icon: 'fish' },
      { id: 'home:cocoa', label: 'Какао', icon: 'home_mug' },
    ],
  },
  {
    id: 'living', title: 'Гостиная', icon: 'home_sofa', x: 0, floorY: 0, enterEvent: 'home_living',
    actions: [
      { id: 'home:dance', label: 'Потанцуем', icon: 'note' },
      { id: 'home:ball', label: 'Мячик', icon: 'home_ball' },
    ],
  },
  {
    id: 'bedroom', title: 'Спальня', icon: 'home_moon', x: 3.6, floorY: 0, enterEvent: 'home_bedroom',
    // кот стоит на полу слева от кровати (у изножья), лицом к зрителю; камера дальше — кровать видна целиком
    spot: { x: 3.08, z: -0.08 },
    cam: { dx: 0.06, zoom: 1.9, dy: -0.4 },
    actions: [{ id: 'home:sleep', label: 'Уложить спать', icon: 'moon' }],
  },
];

export const DEFAULT_ZONE: ZoneId = 'living';
/** точка кота в зоне (CAT_Z = 0,2 — как в room.ts) */
export const zoneSpot = (z: ZoneDef) => z.spot ?? { x: z.x, z: 0.2 };
export const zoneCam = (z: ZoneDef) => z.cam ?? { dx: 0, zoom: 1, dy: 0 };
export const zoneIndex = (id: string): number => {
  const i = ZONES.findIndex((z) => z.id === id);
  return i < 0 ? ZONES.findIndex((z) => z.id === DEFAULT_ZONE) : i;
};
export const isZoneId = (s: unknown): s is ZoneId => typeof s === 'string' && ZONES.some((z) => z.id === s);

/**
 * Свайп → соседняя зона. Палец ведёт влево — комната «едет» влево, показывается зона правее (как листание страниц).
 * null — дальше некуда (край комнаты) или свайп вертикальный.
 */
export function zoneAfterSwipe(cur: ZoneId, dir: string): ZoneId | null {
  const i = zoneIndex(cur);
  const j = dir === 'left' ? i + 1 : dir === 'right' ? i - 1 : i;
  if (j === i || j < 0 || j >= ZONES.length) return null;
  return ZONES[j].id;
}

/** через сколько потери карты кот предлагает пойти домой */
export const LOST_OFFER_MS = 6000;
/** «лестница тишины»: столько тишины на карте — кот сам зовёт домой (между «предложить занятие» 30 с и мыслью 55 с) */
export const QUIET_OFFER_MS = 40_000;
/** повторно зовёт домой по тишине не раньше чем через */
export const QUIET_OFFER_GAP_MS = 180_000;
/** чипы предложения держатся столько (потом — обычные чипы кота) */
export const OFFER_SHOW_MS = 15_000;

export type OfferWhy = 'lost' | 'quiet' | 'memory';

export interface OfferEnv {
  now: number;
  /** игра идёт (play / free), кот на экране */
  playing: boolean;
  /** уже дома или в переходе */
  home: boolean;
  /** карта сейчас в кадре */
  cardVisible: boolean;
  /** карты нет в кадре с этого момента (мс), -1 — карта видна */
  lostSince: number;
  /** сколько длится тишина (лестница тишины режиссёра) */
  quietMs: number;
  /** мини-игра / диалог / кот говорит / дрёма — не перебиваем */
  busy: boolean;
}

/**
 * Когда кот зовёт домой: карта потеряна дольше LOST_OFFER_MS (раз на одну потерю) или долгая тишина на карте
 * (не чаще QUIET_OFFER_GAP_MS). Чистая логика: снимок → «предложить сейчас?».
 */
export class HomeOfferRule {
  private offeredLossAt = -1;
  private lastQuietOffer = -1e12;
  /** отложенное «кот был дома в прошлый раз» — позвать в первую же паузу */
  pendingMemory = false;

  check(e: OfferEnv): OfferWhy | null {
    if (!e.playing || e.home) return null;
    if (this.pendingMemory && !e.busy) {
      this.pendingMemory = false;
      return 'memory';
    }
    if (!e.cardVisible && e.lostSince >= 0 && e.now - e.lostSince >= LOST_OFFER_MS && this.offeredLossAt !== e.lostSince) {
      this.offeredLossAt = e.lostSince;
      return 'lost';
    }
    if (e.cardVisible && !e.busy && e.quietMs >= QUIET_OFFER_MS && e.now - this.lastQuietOffer >= QUIET_OFFER_GAP_MS) {
      this.lastQuietOffer = e.now;
      return 'quiet';
    }
    return null;
  }
}

/** чипы предложения «пойдём домой» (id → действие HomeMode) */
export function offerChips(why: OfferWhy): ZoneAction[] {
  return [
    { id: 'home:go', label: 'Пойдём!', icon: 'home_house' },
    why === 'lost' ? { id: 'home:find', label: 'Найду карту', icon: 'home_card' } : { id: 'home:later', label: 'Не сейчас', icon: 'no' },
  ];
}
