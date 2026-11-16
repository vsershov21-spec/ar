/**
 * Вкладка «Анимации и эффекты»: проиграть любой клип / эффект / лицо по id для любого характера.
 * Списки берутся из content/ (animations.json, fx.json, face.json) — новые id появляются сами.
 */
import { registerDebugTab } from './tabs';
import type { CharacterMode } from '../app';
import { FX_IDS, resolveFx } from '../fx/catalog';
import { PERSONA_CYCLE } from '../character/personaMeta';
import { CLIP_IDS, clipDef } from '../character/clips';
import { FACE_IDS } from '../character/face';

export function registerFxTab() {
  registerDebugTab({
    id: 'fx', title: 'Анимации и эффекты', order: 20,
    build(el, ui) {
      const app = ui.app, d = app.director;
      const W = () => app.root.clientWidth, H = () => app.root.clientHeight;

      let s = ui.section(el, 'Характер и режим');
      for (const id of PERSONA_CYCLE) ui.btn(s, id, () => d.setPersona(id), 'fxp:' + id);
      s.appendChild(document.createElement('br'));
      for (const m of ['sprite', 'rig', 'glb'] as CharacterMode[]) ui.btn(s, m, () => void app.setCharacterMode(m), 'mode:' + m);

      s = ui.section(el, 'Эффекты (content/fx.json)');
      const at = document.createElement('label');
      at.innerHTML = '<span>точка</span><select><option value="cat">у кота</option><option value="center">центр</option><option value="rnd">случайно</option></select><span></span>';
      s.appendChild(at);
      const where = at.querySelector('select')!;
      const pos = () => {
        if (where.value === 'center') return { x: W() / 2, y: H() * 0.45 };
        if (where.value === 'rnd') return { x: W() * (0.2 + Math.random() * 0.6), y: H() * (0.2 + Math.random() * 0.5) };
        return {};
      };
      const swipePath = () => Array.from({ length: 14 }, (_, i) => ({ x: W() * (0.12 + i * 0.055), y: H() * (0.42 + Math.sin(i / 3) * 0.05) }));
      for (const id of FX_IDS) {
        const def = resolveFx(id);
        const b = ui.btn(s, id, () => {
          const p = pos();
          const path = id === 'claws' || id === 'glitter_trail' ? swipePath() : undefined;
          const h = app.fx.play(id, { ...p, path, sound: true, image: id === 'glass_cat' ? app.character.posterImage() : undefined });
          ui.log(`fx ${id} (${def.layer}, ${def.durationMs} мс)`);
          if (def.durationMs === 0) setTimeout(() => app.fx.stop(id), 3000);
          void h;
        }, 'fx:' + id);
        b.title = `${def.layer} · ${def.durationMs} мс · ${def.persona}\n${def.notes ?? ''}`;
      }
      s.appendChild(document.createElement('br'));
      ui.btn(s, 'Заклеить экран', () => void app.fx.cover(app.fx.stickerSpecs, app.fx.palette), 'cover');
      ui.btn(s, 'Сдуть наклейки', () => app.fx.blowStickers(), 'blow');
      ui.btn(s, 'Очистить эффекты', () => app.fx.reset(), 'fxreset');
      ui.btn(s, 'Стоп петель', () => ['zzz', 'echo_wave', 'listen_ears'].forEach((i) => app.fx.stop(i)), 'fxstop');

      s = ui.section(el, 'Клипы (content/animations.json)');
      const groups: Record<string, string[]> = {};
      for (const id of CLIP_IDS) {
        const c = clipDef(id)!;
        const g = c.layer === 'additive' ? 'additive' : c.persona !== 'all' ? c.persona : id.split('_')[0];
        (groups[g] ??= []).push(id);
      }
      for (const [g, ids] of Object.entries(groups)) {
        const row = document.createElement('div');
        row.style.cssText = 'border-top:1px solid #2a3a45;margin-top:2px;padding-top:2px';
        const lab = document.createElement('span');
        lab.textContent = g + ': ';
        lab.style.color = '#7a9';
        row.appendChild(lab);
        for (const id of ids) {
          const c = clipDef(id)!;
          ui.btn(row, id, () => app.character.play(id), 'clip:' + id).title = `${c.durationS} с${c.loop ? ' · петля' : ''} · ${c.layer} · ${c.priority}\n${c.notes}`;
        }
        s.appendChild(row);
      }
      ui.btn(s, '▶ idle (по весам характера)', () => app.character.play('idle'), 'clip:idle');

      s = ui.section(el, 'Лицо (content/face.json)');
      for (const id of FACE_IDS) ui.btn(s, id, () => app.character.face?.(id, 2500), 'face:' + id);
    },
    tick(el, ui) {
      const app = ui.app;
      let info = el.querySelector('.fx-info') as HTMLElement | null;
      if (!info) {
        info = document.createElement('div');
        info.className = 'fx-info';
        info.style.cssText = 'margin-top:6px;color:#9ab;white-space:pre-wrap';
        el.prepend(info);
      }
      info.textContent = `клип: ${app.character.currentClip} · fx: ${app.fx.activeIds.join(', ') || '—'} · частиц: ${app.fx.parts.list.length} · lod ${app.fx.lod.toFixed(2)}`;
    },
  });
}
