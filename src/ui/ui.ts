/** Интерфейс: стартовый экран, подсказка карты, субтитры, микрофон, чипы, СберKids. */
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
}

export const CHIPS = ['Привет!', 'Сделай сальто', 'Загадай загадку', 'Танцуй', 'Сколько у меня денег?', 'Давай другого'];

export class UI {
  readonly root: HTMLDivElement;
  private start: HTMLDivElement;
  private scan: HTMLDivElement;
  private bubble: HTMLDivElement;
  private chips: HTMLDivElement;
  private mic: HTMLButtonElement;
  private micHint: HTMLDivElement;
  private kids: HTMLButtonElement;
  private shakeBtn: HTMLButtonElement;
  private namebox: HTMLDivElement;
  private bubbleTimer = 0;
  private muted = false;

  constructor(parent: HTMLElement, private h: UiHandlers, opts: { micSupported: boolean; posterUrl?: string }) {
    const root = document.createElement('div');
    root.className = 'ui';
    root.innerHTML = `
      <div class="start">
        <div class="card">
          <div class="cat">${opts.posterUrl ? `<img src="${opts.posterUrl}" alt="">` : '🐱'}</div>
          <h1>Кот спит в твоей карте</h1>
          <p>Положи карту на стол, нажми кнопку и наведи на неё камеру.</p>
          <button class="btn btn-primary" data-a="wake">Разбудить кота</button>
          <small>Нужен доступ к камере. Микрофон спросим, только если захочешь поговорить. Голос и видео никуда не сохраняются.</small>
        </div>
      </div>
      <div class="scan hidden"><span>Наведи камеру на карту</span></div>
      <div class="bubble"><span class="who"></span><span class="txt"></span></div>
      <div class="topbar"><button class="iconbtn" data-a="mute" aria-label="Звук">🔊</button></div>
      <div class="bottom">
        <div class="namebox hidden">
          <input type="text" maxlength="20" placeholder="Твоё имя" enterkeyhint="done" autocomplete="off" />
          <button class="ok" data-a="name">OK</button><button class="skip" data-a="skip">Пропустить</button>
        </div>
        <div class="chips hidden"></div>
        <button class="btn kids hidden" data-a="kids">В СберKids →</button>
        <button class="btn shakebtn hidden" data-a="shake">Сдёрнуть наклейки</button>
        <div class="row"><button class="mic hidden" aria-label="Держи и говори">🎤</button></div>
        <div class="mic-hint"></div>
      </div>`;
    parent.appendChild(root);
    this.root = root;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.start = q('.start');
    this.scan = q('.scan');
    this.bubble = q('.bubble');
    this.chips = q('.chips');
    this.mic = q('.mic');
    this.micHint = q('.mic-hint');
    this.kids = q('.kids');
    this.shakeBtn = q('.shakebtn');
    this.namebox = q('.namebox');

    for (const t of CHIPS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = t;
      b.onclick = () => h.onChip(t);
      this.chips.appendChild(b);
    }
    root.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
      if (a === 'wake') h.onWake();
      if (a === 'kids') h.onKids();
      if (a === 'shake') h.onShakeButton();
      if (a === 'skip') h.onSkipName();
      if (a === 'name') this.submitName();
      if (a === 'mute') {
        this.muted = !this.muted;
        (e.target as HTMLElement).textContent = this.muted ? '🔇' : '🔊';
        h.onMute(this.muted);
      }
    });
    q<HTMLInputElement>('.namebox input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitName();
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
    if (!opts.micSupported) this.mic.dataset.unsupported = '1';
  }

  private submitName() {
    const inp = this.root.querySelector('.namebox input') as HTMLInputElement;
    const v = inp.value.trim();
    inp.blur();
    if (v) this.h.onName(v);
  }

  hideStart() {
    this.start.classList.add('hidden');
  }
  setStartBusy(text: string) {
    const b = this.start.querySelector('button') as HTMLButtonElement;
    b.textContent = text;
    b.disabled = true;
  }
  show(what: 'scan_hint' | 'name_prompt' | 'chips' | 'sberkids' | 'shake_button' | 'mic', v: boolean) {
    const el = { scan_hint: this.scan, name_prompt: this.namebox, chips: this.chips, sberkids: this.kids, shake_button: this.shakeBtn, mic: this.mic }[what];
    if (what === 'mic' && this.mic.dataset.unsupported) v = false;
    el.classList.toggle('hidden', !v);
  }
  say(text: string, who: string, personaId: string, ms = 0) {
    (this.bubble.querySelector('.who') as HTMLElement).textContent = who;
    (this.bubble.querySelector('.txt') as HTMLElement).textContent = text;
    this.bubble.className = `bubble show ${personaId}`;
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble.classList.remove('show'), ms || 2200 + text.length * 55);
  }
  micHintText(t: string) {
    this.micHint.textContent = t;
  }
  toast(text: string, ms = 4000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
}

export const posterUrl = () => asset('video/sprites/hooligan/wave.webp');
