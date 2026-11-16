/**
 * Реестр вкладок debug-панели (?debug). Любой модуль регистрирует свою вкладку:
 *
 *   import { registerDebugTab } from '../debug/tabs';
 *   registerDebugTab({ id: 'voice', title: 'Голос', order: 40, build: (el, ui) => { ui.btn(el, '▶', () => …); } });
 *
 * Модуль крошечный и без зависимостей — его можно импортировать из основного бандла: сама панель
 * (debugPanel.ts) грузится лениво только в ?debug и рисует все вкладки, зарегистрированные до и после неё.
 * build() вызывается один раз при первом открытии вкладки; может вернуть функцию очистки.
 * tick() (необязательно) — раз в ~250 мс, пока вкладка открыта (обновить цифры).
 */
import type { App } from '../app';

export interface DebugUi {
  readonly app: App;
  /** кнопка; id → атрибут data-dbg (по нему кликают скрипты скриншотов) */
  btn(parent: HTMLElement, label: string, fn: () => void, id?: string): HTMLButtonElement;
  /** заголовок + контейнер подраздела */
  section(parent: HTMLElement, title: string): HTMLDivElement;
  /** ползунок; возвращает <input> */
  slider(parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): HTMLInputElement;
  /** выпадающий список */
  select(parent: HTMLElement, options: [value: string, label: string][], onChange: (v: string) => void, id?: string): HTMLSelectElement;
  /** строка в общий лог панели */
  log(s: string): void;
}

export interface DebugTab {
  id: string;
  title: string;
  /** порядок вкладок (меньше — левее). Встроенные: 10 сценарий, 20 анимации и эффекты, 30 кот на карте, 40 голос, 90 лог */
  order?: number;
  build(el: HTMLElement, ui: DebugUi): void | (() => void);
  tick?(el: HTMLElement, ui: DebugUi): void;
}

const tabs = new Map<string, DebugTab>();
const listeners = new Set<(t: DebugTab) => void>();

/** Зарегистрировать (или заменить по id) вкладку. Безопасно вызывать и без ?debug — ничего не рисуется. */
export function registerDebugTab(tab: DebugTab): void {
  tabs.set(tab.id, tab);
  listeners.forEach((fn) => fn(tab));
}

export function debugTabs(): DebugTab[] {
  return [...tabs.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

/** подписка панели на вкладки, зарегистрированные после её создания */
export function onDebugTab(fn: (t: DebugTab) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== 'undefined') (window as any).__debugTabs = { register: registerDebugTab, list: debugTabs };
