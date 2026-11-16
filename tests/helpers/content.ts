/** Контент для тестов: те же собранные файлы, что грузит приложение (content/personas — `python3 content/build.py`). */
import { makeBundle, type ContentBundle, type FaceFile, type RawContent } from '../../src/persona/content';
import type { Persona } from '../../src/persona/types';
import type { DialogsFile } from '../../src/scenario/dialogs';
import hooligan from '../../content/personas/hooligan.json';
import kind from '../../content/personas/kind.json';
import glitter from '../../content/personas/glitter.json';
import events from '../../content/events.json';
import dialogs from '../../content/dialogs.json';
import intents from '../../content/intents.ru.json';
import face from '../../content/face.json';
import names from '../../content/names.ru.txt?raw';

export const dialogsFile = dialogs as unknown as DialogsFile;

export function loadTestContent(): ContentBundle {
  return makeBundle({
    personas: [hooligan, kind, glitter] as unknown as Persona[],
    events: events as unknown as RawContent['events'],
    dialogs: dialogsFile,
    intents: intents as unknown as RawContent['intents'],
    face: face as unknown as FaceFile,
    names,
  });
}

/** детерминированный генератор (LCG) */
export const seeded = (seed = 1) => {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
};
