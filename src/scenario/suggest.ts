/**
 * Чипы-предложения ОТ КОТА над нижними кнопками (вариант А «Кот подсказывает», docs/UI_AUDIT.md, «Упрощённый экран»).
 * Не больше двух, контекстные и меняющиеся: что кот предлагает прямо сейчас — по состоянию режиссёра
 * (мини-игра, эмоция, дрёма, лестница тишины) и по тому, что ребёнок ещё не пробовал из каталога.
 * Плюс подсказка «что делать» — только в первые визиты или после долгой тишины. Не пузырём (немых пузырей нет):
 * app.ts говорит её озвученной репликой кота (событие help) или показывает пальцем на чип.
 * Чистая логика без DOM: снимок состояния → { chips, hint }. Рисует ui.ts, снимок собирает app.ts.
 */
import type { ActionId } from './actions';

export type ChipRun = { action: ActionId } | { say: string };
export interface Chip {
  /** ключ чипа (перерисовка — только когда набор ключей сменился) */
  id: string;
  label: string;
  /** иконка: ключ ICON (ui.ts) или CAT_ICON (catalogIcons.ts) */
  icon: string;
  run: ChipRun;
}

/** что видно в каталоге у текущего характера: id действия → подпись и иконка (по эффекту характера) */
export type Available = ReadonlyMap<string, { label: string; icon: string }>;

export interface SuggestSnapshot {
  now: number;
  phase: string;
  appeared: boolean;
  /** диалог сценария: id, узел, ждёт ли ответа, какие ответы узел понимает (on: yes / no / right …) */
  dialog: { id: string; node: string; listening: boolean; expect: readonly string[] } | null;
  /** идёт мини-игра с вариантами ответа (Director.gameChoices: угадай эмоцию, камень-ножницы-бумага…) */
  game?: { id: string; options: readonly { id: string; label: string }[] } | null;
  /** поддержка (грустно/страшно): игра на паузе */
  paused: boolean;
  dozing: boolean;
  /** кот говорит или в очереди есть реплика */
  speaking: boolean;
  /** сколько длится тишина (лестница тишины режиссёра) */
  quietMs: number;
  visits: number;
  available: Available;
  tried: (id: string) => boolean;
  /** у события есть живая озвучка (Director.hasVoiced): новые игры кот предлагает, только когда их начало озвучено */
  voiced?: (event: string) => boolean;
}

export interface Suggestion {
  chips: Chip[];
  /** подсказка «что делать» (текст — для лога и диктора; на экран — голосом кота или пальцем, не пузырём) */
  hint: string | null;
  /** подсказка первых визитов (короткая пауза): её кот говорит голосом */
  hintFirst?: boolean;
}

export const MAX_CHIPS = 2;
/** варианты ответа мини-игры (камень-ножницы-бумага — 3, эмоции — 6): это ответы, а не предложения кота */
export const MAX_GAME_CHOICES = 6;
/** игры, которые кот предлагает только с озвученным началом (событие <id>_start) */
export const VOICE_GATED: Record<string, string> = { rps: 'rps_start', emo: 'emo_start', simon: 'simon_start' };
/** «первые минуты»: пока ребёнок не погладил кота — «Погладь меня» */
export const FIRST_MINUTES_MS = 120_000;
/** после загадки — «Ещё загадку» столько мс */
export const AFTER_GAME_MS = 25_000;
/** кот обиделся (тычки, тряска) — «Обнять» столько мс */
export const UPSET_MS = 20_000;
/** подсказка в пузыре: в первые визиты — после короткой паузы, потом — только после долгой тишины */
export const HINT_FIRST_MS = 8_000;
export const HINT_LONG_MS = 45_000;
export const HINT_SHOW_MS = 7_000;
/** «первый визит» — пока визитов не больше стольких и игра идёт меньше FIRST_VISIT_PLAY_MS */
export const FIRST_VISITS = 2;
export const FIRST_VISIT_PLAY_MS = 180_000;

/** мини-игры: их кот предлагает первыми (новых игр может не быть у характера/в сборке — фильтр по каталогу) */
const GAMES: string[] = ['riddle', 'dance', 'echo', 'rps', 'emo', 'simon'];
/** что ещё кот может предложить (по порядку — от самого «вау» к редкому) */
const POOL: string[] = ['treat', 'tickle', 'flip', 'trick', 'sing', 'bubbles', 'sticker', 'jump', 'draw', 'laugh', 'hug', 'wave', 'scratch', 'paw', 'knock', 'glass', 'surprise', 'dizzy', 'other'];
/** подписи от лица кота (где подпись каталога звучит не как предложение) */
const LABEL: Record<string, string> = { pet: 'Погладь меня', tickle: 'Пощекочи', treat: 'Угости меня', hug: 'Обними', flip: 'Сальто', sing: 'Песенка' };
/** как это сказать голосом (для подсказки в пузыре) */
export const VOICE: Record<string, string> = {
  riddle: 'загадай загадку', dance: 'танцуй', rps: 'камень ножницы бумага', emo: 'угадай эмоцию', simon: 'повтори движение', echo: 'повторяй за мной', flip: 'сделай сальто', sing: 'спой песенку', jump: 'прыгни',
  laugh: 'пошути', wave: 'помаши лапой', sticker: 'наклейку', bubbles: 'надуй пузырь', other: 'давай другого',
};
const ICON_FALLBACK: Record<string, string> = { pet: 'hand', riddle: 'quest', dance: 'note', echo: 'parrot', hug: 'heart', treat: 'fish' };

const say = (id: string, label: string, icon: string, text: string): Chip => ({ id, label, icon, run: { say: text } });

export class Suggester {
  /** последние действия ребёнка (новые в начале): их кот не предлагает сразу снова */
  private recent: string[] = [];
  private prevDialog: string | null = null;
  private lastGame: { id: 'riddle' | 'echo'; at: number } | null = null;
  private upsetUntil = -1e9;
  private playStartedAt = -1;
  private last: Chip[] = [];
  /** подсказка: когда показали в этой тишине (-1 — ещё нет) и сколько длилась тишина на прошлом шаге */
  private hintAt = -1;
  private prevQuiet = 0;

  /** markTried — игра началась голосом/сама (загадка, повторялка): точка «новое» в каталоге гаснет */
  constructor(private markTried: (id: string) => void = () => {}) {}

  /** ребёнок что-то сделал кнопкой/чипом/каталогом */
  note(id: string) {
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, 3);
  }
  /** кот обиделся/закружился (тычки подряд, сильный тычок, тряска) */
  upset(now: number) {
    this.upsetUntil = now + UPSET_MS;
  }

  update(s: SuggestSnapshot): Suggestion {
    const playing = (s.phase === 'play' || s.phase === 'free') && s.appeared;
    if (playing && this.playStartedAt < 0) this.playStartedAt = s.now;
    // мини-игра началась / закончилась
    const d = s.dialog?.id ?? null;
    if (d !== this.prevDialog) {
      if (d && GAMES.includes(d)) {
        this.note(d);
        this.markTried(d);
      }
      if ((this.prevDialog === 'riddle' || this.prevDialog === 'echo') && d === null) this.lastGame = { id: this.prevDialog, at: s.now };
      this.prevDialog = d;
    }
    if (!playing) {
      this.last = [];
      return { chips: [], hint: null };
    }
    const chips = this.chips(s);
    this.last = chips;
    const hint = this.hint(s, chips);
    return { chips, hint, hintFirst: !!hint && this.firstVisit(s) };
  }

  private chip(s: SuggestSnapshot, id: string, label?: string): Chip | null {
    const a = s.available.get(id);
    if (!a) return null;
    if (VOICE_GATED[id] && !(s.voiced?.(VOICE_GATED[id]) ?? false)) return null;
    return { id, label: label ?? LABEL[id] ?? a.label, icon: a.icon || ICON_FALLBACK[id] || 'star', run: { action: id as ActionId } };
  }
  private pick(list: (Chip | null)[]): Chip[] {
    const out: Chip[] = [];
    for (const c of list) if (c && !out.some((o) => o.id === c.id) && out.length < MAX_CHIPS) out.push(c);
    return out;
  }

  private chips(s: SuggestSnapshot): Chip[] {
    const dlg = s.dialog;
    // мини-игра с вариантами: варианты ответа (нажатие — как будто сказали)
    if (s.game?.options.length)
      return s.game.options.slice(0, MAX_GAME_CHOICES).map((o) => say(`game:${s.game!.id}:${o.id}`, o.label, o.id, o.label));
    // загадка / повторялка / вопрос кота: ответы на него
    if (dlg) {
      // кот договаривает узел диалога — чипы не прыгают
      if (!dlg.listening) return this.last;
      const ex = new Set(dlg.expect);
      if (dlg.id === 'riddle' && ex.has('right')) return [say('giveup', 'Сдаюсь', 'flag', 'сдаюсь')];
      if (dlg.id === 'riddle') return this.pick([say('more_riddle', 'Ещё загадку', 'quest', 'ещё загадку'), this.chip(s, 'echo')]);
      if (dlg.id === 'echo') return [say('echo_stop', 'Хватит', 'stop', 'хватит')];
      if (ex.has('yes') && ex.has('no'))
        return dlg.id === 'offer'
          ? [say('yes', 'Давай!', 'yes', 'давай'), say('no', 'Не хочу', 'no', 'не хочу')]
          : dlg.id === 'switch'
            ? [say('yes', 'Давай!', 'swap', 'давай'), say('no', 'Не надо', 'no', 'не надо')]
            : [say('yes', 'Да', 'yes', 'да'), say('no', 'Нет', 'no', 'нет')];
      return this.last;
    }
    // кот дремлет — разбудить
    if (s.dozing) return this.pick([this.chip(s, 'pet', 'Разбуди меня')]);
    // ребёнку грустно (поддержка) — кот рядом
    if (s.paused) return this.pick([this.chip(s, 'hug'), this.chip(s, 'pet')]);
    // кот обиделся — помириться
    if (s.now < this.upsetUntil) return this.pick([this.chip(s, 'hug'), this.chip(s, 'treat'), this.chip(s, 'pet')]);
    // только что отгадывали — ещё?
    const g = this.lastGame;
    if (g && s.now - g.at < AFTER_GAME_MS && g.id === 'riddle') return this.pick([this.chip(s, 'riddle', 'Ещё загадку'), this.chip(s, 'echo'), ...this.fresh(s)]);
    // первые минуты: погладить
    if (s.now - this.playStartedAt < FIRST_MINUTES_MS && !s.tried('pet')) return this.pick([this.chip(s, 'pet'), ...this.games(s)]);
    return this.defaults(s);
  }

  /** игры, которых не было только что */
  private games(s: SuggestSnapshot): Chip[] {
    return GAMES.filter((id) => !this.recent.includes(id)).map((id) => this.chip(s, id)).filter((c): c is Chip => !!c);
  }
  /** чего ребёнок ещё не пробовал */
  private fresh(s: SuggestSnapshot): Chip[] {
    return POOL.filter((id) => !s.tried(id) && !this.recent.includes(id)).map((id) => this.chip(s, id)).filter((c): c is Chip => !!c);
  }
  /** обычная игра: игра (не та, что только что) + непробованное; всё пробовали — то, чего не было недавно */
  private defaults(s: SuggestSnapshot): Chip[] {
    const games = this.games(s);
    const fresh = this.fresh(s);
    const second = games[1] && !s.tried(games[1].id) ? games[1] : fresh[0] ?? games[1];
    const rest = POOL.filter((id) => !this.recent.includes(id)).map((id) => this.chip(s, id));
    return this.pick([games[0] ?? fresh[0] ?? null, second ?? null, ...fresh, ...rest]);
  }

  private firstVisit(s: SuggestSnapshot) {
    return s.visits <= FIRST_VISITS && s.now - this.playStartedAt < FIRST_VISIT_PLAY_MS;
  }
  private hint(s: SuggestSnapshot, chips: Chip[]): string | null {
    // тишина оборвалась (ребёнок что-то сделал) — подсказку можно показать снова в следующей тишине
    if (s.quietMs < this.prevQuiet) this.hintAt = -1;
    this.prevQuiet = s.quietMs;
    if (s.dialog || s.speaking || s.paused || s.dozing || !chips.length) return null;
    const first = this.firstVisit(s);
    if (s.quietMs < (first ? HINT_FIRST_MS : HINT_LONG_MS)) return null;
    if (this.hintAt < 0) this.hintAt = s.now;
    if (s.now - this.hintAt > HINT_SHOW_MS) return null;
    return hintText(chips, s.tried('pet'));
  }
}

/** короткая подсказка от кота: что сделать пальцем и что сказать */
export function hintText(chips: Chip[], petTried: boolean): string {
  const voice = chips.map((c) => ('action' in c.run ? VOICE[c.run.action] : c.run.say)).find(Boolean);
  if (!petTried) return 'Погладь меня или скажи «танцуй»';
  if (voice) return `Скажи мне «${voice}»`;
  return `Нажми «${chips[0].label}» внизу`;
}
