/**
 * Имя ребёнка: распознаёт src/voice/intents.ts (known — есть в content/names.ru.txt).
 * Кот произносит имя, только если оно есть в словаре; хранится только в localStorage телефона.
 */
export const normalizeName = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е');
