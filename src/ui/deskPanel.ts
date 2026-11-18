/**
 * Десктоп-панель умений и проверки (feature 'desktop.panel'): только десктоп-просмотр (?desktop на устройстве без касаний)
 * и окно ≥ 900 px. Справа, 360 px, сворачивается (Tab или \). Кот остаётся по центру оставшейся области: #app сужается
 * на ширину панели, App.resize() пересчитывает камеру и слои.
 *
 *  «Умения» — ВСЕ пункты каталога (тот же источник, что лист/лента: UI.catalogGroups → actionCatalog.buildCatalog,
 *   «Ещё», пункт дома, комнаты, «Сдёрнуть наклейки» вместо встряски) сеткой без горизонтальной прокрутки, точки «новое»;
 *   поиск сверху (Enter — первый найденный), чипы кота с клавишами 1–9.
 *  «Тест» — в lab, в MVP только с ?debug или ?from=test: событие/реплика по id (поиск по content/events.json и репликам
 *   характеров), эмоция лица, характер, состояния (дрёма, грусть, карта потеряна, перелокализация, дом и комнаты, флоу),
 *   режим микрофона, последние 20 строк лога. Работает через window.__cat (src/debug/catApi.ts) и Director.flow.
 *
 * Чистые функции (deskHotkey, deskActive) покрыты тестом tests/deskPanel.test.ts.
 */
import type { App } from '../app';
import type { CatApi } from '../debug/catApi';
import type { CatalogItem } from './actionCatalog';
import { CAT_ICON } from './catalogIcons';
import { filterGroups, firstMatch, type CatalogGroup } from './catalogGroups';
import { IS_LAB, feature, fromTestPage } from '../config/edition';
import { PERSONA_IDS } from '../persona/types';
import { FACE_IDS } from '../character/face';
import { ZONES } from '../home/zones';
import './deskPanel.css';

export const DESK_MIN_W = 900;
export const DESK_W = 360;
const KEY = 'ar.deskPanel';

/** панель включена: десктоп-просмотр, функция в редакции, окно достаточно широкое */
export function deskActive(desktopView: boolean, width: number): boolean {
  return desktopView && feature('desktop.panel') && width >= DESK_MIN_W;
}

/** вкладка «Тест»: lab, или ?debug / ?from=test в MVP */
export function testTabAllowed(search: string, referrer = '', lab = IS_LAB): boolean {
  return lab || new URLSearchParams(search).has('debug') || fromTestPage(search, referrer);
}

export type DeskKey = { kind: 'toggle' } | { kind: 'search' } | { kind: 'chip'; index: number } | { kind: 'escape' } | null;

/** клавиша → действие панели (вне поля ввода; с Cmd/Ctrl/Alt — ничего) */
export function deskHotkey(e: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }, inText: boolean): DeskKey {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === 'Escape') return { kind: 'escape' };
  if (inText) return null;
  if (e.key === 'Tab' || e.key === '\\' || e.code === 'Backslash') return { kind: 'toggle' };
  if (e.key === '/' || e.code === 'Slash') return { kind: 'search' };
  const m = /^Digit([1-9])$/.exec(e.code ?? '') ?? /^([1-9])$/.exec(e.key);
  if (m) return { kind: 'chip', index: Number(m[1]) - 1 };
  return null;
}

const isText = (el: Element | null) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class DeskPanel {
  readonly el: HTMLElement;
  private tog: HTMLButtonElement;
  private body: HTMLDivElement;
  private testBody: HTMLDivElement;
  private chipsEl: HTMLDivElement;
  private search: HTMLInputElement;
  private tab: 'skills' | 'test' = 'skills';
  private open = true;
  private active = false;
  private key = '';
  private logLines: string[] = [];
  readonly testAllowed: boolean;

  constructor(private app: App) {
    this.testAllowed = testTabAllowed(location.search, document.referrer);
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (s.open === false) this.open = false;
      if (s.tab === 'test' && this.testAllowed) this.tab = 'test';
    } catch {
      /* как по умолчанию */
    }
    const el = document.createElement('aside');
    el.className = 'dp';
    el.setAttribute('aria-label', 'Панель умений кота');
    el.innerHTML = `
      <div class="dp-head">
        <div class="dp-tabs" role="tablist">
          <button type="button" class="dp-tab" data-dp-tab="skills" role="tab" title="Все умения кота">Умения</button>
          ${this.testAllowed ? '<button type="button" class="dp-tab" data-dp-tab="test" role="tab" title="События, реплики, состояния">Тест</button>' : ''}
        </div>
        <button type="button" class="dp-x" data-dp="collapse" title="Свернуть панель (Tab или \\)" aria-label="Свернуть панель">${CHEV}</button>
      </div>
      <div class="dp-pane" data-pane="skills">
        <div class="dp-chips" aria-label="Кот предлагает"></div>
        <label class="dp-search"><span class="dp-search-ico">${SEARCH}</span><input type="search" placeholder="Найти умение…" aria-label="Найти умение" spellcheck="false" autocomplete="off"/><kbd>/</kbd></label>
        <div class="dp-body"></div>
        <div class="dp-keys">Tab / \\ — панель · / — поиск · Enter — первое · 1–9 — чипы кота · ← → ↑ ↓ + − R — вид</div>
      </div>
      <div class="dp-pane" data-pane="test"><div class="dp-test"></div></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.body = el.querySelector('.dp-body') as HTMLDivElement;
    this.testBody = el.querySelector('.dp-test') as HTMLDivElement;
    this.chipsEl = el.querySelector('.dp-chips') as HTMLDivElement;
    this.search = el.querySelector('.dp-search input') as HTMLInputElement;
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'dp-tog';
    tog.title = 'Панель умений (Tab или \\)';
    tog.setAttribute('aria-label', 'Открыть панель умений');
    tog.innerHTML = `${CAT_ICON.more ?? ''}<span>Умения</span><kbd>Tab</kbd>`;
    tog.onclick = () => this.toggle(true);
    document.body.appendChild(tog);
    this.tog = tog;

    el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-dp-tab],[data-dp]') as HTMLElement | null;
      if (!t) return;
      if (t.dataset.dpTab) this.setTab(t.dataset.dpTab as 'skills' | 'test');
      if (t.dataset.dp === 'collapse') this.toggle(false);
    });
    this.search.addEventListener('input', () => this.renderSkills(true));
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const it = firstMatch(this.groups(), this.search.value);
        if (it) this.pick(it);
      }
      if (e.key === 'Escape') {
        if (this.search.value) this.search.value = '';
        else this.search.blur();
        this.renderSkills(true);
        e.stopPropagation();
      }
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.sync());
    app.director.on('log', (s: string) => {
      this.logLines.push(s);
      if (this.logLines.length > 20) this.logLines.shift();
      if (this.tab === 'test' && this.open) this.renderLog();
    });
    app.ui.deskToggle = () => this.toggle();
    this.sync();
    this.setTab(this.tab);
    // каталог меняется (характер, «новое», дом, чипы кота) — перерисовка по ключу раз в 0,5 с
    setInterval(() => this.active && this.open && this.tab === 'skills' && this.renderSkills(), 500);
    (window as unknown as { __desk?: DeskPanel }).__desk = this;
  }

  get isOpen() {
    return this.active && this.open;
  }

  /** окно сузилось < 900 px — панели нет, приложение во всю ширину (и обратно) */
  private sync() {
    const on = deskActive(this.app.desktopView, innerWidth);
    this.active = on;
    this.app.ui.deskToggle = on ? () => this.toggle() : null;
    this.el.classList.toggle('off', !on || !this.open);
    this.tog.classList.toggle('hidden', !on || this.open);
    this.layout();
  }

  toggle(v = !this.open) {
    this.open = v;
    this.save();
    this.sync();
    if (v) this.setTab(this.tab);
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ open: this.open, tab: this.tab }));
    } catch {
      /* приватный режим */
    }
  }

  /** #app сужается на ширину панели: кот по центру оставшейся области (камера — App.resize) */
  private layout() {
    const root = this.app.root;
    const w = this.isOpen ? DESK_W : 0;
    root.style.right = w ? `${w}px` : '';
    document.documentElement.style.setProperty('--desk-w', `${w}px`);
    this.app.resize();
    this.app.ui.layoutBubble();
  }

  private setTab(t: 'skills' | 'test') {
    if (t === 'test' && !this.testAllowed) t = 'skills';
    this.tab = t;
    this.save();
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-dp-tab]')) {
      b.classList.toggle('on', b.dataset.dpTab === t);
      b.setAttribute('aria-selected', String(b.dataset.dpTab === t));
    }
    for (const p of this.el.querySelectorAll<HTMLElement>('.dp-pane')) p.classList.toggle('on', p.dataset.pane === t);
    if (t === 'skills') this.renderSkills(true);
    else this.renderTest();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.active) return;
    const k = deskHotkey(e, isText(document.activeElement) || isText(e.target as Element | null));
    if (!k) return;
    if (k.kind === 'escape') return;
    e.preventDefault();
    if (k.kind === 'toggle') return this.toggle();
    if (k.kind === 'search') {
      if (!this.open) this.toggle(true);
      this.setTab('skills');
      this.search.focus();
      this.search.select();
      return;
    }
    const chip = this.app.ui.lastChips[k.index];
    if (chip) {
      this.app.runChip(chip);
      this.flash(`[data-dp-chip="${k.index}"]`);
    }
  }

  private flash(sel: string) {
    const b = this.el.querySelector(sel);
    b?.classList.remove('tapped');
    void (b as HTMLElement | null)?.offsetWidth;
    b?.classList.add('tapped');
  }

  /** иконка как в каталоге (CAT_ICON и ICON ui.ts) */
  private ico(id: string) {
    return this.app.ui.catIcon(id) || this.app.ui.catIcon('star');
  }

  // ───────────── «Умения» ─────────────
  /** все группы каталога: ничего не теряется по сравнению с листом/лентой (тест catalogGroups) */
  groups(): CatalogGroup[] {
    return this.app.ui.catalogGroups();
  }

  private pick(it: CatalogItem) {
    const ui = this.app.ui;
    if (!('ui' in it.run)) ui.tried.mark(it.id);
    ui.recent.push(it.id);
    this.app.runCatalogItem(it);
    this.renderSkills(true);
    this.flash(`[data-item="${CSS.escape(it.id)}"]`);
  }

  private renderSkills(force = false) {
    const ui = this.app.ui;
    const groups = this.groups();
    const q = this.search.value;
    const chips = ui.lastChips;
    const key = [q, groups.map((g) => g.id + ':' + g.items.map((i) => i.id + (ui.tried.has(i.id) ? '+' : '') + i.label).join(',')).join('|'), chips.map((c) => c.id + c.label).join(',')].join('#');
    if (!force && key === this.key) return;
    this.key = key;
    // чипы кота: 1–9
    this.chipsEl.innerHTML = chips.length ? '<span class="dp-chips-t">Кот предлагает</span>' : '<span class="dp-chips-t dim">Кот пока ничего не предлагает</span>';
    chips.slice(0, 9).forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dp-chip';
      b.dataset.dpChip = String(i);
      b.title = `${c.label} — клавиша ${i + 1}`;
      b.innerHTML = `<kbd>${i + 1}</kbd><span class="dp-ico">${this.ico(c.icon)}</span><span></span>`;
      (b.lastElementChild as HTMLElement).textContent = c.label;
      b.onclick = () => this.app.runChip(c);
      this.chipsEl.appendChild(b);
    });
    // разделы
    const shown = filterGroups(groups, q);
    const first = q.trim() ? shown[0]?.items[0] : undefined;
    this.body.innerHTML = '';
    if (!shown.length) this.body.innerHTML = `<p class="dp-empty">Ничего не нашлось по «${esc(q)}»</p>`;
    for (const g of shown) {
      const sec = document.createElement('section');
      sec.className = 'dp-sec';
      sec.dataset.sec = g.id;
      const n = g.items.filter((i) => !('ui' in i.run)).length;
      const tried = g.items.filter((i) => !('ui' in i.run) && ui.tried.has(i.id)).length;
      sec.innerHTML = `<h3><span class="dp-ico">${this.ico(g.icon)}</span>${esc(g.title)}${n ? `<small title="попробовано ${tried} из ${n}">${tried}/${n}</small>` : ''}</h3><div class="dp-grid"></div>`;
      const grid = sec.querySelector('.dp-grid') as HTMLDivElement;
      for (const it of g.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dp-item';
        b.dataset.item = it.id;
        const kind = 'ui' in it.run ? 'ui' : 'say' in it.run ? 'say' : 'act';
        b.dataset.kind = kind;
        b.classList.toggle('new', kind !== 'ui' && !ui.tried.has(it.id));
        b.classList.toggle('first', it === first);
        b.title = `${it.label}${kind === 'say' ? ' — фраза голосом' : ''} · ${it.id}${it === first ? ' · Enter' : ''}`;
        b.innerHTML = `<span class="dp-ico">${this.ico(kind === 'say' ? 'chat' : it.icon)}</span><span class="dp-l"></span>`;
        (b.querySelector('.dp-l') as HTMLElement).textContent = it.label;
        b.onclick = () => this.pick(it);
        grid.appendChild(b);
      }
      this.body.appendChild(sec);
    }
    // десктоп-служебное: вид и звук (не умения кота — только в панели)
    if (!q.trim()) {
      const sec = document.createElement('section');
      sec.className = 'dp-sec dp-sec-tools';
      sec.innerHTML = '<h3>Вид и звук</h3><div class="dp-grid"></div>';
      const grid = sec.querySelector('.dp-grid') as HTMLDivElement;
      const tool = (label: string, title: string, fn: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dp-item dp-tool';
        b.title = title;
        b.textContent = label;
        b.onclick = fn;
        grid.appendChild(b);
      };
      tool('Сбросить вид', 'Поворот и зум — как было (R, двойной клик)', () => (window as unknown as { __orbit?: { reset(): void } }).__orbit?.reset());
      tool('Звук вкл/выкл', 'Как кнопка звука в доке', () => (this.app.ui.root.querySelector('[data-a="mute"]') as HTMLElement | null)?.click());
      this.body.appendChild(sec);
    }
  }

  // ───────────── «Тест» ─────────────
  private api(): CatApi | null {
    return (window as unknown as { __cat?: CatApi }).__cat ?? null;
  }
  private note(s: string) {
    this.app.director.log(`[тест] ${s}`);
  }

  private renderTest() {
    const app = this.app, d = app.director, api = this.api();
    const box = this.testBody;
    box.innerHTML = '';
    const sec = (title: string) => {
      const s = document.createElement('section');
      s.className = 'dp-sec';
      s.innerHTML = `<h3>${esc(title)}</h3><div class="dp-row"></div>`;
      box.appendChild(s);
      return s.querySelector('.dp-row') as HTMLDivElement;
    };
    const btn = (row: HTMLElement, label: string, fn: () => void, title = '', on = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dp-btn' + (on ? ' on' : '');
      b.textContent = label;
      if (title) b.title = title;
      b.onclick = () => {
        fn();
        setTimeout(() => this.tab === 'test' && this.renderTestHead(), 50);
      };
      row.appendChild(b);
      return b;
    };

    const head = document.createElement('div');
    head.className = 'dp-state';
    box.appendChild(head);

    let row = sec('Характер');
    for (const id of PERSONA_IDS) btn(row, d.personas.get(id)?.name ?? id, () => (api ? api.persona(id) : d.setPersona(id)), `setPersona('${id}')`, d.personas.id === id);

    row = sec('Состояния');
    btn(row, 'Дрёма', () => d.flow('doze'), "flow('doze') — как после 110 с тишины");
    btn(row, 'Мне грустно', () => d.flow('sad'), "flow('sad')");
    btn(row, 'Карта потеряна', () => d.dispatch({ type: 'card_lost' }), 'событие card_lost');
    btn(row, 'Карта найдена', () => d.dispatch({ type: 'card_found' }), 'событие card_found');
    btn(row, 'Перелокализация', () => {
      d.dispatch({ type: 'card_lost' });
      (app.tracker as unknown as { reanchor?: () => void }).reanchor?.();
      setTimeout(() => d.dispatch({ type: 'card_found' }), 1500);
    }, 'потеря → через 1,5 с снова найдена');
    btn(row, 'Давай другого', () => d.flow('switch'), "flow('switch')");
    btn(row, 'Outro', () => d.flow('outro'), "flow('outro')");
    for (const f of ['riddle', 'echo', 'emo', 'rps', 'simon']) if (feature('games.new') || f === 'riddle' || f === 'echo') btn(row, f, () => d.flow(f), `flow('${f}')`);

    if (feature('home')) {
      row = sec('Дом');
      const home = app.home;
      btn(row, home.phase === 'home' ? 'На карту' : 'Домой', () => void home.act(home.phase === 'home' ? 'home:back' : 'home:go'), 'home:go / home:back');
      for (const z of ZONES)
        btn(row, z.title, () => {
          if (home.phase === 'home') home.go(z.id);
          else {
            home.enter('test');
            const t0 = performance.now();
            const wait = setInterval(() => {
              if (home.phase === 'home' || performance.now() - t0 > 8000) {
                clearInterval(wait);
                home.go(z.id);
              }
            }, 250);
          }
        }, `зона ${z.id}`, home.phase === 'home' && home.zone === z.id);
    }

    row = sec('Микрофон');
    const mode = app.engine.mode;
    btn(row, mode === 'auto' ? 'Слушает всегда → по кнопке' : 'По кнопке → слушать всегда', () => app.runCatalogItem({ id: 'ui:micmode', label: '', icon: 'mic', run: { ui: 'micmode' } }), 'режим микрофона');

    row = sec('Эмоция лица');
    for (const f of FACE_IDS)
      btn(row, f, () => {
        const ch = app.character as unknown as { setEmotion?: (n: string, w: number, ms: number) => void; face(p: string, ms?: number): void };
        if (ch.setEmotion) ch.setEmotion(f, 1, 2500);
        else ch.face(f, 2500);
        this.note(`эмоция ${f}`);
      }, `content/face.json: ${f}`);

    // события и реплики: поиск
    const s = document.createElement('section');
    s.className = 'dp-sec';
    s.innerHTML = '<h3>Событие · реплика</h3>';
    const inp = document.createElement('input');
    inp.type = 'search';
    inp.className = 'dp-input';
    inp.placeholder = 'id события или реплики, текст…';
    inp.spellcheck = false;
    const list = document.createElement('div');
    list.className = 'dp-list';
    s.append(inp, list);
    box.appendChild(s);
    const fill = () => {
      const q = inp.value.trim().toLowerCase().replace(/ё/g, 'е');
      const events = api?.events() ?? [];
      const lines = PERSONA_IDS.flatMap((p) => api?.lines(p) ?? []);
      const m = (t: string) => !q || t.toLowerCase().replace(/ё/g, 'е').includes(q);
      const ev = events.filter(m).slice(0, 40);
      const ls = lines.filter((l) => m(l.id) || m(l.text)).slice(0, q ? 60 : 20);
      list.innerHTML = '';
      for (const e of ev) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dp-li ev';
        const voiced = d.hasVoiced(e);
        b.innerHTML = `<b>▶ ${esc(e)}</b><i class="${voiced ? 'ok' : 'no'}">${voiced ? 'озвучено' : 'без записи'}</i>`;
        b.title = `событие ${e} активным характером (без cooldown)`;
        b.onclick = () => {
          const ok = api ? api.event(e) : d.playEvent(e);
          this.note(`событие ${e} → ${ok ? 'в очереди' : 'не выбрано'}`);
        };
        list.appendChild(b);
      }
      for (const l of ls) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dp-li';
        b.innerHTML = `<b>${esc(l.id)}</b><span>${esc(l.text)}</span>`;
        b.title = `реплика ${l.id} (${l.emotion})`;
        b.onclick = () => {
          const ok = api ? api.say(l.id) : d.sayLine(l.id);
          this.note(`реплика ${l.id} → ${ok ? 'в очереди' : 'нет'}`);
        };
        list.appendChild(b);
      }
      if (!ev.length && !ls.length) list.innerHTML = '<p class="dp-empty">Ничего не нашлось</p>';
    };
    inp.addEventListener('input', fill);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (list.querySelector('.dp-li') as HTMLElement | null)?.click();
    });
    fill();

    // текст за ребёнка
    const ts = document.createElement('section');
    ts.className = 'dp-sec';
    ts.innerHTML = '<h3>Сказать за ребёнка</h3>';
    const ti = document.createElement('input');
    ti.className = 'dp-input';
    ti.placeholder = 'фраза + Enter (как голосом)';
    ti.onkeydown = (e) => {
      if (e.key === 'Enter' && ti.value.trim()) {
        app.engine.handleText(ti.value.trim(), 'chip');
        ti.value = '';
      }
    };
    ts.appendChild(ti);
    box.appendChild(ts);

    const lg = document.createElement('section');
    lg.className = 'dp-sec';
    lg.innerHTML = '<h3>Лог (20 строк): событие → реплика → прозвучала?</h3><div class="dp-log" aria-live="polite"></div>';
    box.appendChild(lg);
    this.renderTestHead();
    this.renderLog();
  }

  private renderTestHead() {
    const head = this.testBody.querySelector('.dp-state');
    if (!head) return;
    const d = this.app.director, st = d.state;
    head.textContent = `${d.persona.name} · фаза ${st.phase}${st.dialog ? ` · диалог ${st.dialog.id}/${st.dialog.node}` : ''}${d.dozing ? ' · дремлет' : ''} · микрофон ${this.app.engine.mode === 'auto' ? 'всегда' : 'по кнопке'} · дом ${this.app.home?.phase ?? '—'}`;
    for (const b of this.testBody.querySelectorAll<HTMLElement>('.dp-sec:nth-of-type(1) .dp-btn')) b.classList.toggle('on', b.title === `setPersona('${d.personas.id}')`);
  }

  private renderLog() {
    const el = this.testBody.querySelector('.dp-log');
    if (!el) return;
    el.innerHTML = this.logLines
      .map((l) => {
        const cls = /^🗨/.test(l) ? 'said' : /🔇|не выбрана|отброшена|не озвучена/.test(l) ? 'mute' : /^\[тест\]/.test(l) ? 'test' : '';
        return `<div class="${cls}">${esc(l)}</div>`;
      })
      .join('');
    el.scrollTop = 1e9;
    this.renderTestHead();
  }
}

const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
