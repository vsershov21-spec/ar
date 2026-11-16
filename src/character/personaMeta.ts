/**
 * Пресеты характеров из content/src/<id>.meta.json — источник правды для графики:
 * палитра, idle с весами, фирменный трюк, fxTuning, наклейки, показ/скрытие мешей GLB.
 * Реплики и реакции сюда не входят (их грузит persona/loader — модуль «Логика и диалоги»).
 */
import hooligan from '../../content/src/hooligan.meta.json';
import kind from '../../content/src/kind.meta.json';
import glitter from '../../content/src/glitter.meta.json';
import type { StickerSpec } from '../persona/types';
import type { FxTuning } from '../fx/catalog';

export interface PersonaMeta {
  id: string;
  name: string;
  title: string;
  palette: { primary: string; secondary: string; accent: string; fx: string[] };
  idles: { clip: string; weight: number }[];
  signature: { event: string; clip: string; fx: string[]; sound: string };
  fxTuning: FxTuning;
  stickers: StickerSpec[];
  glb: { show?: string[]; hide?: string[]; tint?: Record<string, string> };
  outfit?: { meshes: string[]; description: string; props?: string[] };
}

export const PERSONA_META: Record<string, PersonaMeta> = Object.fromEntries(
  [hooligan, kind, glitter].map((m) => [m.id, m as unknown as PersonaMeta]),
);

/** порядок смены образа по кругу (stickers_cover → встряска → новый образ) */
export const PERSONA_CYCLE = ['hooligan', 'kind', 'glitter'] as const;

export const nextPersona = (id: string): string => {
  const i = PERSONA_CYCLE.indexOf(id as (typeof PERSONA_CYCLE)[number]);
  return PERSONA_CYCLE[(i + 1) % PERSONA_CYCLE.length];
};

export function personaMeta(id: string): PersonaMeta {
  return PERSONA_META[id] ?? PERSONA_META.hooligan;
}
