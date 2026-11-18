/**
 * Интерфейс: стартовый экран, поиск карты, пузырь реплик, нижний док из трёх кнопок (звук · микрофон «скажи коту» ·
 * лапка «что умеет кот»), над ним — до двух чипов-предложений от кота (scenario/suggest.ts), каталог «Что умеет кот»
 * на месте чипов, меню долгого нажатия («Пересадить на другую карту»), листы «Как тебя зовут?» и «Каким мне быть?»,
 * кнопки СберKids / «Сдёрнуть наклейки», тосты, экран ошибки.
 * Стили и дизайн-токены — styles.css; правила — docs/UI_AUDIT.md, упрощённый экран — docs/UI_AUDIT.md, «Упрощённый экран».
 */
import { asset } from '../core/util';
import { TriedStore, moreSection, type CatalogItem, type CatalogSection, type SectionId } from './actionCatalog';
import type { Chip } from '../scenario/suggest';
import { CAT_ICON } from './catalogIcons';
import { collection as stickerCollection } from '../fx/stickerPack';
import { feature } from '../config/edition';

export interface UiHandlers {
  onWake(): void;
  onMicDown(): void;
  onMicUp(): void;
  /** «слушаю всегда»: короткое нажатие на микрофон — «я говорю»: слушаем фразу до конца (а не до отпускания) */
  onMicTap?(): void;
  /** чип-предложение кота (действие или фраза) */
  onSuggest?(chip: Chip): void;
  onChip(text: string): void;
  onName(name: string): void;
  onSkipName(): void;
  onShakeButton(): void;
  onKids(): void;
  onMute(m: boolean): void;
  /** «слушаю всегда» ↔ «по кнопке» */
  onMicMode(m: 'auto' | 'ptt'): void;
  /** «Пересадить кота» на карту, которая сейчас в кадре (меню долгого нажатия, раздел «Ещё» каталога) */
  onReanchor?(): void;
  /** кнопка панели действий (погладить, угостить, танец…) */
  onAction?(id: string): void;
  /** каталог «Что умеет кот»: разделы для текущего характера (только работающие действия) */
  catalog?(): { who: string; sections: CatalogSection[] } | null;
  /** выбор в каталоге (лист уже закрыт — ребёнок видит реакцию) */
  onCatalogPick?(item: CatalogItem): void;
}

/** вариант в листе выбора характера */
export interface ChoiceOption {
  id: string;
  title: string;
  /** цвета характера: primary / secondary / accent (content/src/<id>.meta.json) */
  palette?: { primary?: string; secondary?: string; accent?: string };
}

/** экранный прямоугольник кота (px): пузырь не закрывает ему голову */
export interface CatRect {
  /** макушка */
  top: number;
  /** лапы */
  bottom: number;
  /** центр головы */
  cx: number;
  headY: number;
  /** полуширина кота */
  half: number;
}

/** подсказки-фразы (старый формат: чип = сказанная фраза) — только для сборок без onAction */
export const CHIPS = ['Привет!', 'Сделай сальто', 'Загадай загадку', 'Танцуй', 'Повторяй за мной', 'Давай другого'];

/**
 * Быстрые действия (раньше — длинная панель из 10 кнопок; теперь на экране их нет: кот предлагает по два — suggest.ts,
 * всё остальное — в каталоге «Что умеет кот»). Список держим: каждое из них обязано быть в каталоге (тест).
 */
export const ACTION_BAR: { id: string; label: string; icon: string }[] = [
  { id: 'pet', label: 'Погладить', icon: 'hand' },
  { id: 'tickle', label: 'Щекотка', icon: 'feather' },
  { id: 'treat', label: 'Угостить', icon: 'fish' },
  { id: 'dance', label: 'Танец', icon: 'note' },
  { id: 'flip', label: 'Сальто', icon: 'flip' },
  { id: 'trick', label: 'Фокус', icon: 'star' },
  { id: 'riddle', label: 'Загадка', icon: 'quest' },
  { id: 'sticker', label: 'Наклейка', icon: 'sticker' },
  { id: 'echo', label: 'Повторяй', icon: 'parrot' },
  { id: 'other', label: 'Другой кот', icon: 'swap' },
];

/** превью, подпись и цвет характера в листе выбора (цвета — из палитры персонажа, если она есть) */
const PERSONA_UI: Record<string, { img: string; tagline: string; color: string; soft: string }> = {
  hooligan: { img: 'video/sprites/hooligan/turn_front.webp', tagline: 'Дерзкий и смешной', color: '#7cc61d', soft: '#e9f8cf' },
  kind: { img: 'video/sprites/kind/turn_front.webp', tagline: 'Тёплый и заботливый', color: '#f08a4b', soft: '#fde9da' },
  glitter: { img: 'video/sprites/glitter/pose_wave.webp', tagline: 'Яркая и с блёстками', color: '#9a7be8', soft: '#efe8fd' },
};

/** «ушки» над микрофоном, пока кот слушает (раньше — эффект listen_ears на полноэкранном холсте) */
const EAR = '<svg viewBox="0 0 100 112" aria-hidden="true"><polygon points="0,110 50,1 100,110" fill="#A9B6CC" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><polygon points="25,108 50,35 75,108" fill="#F3A6B6"/></svg>';
const EARS = `<i class="mic-ears" aria-hidden="true"><b class="l">${EAR}</b><b class="r">${EAR}</b></i>`;

/** положение кота для пузыря с точностью ~6 px: пузырь перекладывается, только когда оно меняется */
export function bubbleKey(r: { top: number; bottom: number; cx: number; headY: number; half: number } | null): string {
  if (!r) return '-';
  const q = (v: number) => Math.round(v / 6);
  return `${q(r.top)}|${q(r.bottom)}|${q(r.cx)}|${q(r.headY)}|${q(r.half)}`;
}

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" stroke="none"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  hints: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16v10H10l-4.5 4v-4H4z"/><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" stroke-width="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
  cam: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h3.5l2-2.5h7l2 2.5H21v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.8 4.5 5.6v6.1c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V5.6z" fill="currentColor" stroke="none"/><path d="m8.6 12 2.4 2.4 4.6-4.8" stroke="#fff" stroke-width="2.4"/></svg>',
  kid: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="9" r="4.2"/><path d="M4.5 21c.6-4 3.6-6.3 7.5-6.3s6.9 2.3 7.5 6.3z"/></svg>',
  adult: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="7.5" r="4"/><path d="M3.5 22c.7-5 4.1-8 8.5-8s7.8 3 8.5 8z"/></svg>',
  repin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M12 2.5v7M8.8 6.3 12 9.5l3.2-3.2"/></svg>',
  paw: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="12" cy="16" rx="5" ry="4.2"/><ellipse cx="5.5" cy="10.5" rx="2.1" ry="2.6"/><ellipse cx="9.5" cy="6.5" rx="2.1" ry="2.7"/><ellipse cx="14.5" cy="6.5" rx="2.1" ry="2.7"/><ellipse cx="18.5" cy="10.5" rx="2.1" ry="2.6"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V10h.5V4a1.5 1.5 0 0 1 3 0v6h.5V5.5a1.5 1.5 0 0 1 3 0V13c0 4.4-2.6 8-7 8-3 0-4.6-1.6-6.2-4.3L3.4 14a1.5 1.5 0 0 1 2.4-1.8L8 14.5z"/></svg>',
  feather: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 4c-7 0-13 5-13 12v4" /><path d="M20 4c0 7-5 12-13 12" fill="currentColor" fill-opacity=".25"/><path d="M11 12h5M9 15h4"/></svg>',
  fish: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 12c2.5-4 6-6 9.5-6 3.6 0 6.3 2.4 7.5 6-1.2 3.6-3.9 6-7.5 6C9 18 5.5 16 3 12z"/><path d="M19 12l3-4v8z"/><circle cx="8" cy="11" r="1.3" fill="#fff"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 17.5V5l11-2v12.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><ellipse cx="6.5" cy="17.5" rx="3" ry="2.4"/><ellipse cx="17.5" cy="15.5" rx="3" ry="2.4"/></svg>',
  flip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.6 6 6.4.6-4.9 4.3 1.5 6.4L12 16.5l-5.6 3.3 1.5-6.4L3 9.1l6.4-.6z"/></svg>',
  quest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 8.5a3.5 3.5 0 1 1 5.2 3c-1 .6-1.7 1.3-1.7 2.5v.5"/><path d="M12 19h.01" stroke-width="3.2"/></svg>',
  sticker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v9l-7 7H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="currentColor" fill-opacity=".2"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/><path d="M9 9h.01M15 9h.01" stroke-width="3"/></svg>',
  parrot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h11v8H9l-4 3.5v-3.5H4z" fill="currentColor" fill-opacity=".2"/><path d="M18 9.5c1.5 1 1.5 4 0 5M20.5 7c3 2.5 3 7.5 0 10"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></svg>',
  finger: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M18 30V9a3.5 3.5 0 0 1 7 0v13l1-.2V16a3.3 3.3 0 0 1 6.5 0v7l.8.1v-4a3.2 3.2 0 0 1 6.3 0V30c0 8-5 14-12.5 14-5 0-8-2.6-10.8-7.4L11.6 31a3.2 3.2 0 0 1 5-4z" fill="#fff" stroke="#1f2a2e" stroke-width="2.2" stroke-linejoin="round"/></svg>',
  camoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5h3l2-2.5h8l2 2.5h3v11H3z"/><circle cx="12" cy="13" r="3.5"/><path d="M3 3l18 18"/></svg>',
};

export class UI {
  readonly root: HTMLDivElement;
  private start: HTMLDivElement;
  private scan: HTMLDivElement;
  private bubble: HTMLDivElement;
  private chips: HTMLDivElement;
  private mic: HTMLButtonElement;
  private micHint: HTMLDivElement;
  private micSlot!: HTMLElement;
  private micDownAt = 0;
  private micModeNow: 'auto' | 'ptt' = 'auto';
  private dock: HTMLDivElement;
  private pawBtn: HTMLButtonElement;
  private kids: HTMLButtonElement;
  private shakeBtn: HTMLButtonElement;
  private namebox: HTMLDivElement;
  private choice: HTMLDivElement;
  private bubbleTimer = 0;
  private hintTimer = 0;
  private muted = false;
  private listening = false;
  private chipsByScenario = false;
  /** ключ текущих чипов (перерисовка — только при смене) */
  private sugKey = '';
  private sugCount = 0;
  /** трекер умеет пересаживать кота (меню долгого нажатия и пункт каталога) */
  canReanchor = false;
  private onPick: ((id: string) => void) | null = null;
  /** где кот на экране (ставит App); null — кота не видно */
  catRect: () => CatRect | null = () => null;

  constructor(parent: HTMLElement, private h: UiHandlers, opts: { micSupported: boolean; posterUrl?: string }) {
    const root = document.createElement('div');
    root.className = 'ui';
    root.innerHTML = `
      <div class="screen start ob" data-step="0">
        <div class="ob-sky" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="ob-track">
          <section class="ob-slide" aria-label="Шаг 1 из 2">
            <div class="ob-art art-mystery" aria-hidden="true">
              <div class="kc">
                <div class="kc-chip"></div><div class="kc-logo">СБЕР KIDS</div>
                <div class="kc-portal"><div class="m-ears"><b></b><b></b></div><span class="eye"></span><span class="eye"></span></div>
              </div>
              <span class="spk s1"></span><span class="spk s2"></span><span class="spk s3"></span><span class="spk s4"></span>
              <div class="m-q">?</div>
            </div>
            <div class="screen-text"><h1>Привет! В&nbsp;твоей карте кто-то живёт</h1><p>Он давно ждёт, когда ты заглянешь. Познакомимся?</p></div>
          </section>
          <section class="ob-slide" aria-label="Шаг 2 из 2">
            <div class="ob-art art-safe" aria-hidden="true">
              <div class="sf-card"><div class="kc-chip"></div><div class="kc-logo">СБЕР KIDS</div></div>
              <div class="sf-shield">${ICON.shield}</div>
              <div class="sf-fam"><span class="ava a-kid">${ICON.kid}</span><span class="ava a-mom">${ICON.adult}</span><span class="ava a-dad">${ICON.adult}</span></div>
            </div>
            <div class="screen-text"><h1>Положи карту на&nbsp;стол и&nbsp;наведи камеру</h1><p>Карта — только твоя: показывай её только маме или папе. Цифры на&nbsp;карте я&nbsp;не&nbsp;читаю.</p></div>
          </section>
        </div>
        <div class="ob-foot">
          <div class="ob-dots" aria-hidden="true"><i class="on"></i><i></i></div>
          <button class="btn btn-primary btn-block ob-next" data-a="ob-next" type="button">Познакомиться</button>
          <button class="btn btn-primary btn-block ob-wake hidden" data-a="wake" type="button">${ICON.cam}<span>Открыть камеру</span></button>
          <div class="fine">${ICON.lock}<span>Камера и микрофон — одним нажатием. Видео и голос остаются в телефоне, данные карты не считываются. <button class="linkbtn" type="button" data-a="terms">Условия</button></span></div>
        </div>
        <div class="terms hidden" role="dialog" aria-modal="true" aria-label="Условия">
          <div class="terms-card">
            <div class="sheet-title">Условия и безопасность</div>
            <div class="terms-body">
              <p><b>Для детей.</b> Карта — личная. Не давай её и не показывай никому, кроме мамы, папы или того, кто о тебе заботится. Не фотографируй карту и не отправляй её фото.</p>
              <p><b>Данные карты не считываются.</b> Камера ищет только форму карты на столе, чтобы посадить на неё персонажа. Номер, имя, срок действия и код (CVC) не распознаются, не сохраняются и никуда не передаются.</p>
              <p><b>Видео и звук.</b> Изображение с камеры и голос обрабатываются только на устройстве и не записываются. Распознавание речи работает без отправки звука на сервер.</p>
              <p><b>Разрешения.</b> Камера нужна, чтобы показать персонажа на карте. Микрофон — по желанию, чтобы с персонажем можно было поговорить. Оба доступа можно отключить в настройках браузера.</p>
              <p><b>Родителям.</b> Это демонстрационный прототип. Покупки, переводы и доступ к счёту из него невозможны. Если в будущем появится узнавание карты для входа в аккаунт, оно будет работать только после отдельного согласия родителя.</p>
              <p class="terms-note">Черновик для согласования с юристами, не публичная оферта.</p>
            </div>
            <button class="btn btn-primary btn-block" type="button" data-a="terms-close">Понятно</button>
          </div>
        </div>
      </div>
      <div class="scan hidden"><span>${ICON.paw}<em>Наведи камеру на карту</em></span></div>
      <div class="press-menu hidden" role="menu" aria-label="Кот"><button type="button" role="menuitem" data-a="press-reanchor">${ICON.repin}<span>Пересадить на другую карту</span></button></div>
      <div class="bubble" role="status" aria-live="polite"><span class="who"></span><span class="txt"></span></div>
      <div class="nudge hidden" aria-hidden="true"><div class="nudge-hand">${ICON.finger}</div></div>
      <div class="coach hidden" aria-hidden="true"><div class="coach-hand">${ICON.finger}</div><div class="coach-label">Погладь меня</div></div>
      <div class="stack">
        <div class="sheet name-sheet namebox hidden">
          <div class="sheet-title">Как тебя зовут?</div>
          <form class="name-row" action="#">
            <input type="text" maxlength="20" placeholder="Твоё имя" enterkeyhint="done" autocomplete="off" autocapitalize="words" spellcheck="false" aria-label="Твоё имя" />
            <button class="btn btn-primary ok" data-a="name" type="submit">Готово</button>
          </form>
          <button class="btn btn-text skip" data-a="skip" type="button">Пропустить</button>
        </div>
        <div class="sheet choice-sheet hidden" role="dialog" aria-label="Выбери характер">
          <div class="sheet-title">Каким мне быть?</div>
          <div class="choices"></div>
        </div>
        <button class="btn btn-primary kids hidden" data-a="kids">В СберKids <span aria-hidden="true">→</span></button>
        <div class="sheet kids-sheet hidden" role="dialog" aria-label="СберKids">
          <div class="sheet-title">Брат живёт в СберKids</div>
          <p class="sheet-sub">Это приложение Сбера для детей и родителей. Попроси взрослого открыть его на телефоне — там брат-кот и копилка.</p>
          <a class="btn btn-primary btn-block kids-go" href="#" target="_blank" rel="noopener" data-a="kids-go">Открыть СберKids</a>
          <button class="btn btn-text btn-block" type="button" data-a="kids-close">Потом</button>
        </div>
        <button class="btn btn-light shakebtn hidden" data-a="shake">Сдёрнуть наклейки</button>
        <div class="chips suggest hidden" role="toolbar" aria-label="Кот предлагает"></div>
        <div class="catalog hidden" role="dialog" aria-label="Что умеет кот">
          <div class="cat-top"><div class="cat-tabs" role="tablist"></div></div>
          <div class="cat-row" role="list"></div>
        </div>
        <div class="mic-hint" aria-live="polite"></div>
      </div>
      <div class="dock no-play">
        <button class="iconbtn side-l" data-a="mute" aria-label="Выключить звук">${ICON.sound}</button>
        <div class="mic-slot">${EARS}<button class="mic" aria-label="Скажи коту">${ICON.mic}</button></div>
        <button class="pawbtn side-r" data-a="paw" type="button" aria-label="Что умеет кот" aria-haspopup="dialog" aria-expanded="false"><span class="paw-ico">${ICON.paw}</span><span class="paw-l">Что умею</span></button>
      </div>`;
    parent.appendChild(root);
    this.root = root;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.start = q('.start');
    this.scan = q('.scan');
    this.bubble = q('.bubble');
    this.chips = q('.chips');
    this.mic = q('.mic');
    this.micSlot = q('.mic-slot');
    this.micHint = q('.mic-hint');
    this.dock = q('.dock');
    this.pawBtn = q('[data-a="paw"]');
    this.kids = q('.kids');
    this.shakeBtn = q('.shakebtn');
    this.namebox = q('.namebox');
    this.choice = q('.choice-sheet');

    if (!h.onAction)
      for (const t of CHIPS) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = t;
        b.onclick = () => h.onChip(t);
        this.chips.appendChild(b);
        this.sugCount++;
      }
    root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      const a = btn?.getAttribute('data-a');
      if (a === 'wake') h.onWake();
      if (a === 'press-reanchor') {
        this.hidePressMenu();
        h.onReanchor?.();
      }
      if (a === 'paw') {
        // до конца знакомства каталога нет: кнопка видна (приглушена), а кот объясняет, что сначала познакомимся
        if (this.dock.classList.contains('no-play')) this.micHintText('Сначала познакомимся — потом покажу, что умею');
        else if (this.catalogOpen) this.closeCatalog();
        else this.openCatalog();
      }
      if (a === 'ob-next') this.obGo(this.obStep + 1);
      if (a === 'terms') this.start.querySelector('.terms')!.classList.remove('hidden');
      if (a === 'terms-close') this.start.querySelector('.terms')!.classList.add('hidden');
      if (a === 'kids') h.onKids();
      if (a === 'kids-close') this.showKids(false);
      if (a === 'kids-go') setTimeout(() => this.showKids(false), 300);
      if (a === 'shake') h.onShakeButton();
      if (a === 'skip') h.onSkipName();
      if (a === 'cat-close') this.closeCatalog();
      if (a === 'reload') location.reload();
      if (a === 'mute') {
        this.muted = !this.muted;
        btn!.innerHTML = this.muted ? ICON.muted : ICON.sound;
        btn!.classList.toggle('on', this.muted);
        btn!.setAttribute('aria-label', this.muted ? 'Включить звук' : 'Выключить звук');
        h.onMute(this.muted);
      }
    });
    q<HTMLFormElement>('.name-row').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitName();
    });
    // «держи и говори»
    // «слушаю всегда»: нажал и отпустил — «я говорю» (слушаем фразу целиком); держишь — «держи и говори», как в режиме по кнопке
    const down = (e: Event) => {
      e.preventDefault();
      this.micDownAt = performance.now();
      this.mic.classList.add('on');
      h.onMicDown();
    };
    const up = (e: Event) => {
      e.preventDefault();
      if (!this.mic.classList.contains('on')) return;
      this.mic.classList.remove('on');
      if (this.micModeNow === 'auto' && h.onMicTap && performance.now() - this.micDownAt < 400) h.onMicTap();
      else h.onMicUp();
    };
    this.mic.addEventListener('pointerdown', down);
    this.mic.addEventListener('pointerup', up);
    this.mic.addEventListener('pointercancel', up);
    this.mic.addEventListener('pointerleave', up);
    this.mic.addEventListener('contextmenu', (e) => e.preventDefault());
    if (!opts.micSupported) {
      this.mic.dataset.unsupported = '1';
      this.mic.classList.add('hidden');
      this.dock.classList.add('no-mic');
    }
    this.watchKeyboard();
    this.obSwipe();
    this.catalogGestures();
  }

  /** клавиатура: лист имени поднимается к ней (iOS не сжимает layout viewport) */
  private watchKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const upd = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      this.root.style.setProperty('--kb', `${kb}px`);
      this.root.classList.toggle('kb', kb > 80 && !this.namebox.classList.contains('hidden'));
    };
    vv.addEventListener('resize', upd);
    vv.addEventListener('scroll', upd);
  }

  private submitName() {
    const inp = this.root.querySelector('.name-row input') as HTMLInputElement;
    const v = inp.value.trim();
    if (!v) {
      inp.focus();
      return;
    }
    inp.blur();
    this.h.onName(v);
  }

  /** онбординг: два шага, свайп и кнопка «дальше»; на последнем — «Открыть камеру» (жест для iOS: камера, микрофон, датчики) */
  private obStep = 0;
  private obGo(i: number) {
    const n = 2;
    i = Math.max(0, Math.min(n - 1, i));
    this.obStep = i;
    this.start.dataset.step = String(i);
    (this.start.querySelector('.ob-track') as HTMLElement).style.transform = `translateX(${-i * 100}%)`;
    this.start.querySelectorAll('.ob-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    const next = this.start.querySelector('.ob-next') as HTMLElement;
    next.textContent = ['Познакомиться', ''][i];
    next.classList.toggle('hidden', i === n - 1);
    this.start.querySelector('.ob-wake')!.classList.toggle('hidden', i !== n - 1);
  }
  private obSwipe() {
    let x0 = 0, y0 = 0, on = false;
    this.start.addEventListener('pointerdown', (e) => ((x0 = e.clientX), (y0 = e.clientY), (on = true)));
    this.start.addEventListener('pointerup', (e) => {
      if (!on || !this.start.querySelector('.terms')!.classList.contains('hidden')) return;
      on = false;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.obGo(this.obStep + (dx < 0 ? 1 : -1));
    });
  }

  /** лист «Брат живёт в СберKids» со ссылкой (url — из config) */
  showKids(v: boolean, url?: string) {
    const sh = this.root.querySelector('.kids-sheet') as HTMLElement;
    if (url) (sh.querySelector('.kids-go') as HTMLAnchorElement).href = url;
    sh.classList.toggle('hidden', !v);
    this.layoutBubble();
  }

  /** обучалка первого знакомства: палец гладит кота + подпись «Погладь меня»; чипы кота подсвечены */
  coach(v: boolean) {
    const c = this.root.querySelector('.coach') as HTMLElement;
    this.chips.classList.toggle('attn', v);
    if (!v) {
      c.classList.add('hidden');
      return;
    }
    const place = () => {
      const r = this.catRect();
      const W = this.root.clientWidth, H = this.root.clientHeight;
      // палец гладит по голове-спине: чуть ниже центра головы, подпись — над панелью действий
      const x = r ? r.cx : W / 2, y = r ? r.headY + (r.bottom - r.headY) * 0.18 : H * 0.42;
      c.style.left = `${Math.round(Math.max(70, Math.min(W - 70, x)))}px`;
      // подпись не налезает на панель действий (маленькие экраны)
      const panelTop = this.chips.classList.contains('hidden') ? H - 200 : this.chips.getBoundingClientRect().top - this.root.getBoundingClientRect().top;
      c.style.top = `${Math.round(Math.max(110, Math.min(panelTop - 100, y)))}px`;
    };
    place();
    c.classList.remove('hidden');
    const loop = () => {
      if (c.classList.contains('hidden')) return;
      place();
      setTimeout(loop, 250);
    };
    setTimeout(loop, 250);
  }

  /** трекер умеет пересаживать кота (кнопки на экране нет: долгое нажатие → меню, или «Ещё» в каталоге) */
  showReanchor(v: boolean) {
    this.canReanchor = v;
  }

  // ───────────── меню долгого нажатия ─────────────
  private pressTimer = 0;
  get pressMenuEl() {
    return this.root.querySelector('.press-menu') as HTMLDivElement;
  }
  /** долгое нажатие на кота / карту: маленькое меню из одного пункта «Пересадить на другую карту» у пальца */
  pressMenu(x: number, y: number) {
    if (!this.canReanchor) return false;
    const m = this.pressMenuEl;
    this.closeCatalog();
    m.classList.remove('hidden');
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const w = m.offsetWidth, h = m.offsetHeight;
    // над пальцем (палец не закрывает пункт), не вылезая за края и не залезая в док
    const left = Math.max(12, Math.min(W - w - 12, x - w / 2));
    const top = Math.max(12, Math.min(H - h - 120, y - h - 28));
    m.style.left = `${Math.round(left)}px`;
    m.style.top = `${Math.round(top)}px`;
    clearTimeout(this.pressTimer);
    this.pressTimer = window.setTimeout(() => this.hidePressMenu(), 5000);
    return true;
  }
  hidePressMenu() {
    clearTimeout(this.pressTimer);
    this.pressMenuEl.classList.add('hidden');
  }

  hideStart() {
    this.start.classList.add('leaving');
    setTimeout(() => this.start.classList.add('hidden'), 300);
  }
  /** подпись кнопки «Открыть камеру» (десктоп-просмотр без камеры — «Позвать кота», без значка камеры) */
  setWakeLabel(text: string) {
    const b = this.start.querySelector('.ob-wake') as HTMLButtonElement;
    b.innerHTML = '<span></span>';
    (b.firstChild as HTMLElement).textContent = text;
  }
  setStartBusy(text: string) {
    const b = this.start.querySelector('.ob-wake') as HTMLButtonElement;
    b.innerHTML = `<span class="spinner" aria-hidden="true"></span><span></span>`;
    (b.lastChild as HTMLElement).textContent = text;
    b.disabled = true;
  }
  /** полноэкранная ошибка с кнопкой «Попробовать снова» (нет камеры и т. п.) */
  error(title: string, text: string, action = 'Попробовать снова') {
    this.root.querySelector('.screen.err')?.remove();
    const el = document.createElement('div');
    el.className = 'screen err';
    el.innerHTML = `<div class="screen-body"><div class="err-ico">${ICON.camoff}</div><div class="screen-col"><div class="screen-text"><h1></h1><p></p></div>
      <div class="screen-actions"><button class="btn btn-primary btn-block" data-a="reload"></button></div></div></div>`;
    el.querySelector('h1')!.textContent = title;
    el.querySelector('p')!.textContent = text;
    el.querySelector('button')!.textContent = action;
    this.root.appendChild(el);
  }
  show(what: 'scan_hint' | 'name_prompt' | 'chips' | 'sberkids' | 'shake_button' | 'mic', v: boolean) {
    if (what === 'chips') {
      this.chipsByScenario = v;
      this.syncChips();
      return;
    }
    // три нижние кнопки (звук, микрофон, лапка) видны всегда после онбординга: сценарий микрофон не прячет.
    // Нет микрофона в браузере — кнопки нет (dock.no-mic)
    if (what === 'mic') return;
    const el = { scan_hint: this.scan, name_prompt: this.namebox, sberkids: this.kids, shake_button: this.shakeBtn }[what];
    el.classList.toggle('hidden', !v);
    if (what === 'name_prompt' && !v) this.root.classList.remove('kb');
    this.layoutBubble();
  }
  /** игра идёт: видны чипы кота (если кот что-то предлагает и каталог закрыт). Лапка видна всегда; до первой игры
   *  (знакомство) — приглушена (dock.no-play), после — активна до конца сессии, даже когда сценарий прячет чипы */
  private playSeen = false;
  /** игра началась (фаза play): лапка активна, даже если чипы ещё ждут обучалку «погладь меня» */
  setPlaying() {
    if (this.playSeen) return;
    this.playSeen = true;
    this.syncChips();
  }
  private syncChips() {
    const on = this.chipsByScenario;
    if (!on) {
      this.closeCatalog();
      this.nudge(null);
    }
    this.chips.classList.toggle('hidden', !on || this.catalogOpen || !this.sugCount);
    if (on) this.playSeen = true;
    this.dock.classList.toggle('no-play', !this.playSeen);
    if (on) this.syncMoreDot();
  }

  // ───────────── чипы-предложения кота ─────────────
  /** до двух чипов от кота (scenario/suggest.ts); перерисовка — только когда набор сменился */
  setSuggestions(chips: Chip[]) {
    const key = chips.map((c) => `${c.id}:${c.label}`).join('|');
    if (key === this.sugKey) return;
    this.sugKey = key;
    this.sugCount = chips.length;
    const box = this.chips;
    box.innerHTML = '';
    for (const c of chips) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sug';
      b.dataset.chip = c.id;
      if ('action' in c.run) b.dataset.act = c.run.action;
      b.innerHTML = `<span class="sug-ico">${this.catIcon(c.icon) || this.catIcon('chat')}</span><span class="sug-l"></span>`;
      (b.querySelector('.sug-l') as HTMLElement).textContent = c.label;
      b.onclick = () => {
        b.classList.remove('tapped');
        void b.offsetWidth;
        b.classList.add('tapped');
        if ('action' in c.run && this.tried.mark(c.run.action)) this.syncMoreDot();
        this.nudge(null);
        this.h.onSuggest?.(c);
      };
      box.appendChild(b);
    }
    // смена набора — чипы «подпрыгивают», чтобы ребёнок заметил новое предложение
    box.classList.toggle('game', chips.some((c) => c.id.startsWith('game:')));
    box.classList.remove('swap');
    void box.offsetWidth;
    box.classList.add('swap');
    this.syncChips();
  }
  /** текущие чипы (для снимков и тестов) */
  get suggestions() {
    return [...this.chips.querySelectorAll<HTMLElement>('.sug')].map((b) => b.dataset.chip ?? '');
  }

  // ───────────── подсказка кота без пузыря ─────────────
  /**
   * Подсказка «что делать» без немого пузыря (решение продакта: немых пузырей нет — docs/scenario/LOGIC.md).
   * 'soft' — кот сам сказал подсказку голосом: чипы и лапка подпрыгивают; 'finger' — голоса нет: палец стучит по первому
   * чипу. null — убрать. Текст подсказки — только для экранного диктора (aria-label), на экране не пишется.
   */
  private nudgeMode: 'soft' | 'finger' | null = null;
  nudge(mode: 'soft' | 'finger' | null, label = '') {
    const el = this.root.querySelector('.nudge') as HTMLElement;
    if (!mode || this.catalogOpen) {
      if (this.nudgeMode) {
        this.nudgeMode = null;
        this.chips.classList.remove('attn');
        el.classList.add('hidden');
      }
      return;
    }
    if (this.nudgeMode === mode) return;
    this.nudgeMode = mode;
    this.chips.classList.remove('attn');
    void this.chips.offsetWidth;
    this.chips.classList.add('attn');
    if (mode === 'soft') {
      this.pawBtn.classList.remove('attn');
      void this.pawBtn.offsetWidth;
      this.pawBtn.classList.add('attn');
      el.classList.add('hidden');
      return;
    }
    const first = this.chips.querySelector('.sug') as HTMLElement | null;
    const target = first && !this.chips.classList.contains('hidden') ? first : this.pawBtn;
    const r = target.getBoundingClientRect(), root = this.root.getBoundingClientRect();
    el.style.left = `${Math.round(r.left - root.left + Math.min(r.width * 0.5, 44))}px`;
    el.style.top = `${Math.round(r.top - root.top + r.height * 0.55)}px`;
    el.setAttribute('aria-label', label);
    el.classList.remove('hidden');
  }
  /** подсказка сейчас на экране (снимки, тесты) */
  get nudgeOn() {
    return this.nudgeMode;
  }

  // ───────────── каталог «Что умеет кот» ─────────────
  /** что ребёнок уже пробовал: точки «новое» и «открыто N из M» */
  readonly tried = new TriedStore();
  private catalogOpen = false;
  private catTab: SectionId = 'care';
  private catSections: CatalogSection[] = [];
  private catCompact = false;
  private catFullH = 0;
  private get catalogEl() {
    return this.root.querySelector('.catalog') as HTMLDivElement;
  }
  private catIcon(id: string) {
    return CAT_ICON[id] ?? (ICON as Record<string, string>)[id] ?? '';
  }
  /** точка на лапке, если в каталоге есть непробованное */
  private syncMoreDot() {
    if (!this.h.catalog) return;
    const c = this.h.catalog();
    const n = c ? this.tried.count(c.sections) : { tried: 0, total: 0 };
    this.pawBtn.classList.toggle('new', n.tried < n.total);
  }
  get isCatalogOpen() {
    return this.catalogOpen;
  }
  /** каталог на месте чипов: крупные вкладки-разделы и один ряд иконок; кот и пузырь остаются видны. В конце — «Ещё» */
  openCatalog(tab?: SectionId) {
    const c = this.h.catalog?.();
    if (!c || !c.sections.length) return;
    const more = moreSection({ reanchor: this.canReanchor && !!this.h.onReanchor, mic: this.mic.dataset.unsupported ? null : this.micModeNow });
    this.catSections = more ? [...c.sections, more] : c.sections;
    this.hidePressMenu();
    this.nudge(null);
    if (tab && c.sections.some((s) => s.id === tab)) this.catTab = tab;
    if (!c.sections.some((s) => s.id === this.catTab)) this.catTab = c.sections[0].id;
    const el = this.catalogEl;
    el.setAttribute('aria-label', `Что умеет ${c.who}`);
    this.catalogOpen = true;
    this.root.classList.add('cat-open');
    this.chips.classList.add('hidden');
    this.pawBtn.classList.add('on');
    this.pawBtn.setAttribute('aria-expanded', 'true');
    el.classList.remove('hidden', 'compact', 'leaving');
    el.style.transform = '';
    this.catCompact = false;
    this.root.querySelector('.coach')?.classList.add('hidden');
    this.renderCatalog();
    this.catFullH = el.offsetHeight;
    this.fitCatalog();
    const loop = () => {
      if (!this.catalogOpen) return;
      this.fitCatalog();
      setTimeout(loop, 300);
    };
    setTimeout(loop, 300);
    this.layoutBubble();
  }
  closeCatalog() {
    if (!this.catalogOpen) return;
    this.catalogOpen = false;
    this.root.classList.remove('cat-open');
    this.catalogEl.classList.add('hidden');
    this.catalogEl.style.transform = '';
    this.pawBtn.classList.remove('on');
    this.pawBtn.setAttribute('aria-expanded', 'false');
    this.syncChips();
  }
  private renderCatalog() {
    const el = this.catalogEl;
    const tabs = el.querySelector('.cat-tabs') as HTMLDivElement;
    const row = el.querySelector('.cat-row') as HTMLDivElement;
    tabs.innerHTML = '';
    for (const s of this.catSections) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'cat-tab';
      t.dataset.tab = s.id;
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(s.id === this.catTab));
      t.classList.toggle('on', s.id === this.catTab);
      t.classList.toggle('new', s.id !== 'more' && s.items.some((i) => !this.tried.has(i.id)));
      t.dataset.sec = s.id;
      t.setAttribute('aria-label', s.title);
      t.innerHTML = `<span class="cat-tab-ico">${this.catIcon(s.icon)}</span><span class="cat-tab-l"></span>`;
      (t.querySelector('.cat-tab-l') as HTMLElement).textContent = s.id === 'say' ? 'Скажи' : s.title;
      t.onclick = () => {
        this.catTab = s.id;
        this.renderCatalog();
        (el.querySelector('.cat-row') as HTMLElement).scrollTo?.({ left: 0, top: 0 });
      };
      tabs.appendChild(t);
    }
    const sec = this.catSections.find((s) => s.id === this.catTab)!;
    row.innerHTML = '';
    row.dataset.sec = this.catCompact ? 'all' : sec.id;
    // поджатая панель (кот низко): без вкладок — все разделы одним рядом, с текущего, между разделами — значок раздела
    const secs = this.catCompact ? [sec, ...this.catSections.filter((s) => s !== sec)] : [sec];
    for (const it of secs.flatMap((s) => s.items.map((it, k) => ({ ...it, sec: s, first: k === 0 })))) {
      if (this.catCompact && it.first) {
        const sep = document.createElement('span');
        sep.className = 'cat-sep';
        sep.dataset.sec = it.sec.id;
        sep.title = it.sec.title;
        sep.setAttribute('aria-label', it.sec.title);
        sep.innerHTML = this.catIcon(it.sec.icon);
        row.appendChild(sep);
      }
      const b = document.createElement('button');
      b.dataset.sec = it.sec.id;
      b.type = 'button';
      b.setAttribute('role', 'listitem');
      b.dataset.item = it.id;
      if ('ui' in it.run) {
        b.className = 'cat-phrase cat-ui';
        b.innerHTML = `<span class="cat-phrase-ico">${this.catIcon(it.icon)}</span><span class="act-l"></span>`;
      } else if ('say' in it.run) {
        b.className = 'cat-phrase';
        b.innerHTML = `<span class="cat-phrase-ico">${this.catIcon('chat')}</span><span class="act-l"></span>`;
      } else {
        b.className = 'act cat-item';
        b.innerHTML = `<span class="act-ico">${this.catIcon(it.icon)}</span><span class="act-l"></span>`;
      }
      (b.querySelector('.act-l') as HTMLElement).textContent = it.label;
      if (it.id === 'sticker' && feature('stickers.pack')) {
        // коллекция наклеек пака: «собрал N из M»
        const c = stickerCollection();
        const n = document.createElement('span');
        n.className = 'cat-count';
        n.textContent = `${c.n}/${c.total}`;
        n.title = `Собрано наклеек: ${c.n} из ${c.total}`;
        b.setAttribute('aria-label', `${it.label}: собрано ${c.n} из ${c.total}`);
        b.querySelector('.act-ico')?.appendChild(n);
      }
      b.classList.toggle('new', !('ui' in it.run) && !this.tried.has(it.id));
      b.onclick = () => this.pickCatalog(it);
      row.appendChild(b);
    }
  }
  /** выбор: лист закрывается сразу — ребёнок видит реакцию кота */
  private pickCatalog(it: CatalogItem) {
    if (this.catDragged) return;
    if (!('ui' in it.run)) this.tried.mark(it.id);
    this.closeCatalog();
    setTimeout(() => this.h.onCatalogPick?.(it), 60);
  }
  /** кот низко на экране (или у края в альбомной) — панель поджимается до одного ряда без вкладок */
  private fitCatalog() {
    if (!this.catalogOpen) return;
    const el = this.catalogEl;
    const r = this.catRect();
    const box = el.getBoundingClientRect(), rootBox = this.root.getBoundingClientRect();
    const land = this.root.clientWidth > this.root.clientHeight && this.root.clientHeight <= 520;
    let overlap = false;
    if (r) {
      if (land) {
        // колонка у левого края: полная ширина (с вкладками) против левого края кота
        const full = this.catCompact ? box.width + 64 : box.width;
        overlap = r.cx - r.half < box.left - rootBox.left + full + 6 && r.bottom > box.top - rootBox.top && r.top < box.bottom - rootBox.top;
      } else {
        const top = box.bottom - rootBox.top - (this.catFullH || box.height);
        overlap = r.bottom > top - 4 && r.top < box.bottom - rootBox.top;
      }
    }
    if (overlap !== this.catCompact) {
      this.catCompact = overlap;
      el.classList.toggle('compact', overlap);
      this.renderCatalog();
    }
  }
  /** свайп вниз (в альбомной — к краю) закрывает; тап вне панели — тоже */
  private catDragged = false;
  private catalogGestures() {
    const el = this.catalogEl;
    let x0 = 0, y0 = 0, on = false;
    const land = () => this.root.clientWidth > this.root.clientHeight && this.root.clientHeight <= 520;
    el.addEventListener('pointerdown', (e) => {
      x0 = e.clientX;
      y0 = e.clientY;
      on = true;
      this.catDragged = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!on) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (!land() && dy > 8 && dy > Math.abs(dx) * 1.2) {
        this.catDragged = true;
        el.style.transform = `translateY(${dy}px)`;
      } else if (land() && dx < -8 && -dx > Math.abs(dy) * 1.2) {
        this.catDragged = true;
        el.style.transform = `translateX(${dx}px)`;
      }
    });
    const end = (e: PointerEvent) => {
      if (!on) return;
      on = false;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      el.style.transform = '';
      if (this.catDragged && ((!land() && dy > 50) || (land() && dx < -50))) this.closeCatalog();
      // клик после перетаскивания не выбирает действие
      setTimeout(() => (this.catDragged = false), 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => {
      on = false;
      el.style.transform = '';
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.catalogOpen) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.catalog, .dock')) return;
      this.closeCatalog();
    }, true);
    // меню долгого нажатия: тап мимо — закрыть
    document.addEventListener('pointerdown', (e) => {
      const m = this.pressMenuEl;
      if (m.classList.contains('hidden') || (e.target as HTMLElement | null)?.closest?.('.press-menu')) return;
      this.hidePressMenu();
    }, true);
  }

  /** лист «Каким мне быть?»; onPick — выбор пальцем (голосом выбирают в обход листа) */
  showChoice(options: ChoiceOption[], onPick: (id: string) => void) {
    this.onPick = onPick;
    const box = this.choice.querySelector('.choices') as HTMLDivElement;
    box.innerHTML = '';
    for (const o of options) {
      const meta = PERSONA_UI[o.id] ?? { img: '', tagline: '', color: o.palette?.accent ?? '#21a038', soft: '#eef3f1' };
      const b = document.createElement('button');
      b.className = 'choice';
      b.type = 'button';
      b.dataset.p = o.id;
      b.style.setProperty('--pc', meta.color);
      b.style.setProperty('--pc-soft', meta.soft);
      b.style.setProperty('--pc-line', `${meta.color}55`);
      const title = o.title.charAt(0) + o.title.slice(1).toLowerCase();
      b.innerHTML = `<span class="dot"></span><span class="pv">${meta.img ? `<img src="${asset(meta.img)}" alt="" draggable="false">` : ''}</span><b></b><small></small>`;
      b.querySelector('b')!.textContent = title;
      b.querySelector('small')!.textContent = meta.tagline;
      b.setAttribute('aria-label', `${title}: ${meta.tagline}`);
      b.onclick = () => {
        b.classList.add('picked');
        this.onPick?.(o.id);
      };
      box.appendChild(b);
    }
    this.choice.classList.remove('hidden');
    this.layoutBubble();
  }
  hideChoice() {
    this.onPick = null;
    this.choice.classList.add('hidden');
  }

  say(text: string, who: string, personaId: string, ms = 0) {
    this.hidePressMenu();
    (this.bubble.querySelector('.who') as HTMLElement).textContent = who;
    (this.bubble.querySelector('.txt') as HTMLElement).textContent = text;
    this.bubble.className = `bubble show ${personaId}`;
    this.layoutBubble();
    this.followCat();
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble.classList.remove('show'), ms || 2200 + text.length * 55);
  }

  /** реплика договорена — пузырь уходит вместе с голосом (text: только если в пузыре всё ещё она) */
  hideBubble(text?: string) {
    if (text !== undefined && (this.bubble.querySelector('.txt') as HTMLElement).textContent !== text) return;
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble.classList.remove('show'), 250);
  }

  private following = false;
  /** пока пузырь виден — держим его над котом / сбоку от головы (кот ходит по карте, карта двигается) */
  private followCat() {
    if (this.following) return;
    this.following = true;
    let t = 0;
    const loop = (now: number) => {
      if (!this.bubble.classList.contains('show')) {
        this.following = false;
        return;
      }
      // раскладка (сброс стилей + чтение offset* = синхронный layout, а смена top/left — ещё и CSS-переход на 0,25 с)
      // только когда кот на экране заметно сдвинулся: дрожание трекинга на 1–3 px не перекладывает пузырь каждые 120 мс
      if (now - t > 120) {
        t = now;
        const k = bubbleKey(this.catRect());
        if (k !== this.bubbleAt) this.layoutBubble();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  /** положение кота при последней раскладке пузыря (bubbleKey) */
  private bubbleAt = '';

  /** пузырь сверху с хвостиком к голове; если сверху не помещается — сбоку от головы, на свободной стороне */
  layoutBubble() {
    const b = this.bubble;
    if (!b.classList.contains('show')) return;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const cat = this.catRect();
    this.bubbleAt = bubbleKey(cat);
    const st = b.style;
    // по умолчанию — сверху (позиция из CSS)
    b.classList.remove('side', 'tail-left', 'tail-right', 'tail-down');
    st.left = st.right = st.top = st.width = '';
    if (!cat || cat.bottom < 0 || cat.top > H) return;
    const top = b.offsetTop, bh = b.offsetHeight, bl = b.offsetLeft, bw = b.offsetWidth;
    const gap = 14;
    if (top + bh + gap <= cat.top) {
      b.classList.add('tail-down');
      st.setProperty('--tail-x', `${Math.max(28, Math.min(bw - 28, cat.cx - bl))}px`);
      return;
    }
    const pad = 16;
    const spaceL = cat.cx - cat.half - pad - gap;
    const spaceR = W - (cat.cx + cat.half) - pad - gap;
    const side = spaceR >= spaceL ? 'r' : 'l';
    const space = Math.min(300, Math.max(spaceL, spaceR));
    if (space < 150) return; // некуда — остаётся сверху (кот крупно, пузырь короткий)
    b.classList.add('side', side === 'r' ? 'tail-left' : 'tail-right');
    st.width = `${space}px`;
    st.left = `${side === 'r' ? cat.cx + cat.half + gap : cat.cx - cat.half - gap - space}px`;
    const h2 = b.offsetHeight;
    const y = Math.max(top, Math.min(H - h2 - 120, cat.headY - h2 / 2));
    st.top = `${y}px`;
    st.setProperty('--tail-y', `${Math.max(20, Math.min(h2 - 20, cat.headY - y))}px`);
  }

  /** режим микрофона (переключатель — в каталоге, раздел «Ещё»; ?mic=ptt): в «слушаю всегда» нажатие — «я говорю» */
  setMicMode(m: 'auto' | 'ptt') {
    this.micModeNow = m;
    this.mic.classList.toggle('auto', m === 'auto');
    this.mic.setAttribute('aria-label', m === 'auto' ? 'Скажи коту: кот слушает, нажми и говори' : 'Скажи коту: держи и говори');
  }
  get micMode() {
    return this.micModeNow;
  }

  micLevel(v: number) {
    this.mic.style.setProperty('--lvl', String(v));
  }
  /** «ушки» над кнопкой микрофона, пока кот слушает (CSS-анимация на композиторе, без перерисовки холста эффектов) */
  setEars(on: boolean) {
    this.micSlot.classList.toggle('ears', on);
  }
  /** кот слушает сам (окно ответа) — микрофон подсвечен */
  setListening(on: boolean) {
    if (on === this.listening) return;
    this.listening = on;
    this.mic.classList.toggle('listening', on);
    if (!on) this.hideHintSoon(1800);
  }
  /** подсказка над микрофоном; tone 'warn' — ошибка (нет доступа и т. п.) */
  micHintText(t: string, tone: 'info' | 'warn' = 'info') {
    this.micHint.textContent = t;
    this.micHint.classList.toggle('show', !!t);
    this.micHint.classList.toggle('warn', tone === 'warn');
    if (tone === 'warn' && !this.catalogOpen) {
      this.pawBtn.classList.remove('attn');
      void this.pawBtn.offsetWidth;
      this.pawBtn.classList.add('attn');
    }
    this.hideHintSoon(tone === 'warn' ? 6000 : /100%$/.test(t) ? 900 : 3500);
  }
  private hideHintSoon(ms: number) {
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      if (this.listening || this.mic.classList.contains('on')) return this.hideHintSoon(1500);
      this.micHint.classList.remove('show');
    }, ms);
  }
  toast(text: string, ms = 4000) {
    this.root.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = text;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
}

/** спящий кот на стартовом экране */
export const posterUrl = () => asset('video/sprites/kind/pose_sleep.webp');
