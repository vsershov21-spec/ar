/**
 * Редакции прототипа из одного репозитория и одной ветки main (docs/EDITIONS.md):
 *   mvp — https://ar.vershov.com      — «вылизанный MVP»: только проверенные функции;
 *   lab — https://ar.vershov.com/lab  — всё новое и экспериментальное (новое сначала живёт здесь);
 *   pilot — https://ar.vershov.com/mvp — срез для пилота с детьми (docs/EDITIONS.md, «Пилот»): урезанный каталог,
 *           2 игры, белый список эффектов, смена кота не чаще раза в 3 мин, аналитика воронки (src/config/pilot.ts).
 *
 * FEATURES — ЕДИНСТВЕННОЕ место, где решается, что входит в MVP. Перевести функцию в MVP = поставить mvp: true
 * (после проверки на iPhone — колонка в docs/EDITIONS.md). Код проверяет функцию в точке входа: feature('games.new').
 *
 * Редакцию задаёт сборка: VITE_EDITION=mvp|lab|pilot (npm run build собирает все три, scripts/build/editions.mjs).
 * Без переменной (npm run dev, vitest, QA-стенд `vite build`) — lab: всё включено, как было до редакций.
 *
 * Параметры адреса: в MVP отладочные и экспериментальные параметры (PARAMS) вырезаются из адреса до старта
 * приложения (guardUrl), поэтому модули, читающие location.search сами (cardTracker, flows…), их просто не видят.
 * «Только lab и /test»: ссылки страницы /test в MVP несут метку ?from=test — с ней такие параметры остаются.
 */

export type Edition = 'mvp' | 'lab' | 'pilot';
export const EDITIONS: readonly Edition[] = ['mvp', 'lab', 'pilot'];

const env = (k: string): string | undefined => (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[k];

export const parseEdition = (v: string | undefined | null): Edition => (v === 'mvp' ? 'mvp' : v === 'pilot' ? 'pilot' : 'lab');
export const EDITION: Edition = parseEdition(env('VITE_EDITION'));
export const IS_LAB = EDITION === 'lab';
export const IS_PILOT = EDITION === 'pilot';

export interface FeatureSpec {
  mvp: boolean;
  lab: boolean;
  /** пилот /mvp (docs/EDITIONS.md, «Пилот») */
  pilot: boolean;
  /** что это и где точка входа */
  note: string;
}

export const FEATURES = {
  // ── ядро MVP (точек проверки нет — без них прототипа нет; в таблице — для полноты решения продакта) ──
  'intro.2screens': { mvp: true, lab: true, pilot: true, note: 'интро: 2 экрана онбординга + разрешения (ui.ts)' },
  'card.sber': { mvp: true, lab: true, pilot: true, note: 'карта Сбера: узнавание по содержимому (tracker/card)' },
  'card.landing': { mvp: true, lab: true, pilot: true, note: 'посадка кота на карту и удержание (cardTracker, stage)' },
  'ui.variantA': { mvp: true, lab: true, pilot: true, note: 'интерфейс, вариант А: три нижние кнопки, каталог, чипы' },
  meet: { mvp: true, lab: true, pilot: true, note: 'знакомство: имя, первая встреча (dialogs intro)' },
  'play.free': { mvp: true, lab: true, pilot: true, note: 'свободная игра и каталог «Что умеет кот» (actionCatalog)' },
  'games.base': { mvp: true, lab: true, pilot: true, note: 'загадка и повторялка (dialogs riddle, echo)' },
  'games.echo': { mvp: true, lab: true, pilot: false, note: 'повторялка (echo): в пилоте выключена — кот говорит записанным голосом ElevenLabs, повтор голоса ребёнка с ним не вяжется (решение продакта 22.11)' },
  'silence.doze': { mvp: true, lab: true, pilot: true, note: 'лестница тишины и дрёма (director)' },
  'cat.switch': { mvp: true, lab: true, pilot: true, note: 'смена кота: «Другой кот», встряска' },
  // ── новое, уже в MVP (точка проверки есть) ──
  home: { mvp: true, lab: true, pilot: true, note: 'мир кота, базовый: пункт «Мой дом» и комната (app.ts withHome / src/home)' },
  awake: { mvp: true, lab: true, pilot: true, note: 'пробуждение-катсцена и салют при находке карты (app.ts → src/awake, fx/salute)' },
  'progress.server': { mvp: true, lab: true, pilot: true, note: 'прогресс на сервере по id устройства (progress/index.ts bootProgress)' },
  'catalog.sheet': { mvp: true, lab: true, pilot: true, note: 'каталог на телефоне — лист снизу: вкладки-группы и сетка 4 в ряд, кот сдвигается над листом (ui.ts openSheet, ui/catalogGroups.ts)' },
  'desktop.panel': { mvp: true, lab: true, pilot: true, note: 'десктоп-панель умений и «Тест» справа (ui/deskPanel.ts); только ?desktop на устройстве без касания и окне ≥ 900 px' },
  // ── пилот /mvp (src/config/pilot.ts — наборы и лимиты; в lab — всё как было, кроме новых функций) ──
  'catalog.signature': { mvp: false, lab: true, pilot: true, note: 'фирменные действия характера в каталоге: Хулиган — скейт, Добряк — какао, Блёстка — зеркальце (scenario/actions.ts skate/cocoa/mirror)' },
  'pilot.catalog': { mvp: false, lab: false, pilot: true, note: 'каталог пилота: 8 общих + 2 фирменных действия на кота, «Другой кот», мир, микрофон; «Фразы» и «Эмоции» скрыты; голосовые команды вырезанных действий → «давай лучше …» (config/pilot.ts)' },
  'pilot.fx': { mvp: false, lab: false, pilot: true, note: 'белый список эффектов на кота (config/pilot.ts PILOT_FX) — director.runFx' },
  'pilot.catPick': { mvp: false, lab: false, pilot: true, note: 'выбор кота листом (26.11): после имени — «Выбери своего кота» (три разных кота), выбранный выскакивает из карты со вспышкой и знакомится сам; «Другой кот» / «давай другого» — лист «Позвать другого кота» вместо наклеек и встряски (scenario/machine.ts withPick, director.offerPick/swapPersona)' },
  'cat.attrs': { mvp: false, lab: true, pilot: true, note: 'фирменный предмет при появлении кота (из карты и после выбора): Хулиган выезжает на скейте, Добряк с какао, Блёстка смотрится в зеркальце (config/pilot.ts APPEAR_ATTR, director.playAttr)' },
  'pilot.switchCooldown': { mvp: false, lab: false, pilot: true, note: 'смена кота не чаще раза в 3 мин, иначе «Чуть позже!» (config/pilot.ts SwitchCooldown, director.switchGate)' },
  'glass.gestures': { mvp: false, lab: true, pilot: true, note: 'стекло пальцем у всех котов: свайп — царапины (claws + claws_glass), долгое нажатие мимо кота — стекло запотевает, рисуем пальцем (steam_draw) — app.ts bindInput' },
  analytics: { mvp: false, lab: true, pilot: true, note: 'воронка: события sendBeacon → POST /api/progress/event (src/analytics, docs/ANALYTICS.md); ?noanalytics — выкл.' },
  'ui.tomLayout': { mvp: false, lab: true, pilot: true, note: 'меню «как у Говорящего Тома»: колонки кнопок у краёв (Ласка слева, Трюки/Образ справа), кот в центре, снизу микрофон, «Мой дом», «Игры», дома — действия комнаты; колонки прячутся к краю (ui/tomMenu.ts, ui/tomLayout.ts, docs/ui/TOM_LAYOUT.md). В MVP — прежний лист' },
  'card.paint': { mvp: false, lab: true, pilot: true, note: 'раскраска карты котом: предложение, лист цветов, рисунок на плоскости карты, память (src/card/paint.ts; app.ts applyEdition — точка входа)' },
  // ── UX пилота 20.11 (запись с iPhone): онбординг, подсказки «нажми сюда», СберKids, туман на стекле ──
  'intro.tour': { mvp: false, lab: true, pilot: false, note: 'онбординг из 4 экранов: кто такой кот, что можно делать, как держать телефон над картой + камера; «Пропустить» (ui.ts OB_TOUR); выкл. — прежние 2 экрана' },
  // ── быстрый вход 22.11 (продакт: «4 экрана — теряем лидов»): заставка в index.html до бандла, один экран, одно нажатие ──
  'intro.quick': { mvp: false, lab: true, pilot: true, note: 'быстрый вход: заставка-загадка прямо в index.html (карта Сбера, глаза из щели, без кота), один экран «Узнать, кто там» — камера+микрофон+звук одним жестом ещё до бандла; юр. плашка + лист «Условия и конфиденциальность», согласие config/consent.ts (notice|checkbox|parent); отказ в камере — экран с подсказкой и «Попробовать ещё раз»; смысл экранов тура — в игре (знакомство, подписи к подсказкам); метка ?src= в аналитику (src/quick, vite.config.ts quickSplash; онбординг UI и intro.tour не показываются)' },
  'intro.search': { mvp: false, lab: true, pilot: true, note: 'детский поиск карты: лапки бегут по краю карты (прогресс посадки), звёздочка наполняется, весёлые подсказки, мягкий отказ чужой карте, звон «нашёл!»; кот выглядывает из плашки (ui/cardSearch.ts; app.ts wireCardSearch — обёртка вызовов оверлея, логика трекера не меняется)' },
  'ui.hints': { mvp: false, lab: true, pilot: true, note: 'подсказки «нажми сюда»: кольцо и палец на 2–3 главных кнопках после онбординга, на ~9 с бездействия, после смены режима; раз за сессию (ui/hints.ts; app.ts — точка входа)' },
  'glass.fogDraw': { mvp: false, lab: true, pilot: true, note: 'кот дышит на стекло («К стеклу», «Подыши», долгое нажатие мимо кота) — туман на весь экран, палец стирает (мягкая кисть, мультитач), ~12 с или «Протереть», кот отвечает репликой (ui/fogBoard.ts; app.ts — точка входа)' },
  'sberkids.offer': { mvp: false, lab: true, pilot: true, note: 'закрываемая карточка «Войти в СберKids» дома и после игры (N действий / минуты), диплинк и веб-фолбэк — config/sberkids.ts (плейсхолдеры TODO), аналитика sberkids_click (ui/kidsOffer.ts; app.ts — точка входа)' },
  // ── онборды в сервисы и «без ласки» (продакт 26.11, docs/scenario/ONBOARDS.md) ──
  'onb.services': { mvp: false, lab: true, pilot: true, note: 'онборды в сервисы: значки «Самокат?» и «СберKids?» в левой колонке меню; кот собирает перекус в корзину Самоката (лист «Отправить маме на оплату») и проводит экскурс по СберKids (копилка, задания, карта → «Войти в СберKids»); src/ui/serviceOnboard.ts, config/onboards.ts; аналитика onb_step' },
  'pilot.noCare': { mvp: false, lab: false, pilot: true, note: 'без «ласки»: в меню и репликах нет «погладь / пощекочи / обними / ласка» — каталог пилота без погладить/почесать/щекотки/обнять (config/pilot.ts), левая колонка «Сюрпризы» (сервисы, угостить, дай лапу), реплики с этими словами отфильтрованы (persona/content.ts noCareLines), обучалка «Погладь меня» выключена' },
  // ── только lab ──
  'games.new': { mvp: false, lab: true, pilot: false, note: 'мини-игры «Угадай рожицу», «Камень-ножницы», «Делай как я» (emo/rps/simon): persona/content.ts убирает их диалоги' },
  'stickers.pack': { mvp: false, lab: true, pilot: false, note: 'новый пак наклеек СберКота и коллекция (fx/stickerPack, fxLayer)' },
  'home.bed': { mvp: false, lab: true, pilot: true, note: 'кровать в спальне «Мира кота»: уложить спать, сон, разбудить, время суток (src/home/bedFlow.ts; homeMode.ts — точка входа)' },
  'home.bedGlb': { mvp: false, lab: true, pilot: false, note: 'GLB-кровать Meshy (public/models/props/bed.glb, только на сервере) вместо процедурной: в пилоте/MVP выкл. — без выравнивания позы и одеяла под неё кот лежал криво, оливковые «блобы» (docs/qa/bed/GLB_1123.md); ?bedglb=1|0 — сравнить (lab и /test), home/room.ts' },
  'anims.new': { mvp: false, lab: true, pilot: false, note: 'новые анимации по мере генерации (точка входа — у агента анимаций)' },
  'anims.meshy': { mvp: false, lab: true, pilot: true, note: 'клипы Meshy Text-to-Motion из /models/anims/meshy/manifest.json поверх anims_v1 (character/meshyClips.ts; GlbCharacter.load — точка входа); ?meshy=0 — без них' },
  'asr.web': { mvp: false, lab: true, pilot: false, note: '?asr=web — распознавание Web Speech (в Chrome звук уходит на серверы Google): только lab, в MVP и пилоте параметр вырезается — всегда офлайн Vosk (voice/asr.ts makeAsr)' },
  'debug.flows': { mvp: false, lab: true, pilot: false, note: 'тестовые флоу и ускорения ?flow=… (src/debug/flows.ts); в MVP — только со страницы /test (?from=test)' },
  'tracker.nocard': { mvp: false, lab: true, pilot: false, note: '?nocard — кот на столе без карты; в MVP — только со страницы /test' },
  'card.anycard': { mvp: false, lab: true, pilot: false, note: '?anycard — кот садится на любой прямоугольник (без проверки «это карта Сбера»)' },
  'card.grabExperimental': { mvp: false, lab: true, pilot: false, note: '?grab=bitmap|frame — экспериментальная подача кадра в воркер (cardTracker); ?grab=main остаётся' },
  'model.custom': { mvp: false, lab: true, pilot: false, note: '?glb=путь — своя модель вместо кота' },
  'face.morph': { mvp: false, lab: true, pilot: false, note: 'мимика морфами: модели models/v2/<кот>_p2.glb (scripts/models/face_rig.py — рот геометрией: полость, клычки, язык; виземы Rhubarb и эмоции морфами), драйвер character/faceMorphs.ts; выкл. — p1, рот шейдером. Сравнение ?face=morph|shader (character/modelVariant.ts faceMode); в пилоте — после просмотра продактом' },
  'model.glitterP3': { mvp: false, lab: false, pilot: false, note: 'Блёстка p3 по умолчанию — пересоздана по развороту продакта 23.11 (Tripo по 4 видам, части; тот же скелет и лицо-накладки p1): models/v2/glitter_p3.glb (character/modelVariant.ts, scripts/models/glitter_p3.py); выкл. — p1. Посмотреть — ?models=p3 (lab; MVP и пилот — со страницы /test); включить по умолчанию — после листа docs/qa/glitter/glitter_p3_sheet.jpg' },
  'model.variants': { mvp: false, lab: true, pilot: false, note: 'по умолчанию везде коты v2 (public/models/v2/<кот>_p1.glb: основы по рефам, фатин, прокси; character/modelVariant.ts); ?models=v1 — прежний вид, ?models=v2h — геометрия v2 для сравнения' },
} as const satisfies Record<string, FeatureSpec>;

export type FeatureId = keyof typeof FEATURES;

export const featureIn = (edition: Edition, id: FeatureId): boolean => !!FEATURES[id]?.[edition];
/** функция включена в этой сборке */
export const feature = (id: FeatureId): boolean => featureIn(EDITION, id);
export const featuresOf = (edition: Edition): FeatureId[] => (Object.keys(FEATURES) as FeatureId[]).filter((id) => featureIn(edition, id));

/** мини-игры функции games.new — их диалоги (content/dialogs.json) и флоу ?flow=emo|rps|simon */
export const NEW_GAMES = ['emo', 'rps', 'simon'] as const;

// ───────────── параметры адреса ─────────────

/**
 * Параметр адреса → функция; в редакции, где функция выключена, параметр вырезается.
 * test: true — оставить, если ссылка пришла со страницы /test (метка from=test или referrer /test).
 * keep — значения, которые не экспериментальные (?grab=main — по-старому).
 */
export const PARAMS: Record<string, { feature: FeatureId; test?: boolean; keep?: string[] }> = {
  flow: { feature: 'debug.flows', test: true },
  dur: { feature: 'debug.flows', test: true },
  rate: { feature: 'debug.flows', test: true },
  zone: { feature: 'debug.flows', test: true }, // ?flow=home&zone=kitchen (src/home)
  cooldown: { feature: 'debug.flows', test: true }, // ?cooldown=10 — кулдаун смены кота пилота, с (config/pilot.ts cooldownMs); lab и /test
  swatch: { feature: 'card.paint' }, // ?flow=paint&swatch=0..2 — сразу раскраска цветом (src/card/paint.ts)
  bed: { feature: 'home.bed' }, // ?flow=home&zone=bedroom&bed=sleep|wake|night|morning (src/home/bedFlow.ts) — кровать в lab и пилоте
  hour: { feature: 'home.bed' },
  bedglb: { feature: 'home.bedGlb', test: true }, // ?bedglb=1|0 — GLB-кровать вкл./выкл. для сравнения (home/room.ts bedGlbWanted); в пилоте/MVP — только со страницы /test // &hour=21 — местный час для кровати (утро, тихий час, вечер)
  nocard: { feature: 'tracker.nocard', test: true },
  desktop: { feature: 'tracker.nocard', test: true }, // ?desktop = ?nocard=off + вращение мышью (src/input/orbit.ts)
  anycard: { feature: 'card.anycard' },
  grab: { feature: 'card.grabExperimental', keep: ['main'] },
  glb: { feature: 'model.custom' },
  models: { feature: 'model.variants', test: true, keep: ['v2'] }, // ?models=v1|v2h|p3|p4|v5 — прежний вид / геометрия v2 (lab и /test); v2 — по умолчанию, character/modelVariant.ts
  face: { feature: 'face.morph', test: true }, // ?face=morph|shader — лицо морфами (p2) или шейдером (p1); lab и /test, character/modelVariant.ts faceMode
  meshy: { feature: 'anims.meshy' }, // ?meshy=0 — lab без клипов Meshy (сравнить с опорами)
  asr: { feature: 'asr.web' }, // ?asr=web — Web Speech (звук уходит в облако): с детьми нельзя, даже со страницы /test
  meshyreport: { feature: 'anims.meshy', test: true }, // ?meshyreport — таблица клипов Meshy во вкладке «Тест» (ui/deskPanel.ts)
};

/**
 * Функция выключена → параметр-выключатель, который уже понимает её код (добавляется в адрес, если его там нет):
 * awake — app.ts не создаёт сцену пробуждения при ?awake=0 (старое появление).
 */
export const OFF_SWITCH: Partial<Record<FeatureId, string>> = { awake: 'awake=0' };

/** метка ссылок страницы /test */
export const TEST_MARK = 'from';

export function fromTestPage(search: string, referrer = ''): boolean {
  if (new URLSearchParams(search).get(TEST_MARK) === 'test') return true;
  try {
    return !!referrer && /^\/((lab|mvp)\/)?test(\/|$)/.test(new URL(referrer).pathname);
  } catch {
    return false;
  }
}

/** чистая функция: какой query останется в редакции (без «?»). Пары без «=» (?debug) сохраняются как есть */
export function filterSearch(search: string, edition: Edition = EDITION, referrer = ''): { search: string; removed: string[]; added: string[] } {
  const test = fromTestPage(search, referrer);
  const removed: string[] = [];
  const parts = search.replace(/^\?/, '').split('&').filter(Boolean);
  const kept = parts.filter((part) => {
    const [rawK, rawV = ''] = part.split('=');
    let k = rawK, v = rawV;
    try {
      k = decodeURIComponent(rawK);
      v = decodeURIComponent(rawV);
    } catch {
      /* как есть */
    }
    const rule = PARAMS[k];
    // новые мини-игры выключены — их флоу тоже (даже со страницы /test)
    const offGame = k === 'flow' && !featureIn(edition, 'games.new') && (NEW_GAMES as readonly string[]).includes(v);
    // раскраски карты нет в редакции — и её флоу тоже
    const offPaint = k === 'flow' && v === 'paint' && !featureIn(edition, 'card.paint');
    const ok = !offGame && !offPaint && (!rule || featureIn(edition, rule.feature) || !!rule.keep?.includes(v) || (!!rule.test && test));
    if (!ok) removed.push(part);
    return ok;
  });
  const added: string[] = [];
  for (const [id, sw] of Object.entries(OFF_SWITCH) as [FeatureId, string][]) {
    const k = sw.split('=')[0];
    if (!featureIn(edition, id) && !kept.some((p) => p.split('=')[0] === k)) added.push(sw);
  }
  return { search: [...kept, ...added].join('&'), removed, added };
}

/** до старта приложения: вырезать из адреса параметры выключенных функций (history.replaceState, без перезагрузки) */
export function guardUrl(): string[] {
  if (typeof location === 'undefined') return [];
  const { search, removed, added } = filterSearch(location.search, EDITION, typeof document !== 'undefined' ? document.referrer : '');
  if (!removed.length && !added.length) return removed;
  try {
    history.replaceState(history.state, '', location.pathname + (search ? '?' + search : '') + location.hash);
  } catch {
    /* ignore */
  }
  if (removed.length) console.info(`редакция ${EDITION}: параметры выключены — ${removed.join(', ')}`);
  if (added.length) console.info(`редакция ${EDITION}: функции выключены — ${added.join(', ')}`);
  return removed;
}

// ───────────── хранилище ─────────────

/**
 * Префикс ключей localStorage и cookie редакции: lab и mvp живут на одном домене, эксперименты не должны портить
 * память кота и id устройства MVP. Задаёт сборка lab (VITE_STORAGE_PREFIX=lab:); в dev/QA — пусто (отдельный origin).
 */
export const STORAGE_PREFIX = env('VITE_STORAGE_PREFIX') ?? '';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'clear'> & { readonly length: number };

/**
 * Пространство ключей для одного объекта хранилища: все модули по-прежнему пишут в localStorage как раньше
 * (memory.ts, каталог, калибровка, device.ts, progress/sync.ts…), а на деле читают/пишут «<prefix><ключ>».
 * key(i)/length/clear видят только свои ключи (progress/sync.ts перебирает ключи). Методы подменяются на прототипе
 * (присвоение localStorage.getItem = … записало бы ключ), и только для target — sessionStorage не трогаем.
 */
export function namespaceStorage(proto: StorageLike, target: object, prefix: string) {
  if (!prefix) return;
  const o = { get: proto.getItem, set: proto.setItem, rm: proto.removeItem, key: proto.key, clear: proto.clear };
  const len = Object.getOwnPropertyDescriptor(proto, 'length');
  const own = (s: StorageLike): string[] => {
    const n = len?.get ? (len.get.call(s) as number) : 0;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const k = o.key.call(s, i);
      if (k !== null && k.startsWith(prefix)) out.push(k);
    }
    return out;
  };
  const p = proto as unknown as Record<string, unknown>;
  p.getItem = function (this: StorageLike, k: string) {
    return o.get.call(this, this === target ? prefix + k : k);
  };
  p.setItem = function (this: StorageLike, k: string, v: string) {
    return o.set.call(this, this === target ? prefix + k : k, v);
  };
  p.removeItem = function (this: StorageLike, k: string) {
    return o.rm.call(this, this === target ? prefix + k : k);
  };
  p.key = function (this: StorageLike, i: number) {
    if (this !== target) return o.key.call(this, i);
    return own(this)[i]?.slice(prefix.length) ?? null;
  };
  p.clear = function (this: StorageLike) {
    if (this !== target) return o.clear.call(this);
    for (const k of own(this)) o.rm.call(this, k);
  };
  if (len?.get) {
    Object.defineProperty(proto, 'length', {
      configurable: true,
      enumerable: len.enumerable,
      get(this: StorageLike) {
        return this === target ? own(this).length : len.get!.call(this);
      },
    });
  }
}

/** main.ts, до всех модулей с localStorage: lab — свои ключи */
export function installStorageNamespace() {
  try {
    if (STORAGE_PREFIX && typeof Storage !== 'undefined' && typeof localStorage !== 'undefined') namespaceStorage(Storage.prototype, localStorage, STORAGE_PREFIX);
  } catch {
    /* приватный режим: localStorage недоступен — и так ничего не сохраняется */
  }
}

// ───────────── метка редакции ─────────────

/** маленькая плашка «LAB» в углу lab-версии (не ловит касания) */
export function showEditionBadge() {
  if (!IS_LAB || typeof document === 'undefined' || env('VITE_EDITION_BADGE') === '0') return;
  const b = document.createElement('div');
  b.className = 'edition-badge';
  b.textContent = 'LAB';
  b.setAttribute('aria-hidden', 'true');
  Object.assign(b.style, {
    position: 'fixed', right: 'calc(env(safe-area-inset-right, 0px) + 6px)', top: 'calc(env(safe-area-inset-top, 0px) + 6px)', zIndex: '2147483000',
    pointerEvents: 'none', font: '800 10px/1 -apple-system, system-ui, sans-serif', letterSpacing: '.08em', color: '#fff',
    background: 'rgba(124, 58, 237, .78)', borderRadius: '6px', padding: '3px 5px', opacity: '.85',
  });
  document.body.appendChild(b);
}
