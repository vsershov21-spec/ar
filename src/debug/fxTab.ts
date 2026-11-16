/** Вкладка «Анимации и эффекты»: режим персонажа, клипы, эффекты. */
import { registerDebugTab } from './tabs';
import type { CharacterMode } from '../app';
import { CLIPS, type ClipName } from '../character/types';
import type { FxName } from '../persona/types';

export function registerFxTab() {
  registerDebugTab({
    id: 'fx', title: 'Анимации и эффекты', order: 20,
    build(el, ui) {
      const app = ui.app, d = app.director;
      let s = ui.section(el, 'Режим персонажа');
      for (const m of ['sprite', 'rig', 'glb'] as CharacterMode[]) ui.btn(s, m, () => void app.setCharacterMode(m), 'mode:' + m);
      s = ui.section(el, 'Клипы');
      for (const c of Object.keys(CLIPS) as ClipName[]) ui.btn(s, c, () => app.character.play(c), 'clip:' + c);
      s = ui.section(el, 'Эффекты');
      const fxs: FxName[] = ['glitter_burst', 'glitter_trail', 'snow_globe', 'gum_bubble', 'claws', 'glitch', 'steam_heart', 'glass_cat', 'knock', 'sticker'];
      for (const f of fxs) ui.btn(s, f, () => void d.runFx(f), 'fx:' + f);
      ui.btn(s, 'Заклеить экран', () => void app.fx.cover(d.persona.stickers, d.persona.palette, 1500), 'cover');
      ui.btn(s, 'Сдуть наклейки', () => app.fx.blowStickers(), 'blow');
      ui.btn(s, 'Очистить эффекты', () => app.fx.reset(), 'fxreset');
    },
  });
}
