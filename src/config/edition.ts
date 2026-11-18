/**
 * Редакции прототипа из одного репозитория и одной ветки main (docs/EDITIONS.md):
 *   mvp — https://ar.vershov.com      — «вылизанный MVP»: только проверенные функции;
 *   lab — https://ar.vershov.com/lab  — всё новое и экспериментальное (новое сначала живёт здесь).
 *
 * FEATURES — ЕДИНСТВЕННОЕ место, где решается, что входит в MVP. Перевести функцию в MVP = поставить mvp: true
 * (после проверки на iPhone — колонка в docs/EDITIONS.md). Код проверяет функцию в точке входа: feature('games.new').
 *
 * Редакцию задаёт сборка: VITE_EDITION=mvp|lab (npm run build собирает обе, scripts/build/editions.mjs).
 * Без переменной (npm run dev, vitest, QA-стенд `vite build`) — lab: всё включено, как было до редакций.
 *
 * Параметры адреса: в MVP отладочные и экспериментальные параметры (PARAMS) вырезаются из адреса до старта
 * приложения (guardUrl), поэтому модули, читающие location.search сами (cardTracker, flows…), их просто не видят.
 * «Только lab и /test»: ссылки страницы /test в MVP несут метку ?from=test — с ней такие параметры остаются.
 */

export type Edition = 'mvp' | 'lab';

const env = (k: string): string | undefined => (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[k];

export const parseEdition = (v: string | undefined | null): Edition => (v === 'mvp' ? 'mvp' : 'lab');
export const EDITION: Edition = parseEdition(env('VITE_EDITION'));
export const IS_LAB = EDITION === 'lab';

export interface FeatureSpec {
  mvp: boolean;
  lab: boolean;
  /** что это и где точка входа */
  note: string;
}

export const FEATURES = {
  // ── ядро MVP (точек проверки нет — без них прототипа нет; в таблице — для полноты решения продакта) ──
  'intro.2screens': { mvp: true, lab: true, note: 'интро: 2 экрана онбординга + разрешения (ui.ts)' },
  'card.sber': { mvp: true, lab: true, note: 'карта Сбера: узнавание по содержимому (tracker/card)' },
  'card.landing': { mvp: true, lab: true, note: 'посадка кота на карту и удержание (cardTracker, stage)' },
  'ui.variantA': { mvp: true, lab: true, note: 'интерфейс, вариант А: три нижние кнопки, каталог, чипы' },
  meet: { mvp: true, lab: true, note: 'знакомство: имя, первая встреча (dialogs intro)' },
  'play.free': { mvp: true, lab: true, note: 'свободная игра и каталог «Что умеет кот» (actionCatalog)' },
  'games.base': { mvp: true, lab: true, note: 'загадка и повторялка (dialogs riddle, echo)' },
  'silence.doze': { mvp: true, lab: true, note: 'лестница тишины и дрёма (director)' },
  'cat.switch': { mvp: true, lab: true, note: 'смена кота: «Другой кот», встряска' },
  // ── новое, уже в MVP (точка проверки есть) ──
  home: { mvp: true, lab: true, note: 'мир кота, базовый: пункт «Мой дом» и комната (app.ts withHome / src/home)' },
  awake: { mvp: true, lab: true, note: 'пробуждение-катсцена и салют при находке карты (app.ts → src/awake, fx/salute)' },
  'progress.server': { mvp: true, lab: true, note: 'прогресс на сервере по id устройства (progress/index.ts bootProgress)' },
  // ── только lab ──
  'games.new': { mvp: false, lab: true, note: 'мини-игры «Угадай рожицу», «Камень-ножницы», «Делай как я» (emo/rps/simon): persona/content.ts убирает их диалоги' },
  'stickers.pack': { mvp: false, lab: true, note: 'новый пак наклеек СберКота и коллекция (fx/stickerPack, fxLayer)' },
  'anims.new': { mvp: false, lab: true, note: 'новые анимации по мере генерации (точка входа — у агента анимаций)' },
  'debug.flows': { mvp: false, lab: true, note: 'тестовые флоу и ускорения ?flow=… (src/debug/flows.ts); в MVP — только со страницы /test (?from=test)' },
  'tracker.nocard': { mvp: false, lab: true, note: '?nocard — кот на столе без карты; в MVP — только со страницы /test' },
  'card.anycard': { mvp: false, lab: true, note: '?anycard — кот садится на любой прямоугольник (без проверки «это карта Сбера»)' },
  'card.grabExperimental': { mvp: false, lab: true, note: '?grab=bitmap|frame — экспериментальная подача кадра в воркер (cardTracker); ?grab=main остаётся' },
  'model.custom': { mvp: false, lab: true, note: '?glb=путь — своя модель вместо кота' },
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
  nocard: { feature: 'tracker.nocard', test: true },
  desktop: { feature: 'tracker.nocard', test: true }, // ?desktop = ?nocard=off + вращение мышью (src/input/orbit.ts)
  anycard: { feature: 'card.anycard' },
  grab: { feature: 'card.grabExperimental', keep: ['main'] },
  glb: { feature: 'model.custom' },
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
    return !!referrer && /^\/(lab\/)?test(\/|$)/.test(new URL(referrer).pathname);
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
    const ok = !offGame && (!rule || featureIn(edition, rule.feature) || !!rule.keep?.includes(v) || (!!rule.test && test));
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
