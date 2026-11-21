/**
 * Кулдаун смены кота пилота (pilot.switchCooldown, config/pilot.ts SwitchCooldown) — подключение к режиссёру одним
 * местом (app.ts applyEdition и тест tests/catSwitch.test.ts — одно и то же):
 *   • «Другой кот» / «давай другого» раньше срока — «Чуть позже! Давай ещё немного поиграем со мной.» пузырём с голосом
 *     (запись pilot_switch_later, director.voicedBubble; пока mp3 нет на сервере — немой пузырь «Чуть позже! Другой кот —
 *     через N мин»); кнопкой — каждый раз, когда пузыря нет на экране; голосом — не чаще раза в 8 с; без вопроса
 *     «Хочешь, я стану другим?». Срок — таймером на кнопке «Другой кот» (app.ts syncSwitchWait);
 *   • кулдаун тратится, когда экран заклеен (смена началась), и возвращается, если смену отменили («нет», тот же кот);
 *   • onChange — кулдаун начался / кончился / отменён (app.ts: таймер на кнопке «Другой кот»).
 */
import { SWITCH_LATER_EVENT, SwitchCooldown, laterText } from '../config/pilot';

interface SwitchHost {
  switchReady: (() => boolean) | null;
  switchGate: (() => boolean) | null;
  laterText: string | (() => string);
  laterEvent: string | null;
  sayLater(byButton?: boolean): void;
  log(s: string): void;
  on(ev: 'switch_done', f: (e: { changed: boolean }) => void): unknown;
}

export function wireSwitchCooldown(d: SwitchHost, cd: SwitchCooldown, now: () => number, onChange: () => void = () => undefined) {
  d.laterText = () => laterText(cd.wait(now()));
  d.laterEvent = SWITCH_LATER_EVENT;
  d.switchReady = () => cd.allow(now());
  d.switchGate = () => {
    const t = now();
    if (!cd.allow(t)) {
      d.sayLater();
      return false;
    }
    cd.mark(t);
    onChange();
    return true;
  };
  d.on('switch_done', ({ changed }) => {
    if (!changed) {
      cd.undo();
      d.log('смена кота отменена — кулдаун не тратится');
    }
    onChange();
  });
  /** intentGate: голосом «давай другого» раньше срока — съедено («Чуть позже»), true */
  return (type: string, button: boolean): boolean => {
    if (type !== 'change_persona' || cd.allow(now())) return false;
    d.sayLater(button);
    d.log(`смена кота: ещё ${Math.ceil(cd.wait(now()) / 1000)} с (пилот, раз в ${Math.round(cd.ms / 1000)} с)`);
    return true;
  };
}
