/**
 * PersonaContext — единственный источник «кто сейчас кот».
 * Активный характер определяет: реплики (через LinePicker — только свои), голос
 * (piperVoice / pitch / rate и настройки «повторялки»), idle-набор с весами, фирменный трюк,
 * fxTuning, наклейки, палитру и ambience. Модули не хранят характер у себя — подписываются на change.
 */
import { Emitter } from '../core/emitter';
import type { ContentBundle } from './content';
import { LinePicker, type PickOptions, type PickedLine } from './picker';
import type { Persona, PersonaId } from './types';
import { PERSONA_IDS } from './types';

export interface VoiceSettings {
  persona: PersonaId;
  piperVoice: string;
  pitchSemitones: number;
  rate: number;
  /** для speechSynthesis (0..2, 1 — норма) */
  webPitch: number;
  echo: { pitchSemitones: number; rate: number; webPitch: number };
}

export const semitonesToWebPitch = (st: number) => Math.max(0.5, Math.min(2, Math.pow(2, st / 12)));

export class PersonaContext extends Emitter<{ change: { from: PersonaId; to: PersonaId } }> {
  readonly picker: LinePicker;
  private cur: PersonaId;

  constructor(readonly content: ContentBundle, initial: PersonaId | null | undefined, random: () => number = Math.random) {
    super();
    this.picker = new LinePicker(content, random);
    this.cur = initial && content.personas.has(initial) ? initial : PERSONA_IDS[0];
    this.random = random;
  }
  private random: () => number;

  get id(): PersonaId {
    return this.cur;
  }
  get persona(): Persona {
    return this.content.personas.get(this.cur)!;
  }
  get(id: PersonaId): Persona | undefined {
    return this.content.personas.get(id);
  }
  get all(): Persona[] {
    return PERSONA_IDS.map((id) => this.content.personas.get(id)!).filter(Boolean);
  }

  /** сменить характер; true — если сменился */
  set(id: PersonaId): boolean {
    if (!this.content.personas.has(id) || id === this.cur) return false;
    const from = this.cur;
    this.cur = id;
    this.emit('change', { from, to: id });
    return true;
  }

  /** следующий по кругу: hooligan → kind → glitter → hooligan */
  next(from: PersonaId = this.cur): PersonaId {
    const i = PERSONA_IDS.indexOf(from);
    return PERSONA_IDS[(i + 1) % PERSONA_IDS.length];
  }

  /** реплика активного характера на событие */
  line(event: string, o: PickOptions = {}): PickedLine | null {
    return this.picker.pick(this.persona, event, o);
  }

  get voice(): VoiceSettings {
    const v = this.persona.voice;
    return {
      persona: this.cur,
      piperVoice: v.piperVoice,
      pitchSemitones: v.pitchSemitones,
      rate: v.rate,
      webPitch: semitonesToWebPitch(v.pitchSemitones),
      echo: { pitchSemitones: v.echoPitchSemitones, rate: v.echoRate, webPitch: semitonesToWebPitch(v.echoPitchSemitones) },
    };
  }

  /** случайный idle-клип с учётом весов */
  pickIdle(r = this.random()): string {
    const idles = this.persona.idles;
    const total = idles.reduce((s, i) => s + i.weight, 0);
    let x = r * total;
    for (const i of idles) if ((x -= i.weight) < 0) return i.clip;
    return idles[idles.length - 1]?.clip ?? 'idle_breathe';
  }

  get signature() {
    return this.persona.signature;
  }
  fxTuning(fx: string): Record<string, number> {
    return this.persona.fxTuning[fx] ?? {};
  }
  get stickers() {
    return this.persona.stickers;
  }
  get palette() {
    return this.persona.palette;
  }
  get ambience() {
    return this.persona.ambience;
  }
}
