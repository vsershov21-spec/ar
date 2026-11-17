/**
 * Интерфейс: стартовый экран, поиск карты, пузырь реплик, нижний док (звук · микрофон · подсказки),
 * листы «Как тебя зовут?» и «Каким мне быть?», кнопки СберKids / «Сдёрнуть наклейки», тосты, экран ошибки.
 * Стили и дизайн-токены — styles.css; правила — docs/UI_AUDIT.md.
 */
import { asset } from '../core/util';

export interface UiHandlers {
  onWake(): void;
  onMicDown(): void;
  onMicUp(): void;
  onChip(text: string): void;
  onName(name: string): void;
  onSkipName(): void;
  onShakeButton(): void;
  onKids(): void;
  onMute(m: boolean): void;
  /** «слушаю всегда» ↔ «по кнопке» */
  onMicMode(m: 'auto' | 'ptt'): void;
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

export const CHIPS = ['Привет!', 'Сделай сальто', 'Загадай загадку', 'Танцуй', 'Сколько у меня денег?', 'Давай другого'];

/** превью, подпись и цвет характера в листе выбора (цвета — из палитры персонажа, если она есть) */
const PERSONA_UI: Record<string, { img: string; tagline: string; color: string; soft: string }> = {
  hooligan: { img: 'video/sprites/hooligan/turn_front.webp', tagline: 'Дерзкий и смешной', color: '#7cc61d', soft: '#e9f8cf' },
  kind: { img: 'video/sprites/kind/turn_front.webp', tagline: 'Тёплый и заботливый', color: '#f08a4b', soft: '#fde9da' },
  glitter: { img: 'video/sprites/glitter/pose_wave.webp', tagline: 'Яркая и с блёстками', color: '#9a7be8', soft: '#efe8fd' },
};

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" stroke="none"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  hints: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16v10H10l-4.5 4v-4H4z"/><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" stroke-width="3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
  cam: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h3.5l2-2.5h7l2 2.5H21v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  paw: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><ellipse cx="12" cy="16" rx="5" ry="4.2"/><ellipse cx="5.5" cy="10.5" rx="2.1" ry="2.6"/><ellipse cx="9.5" cy="6.5" rx="2.1" ry="2.7"/><ellipse cx="14.5" cy="6.5" rx="2.1" ry="2.7"/><ellipse cx="18.5" cy="10.5" rx="2.1" ry="2.6"/></svg>',
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
  private micMode!: HTMLButtonElement;
  private micModeNow: 'auto' | 'ptt' = 'auto';
  private dock: HTMLDivElement;
  private hintsBtn: HTMLButtonElement;
  private kids: HTMLButtonElement;
  private shakeBtn: HTMLButtonElement;
  private namebox: HTMLDivElement;
  private choice: HTMLDivElement;
  private bubbleTimer = 0;
  private hintTimer = 0;
  private muted = false;
  private listening = false;
  private chipsByScenario = false;
  private chipsByUser = false;
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
          <section class="ob-slide" aria-label="Шаг 1 из 3">
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
          <section class="ob-slide" aria-label="Шаг 2 из 3">
            <div class="ob-art art-table" aria-hidden="true">
              <div class="tbl"></div>
              <div class="tc-shadow"></div>
              <div class="tc"><div class="kc-chip"></div><div class="kc-logo">СБЕР KIDS</div></div>
            </div>
            <div class="screen-text"><h1>Положи карту на&nbsp;стол</h1><p>Подойдёт любая карта Сбера. На&nbsp;столе с&nbsp;рисунком другу будет проще держаться.</p></div>
          </section>
          <section class="ob-slide" aria-label="Шаг 3 из 3">
            <div class="ob-art art-phone" aria-hidden="true">
              <div class="ph"><div class="ph-scr"><div class="ph-tbl"></div><div class="ph-card"></div><div class="ph-frame"></div></div><div class="ph-notch"></div></div>
              <div class="ph-perm">${ICON.cam}<span>Разрешить камеру</span></div>
            </div>
            <div class="screen-text"><h1>Разреши камеру и&nbsp;наведи на&nbsp;карту</h1><p>Дальше твой новый друг сам всё расскажет и&nbsp;покажет!</p></div>
          </section>
        </div>
        <div class="ob-foot">
          <div class="ob-dots" aria-hidden="true"><i class="on"></i><i></i><i></i></div>
          <button class="btn btn-primary btn-block ob-next" data-a="ob-next" type="button">Познакомиться</button>
          <button class="btn btn-primary btn-block ob-wake hidden" data-a="wake" type="button">${ICON.cam}<span>Открыть камеру</span></button>
          <div class="fine">${ICON.lock}<span>Видео и голос остаются в телефоне и никуда не отправляются. Микрофон спросим отдельно.</span></div>
        </div>
      </div>
      <div class="scan hidden"><span>${ICON.paw}<em>Наведи камеру на карту</em></span></div>
      <div class="bubble" role="status" aria-live="polite"><span class="who"></span><span class="txt"></span></div>
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
        <button class="btn btn-light shakebtn hidden" data-a="shake">Сдёрнуть наклейки</button>
        <div class="chips hidden"></div>
        <div class="mic-hint" aria-live="polite"></div>
      </div>
      <div class="dock no-mic">
        <button class="iconbtn side-l" data-a="mute" aria-label="Выключить звук">${ICON.sound}</button>
        <div class="mic-slot"><button class="mic-mode" type="button" aria-label="Режим микрофона"></button><button class="mic hidden" aria-label="Держи и говори">${ICON.mic}</button></div>
        <button class="iconbtn side-r" data-a="hints" aria-label="Подсказки" aria-pressed="false">${ICON.hints}</button>
      </div>`;
    parent.appendChild(root);
    this.root = root;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.start = q('.start');
    this.scan = q('.scan');
    this.bubble = q('.bubble');
    this.chips = q('.chips');
    this.mic = q('.mic');
    this.micMode = q('.mic-mode');
    this.micMode.addEventListener('click', () => h.onMicMode(this.micModeNow === 'auto' ? 'ptt' : 'auto'));
    this.micHint = q('.mic-hint');
    this.dock = q('.dock');
    this.hintsBtn = q('[data-a="hints"]');
    this.kids = q('.kids');
    this.shakeBtn = q('.shakebtn');
    this.namebox = q('.namebox');
    this.choice = q('.choice-sheet');

    for (const t of CHIPS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = t;
      b.onclick = () => h.onChip(t);
      this.chips.appendChild(b);
    }
    root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      const a = btn?.getAttribute('data-a');
      if (a === 'wake') h.onWake();
      if (a === 'ob-next') this.obGo(this.obStep + 1);
      if (a === 'kids') h.onKids();
      if (a === 'shake') h.onShakeButton();
      if (a === 'skip') h.onSkipName();
      if (a === 'reload') location.reload();
      if (a === 'mute') {
        this.muted = !this.muted;
        btn!.innerHTML = this.muted ? ICON.muted : ICON.sound;
        btn!.classList.toggle('on', this.muted);
        btn!.setAttribute('aria-label', this.muted ? 'Включить звук' : 'Выключить звук');
        h.onMute(this.muted);
      }
      if (a === 'hints') {
        const on = !(this.chipsByScenario || this.chipsByUser);
        this.chipsByUser = on;
        if (!on) this.chipsByScenario = false;
        this.syncChips();
      }
    });
    q<HTMLFormElement>('.name-row').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitName();
    });
    // «держи и говори»
    const down = (e: Event) => {
      e.preventDefault();
      this.mic.classList.add('on');
      h.onMicDown();
    };
    const up = (e: Event) => {
      e.preventDefault();
      if (!this.mic.classList.contains('on')) return;
      this.mic.classList.remove('on');
      h.onMicUp();
    };
    this.mic.addEventListener('pointerdown', down);
    this.mic.addEventListener('pointerup', up);
    this.mic.addEventListener('pointercancel', up);
    this.mic.addEventListener('pointerleave', up);
    this.mic.addEventListener('contextmenu', (e) => e.preventDefault());
    if (!opts.micSupported) this.mic.dataset.unsupported = '1';
    this.watchKeyboard();
    this.obSwipe();
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

  /** онбординг: три шага, свайп и кнопка «дальше»; на последнем — «Открыть камеру» (жест для iOS) */
  private obStep = 0;
  private obGo(i: number) {
    const n = 3;
    i = Math.max(0, Math.min(n - 1, i));
    this.obStep = i;
    this.start.dataset.step = String(i);
    (this.start.querySelector('.ob-track') as HTMLElement).style.transform = `translateX(${-i * 100}%)`;
    this.start.querySelectorAll('.ob-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    const next = this.start.querySelector('.ob-next') as HTMLElement;
    next.textContent = ['Познакомиться', 'Готово, лежит', ''][i];
    next.classList.toggle('hidden', i === n - 1);
    this.start.querySelector('.ob-wake')!.classList.toggle('hidden', i !== n - 1);
  }
  private obSwipe() {
    let x0 = 0, y0 = 0, on = false;
    this.start.addEventListener('pointerdown', (e) => ((x0 = e.clientX), (y0 = e.clientY), (on = true)));
    this.start.addEventListener('pointerup', (e) => {
      if (!on) return;
      on = false;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.obGo(this.obStep + (dx < 0 ? 1 : -1));
    });
  }

  hideStart() {
    this.start.classList.add('leaving');
    setTimeout(() => this.start.classList.add('hidden'), 300);
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
      if (!v) this.chipsByUser = false;
      this.syncChips();
      return;
    }
    const el = { scan_hint: this.scan, name_prompt: this.namebox, sberkids: this.kids, shake_button: this.shakeBtn, mic: this.mic }[what];
    if (what === 'mic' && this.mic.dataset.unsupported) v = false;
    el.classList.toggle('hidden', !v);
    if (what === 'mic') this.dock.classList.toggle('no-mic', !v);
    if (what === 'name_prompt' && !v) this.root.classList.remove('kb');
    this.layoutBubble();
  }
  private syncChips() {
    const on = this.chipsByScenario || this.chipsByUser;
    this.chips.classList.toggle('hidden', !on);
    this.hintsBtn.classList.toggle('on', on);
    this.hintsBtn.setAttribute('aria-pressed', String(on));
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
    (this.bubble.querySelector('.who') as HTMLElement).textContent = who;
    (this.bubble.querySelector('.txt') as HTMLElement).textContent = text;
    this.bubble.className = `bubble show ${personaId}`;
    this.layoutBubble();
    this.followCat();
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble.classList.remove('show'), ms || 2200 + text.length * 55);
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
      if (now - t > 120) {
        t = now;
        this.layoutBubble();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** пузырь сверху с хвостиком к голове; если сверху не помещается — сбоку от головы, на свободной стороне */
  layoutBubble() {
    const b = this.bubble;
    if (!b.classList.contains('show')) return;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const cat = this.catRect();
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

  /** режим микрофона: в «слушаю всегда» кнопка — для перебивания и как «держи и говори» */
  setMicMode(m: 'auto' | 'ptt') {
    this.micModeNow = m;
    this.micMode.textContent = m === 'auto' ? 'Слушаю всегда' : 'По кнопке';
    this.micMode.classList.toggle('auto', m === 'auto');
    this.micMode.setAttribute('aria-pressed', String(m === 'auto'));
    this.mic.classList.toggle('auto', m === 'auto');
    this.mic.setAttribute('aria-label', m === 'auto' ? 'Кот слушает. Можно нажать и говорить' : 'Держи и говори');
  }

  micLevel(v: number) {
    this.mic.style.setProperty('--lvl', String(v));
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
    if (tone === 'warn' && !this.hintsBtn.classList.contains('on')) {
      this.hintsBtn.classList.remove('attn');
      void this.hintsBtn.offsetWidth;
      this.hintsBtn.classList.add('attn');
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
