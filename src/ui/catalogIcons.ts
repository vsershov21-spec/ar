/** Иконки каталога «Что умеет кот»: тот же стиль, что ICON в ui.ts (24×24, currentColor, скруглённые линии 2–2.4). */
const S = (body: string, w = 2.2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const F = (body: string) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;
/** круглая мордочка: глаза + рот */
const face = (inner: string) => S(`<circle cx="12" cy="12" r="9" fill="currentColor" fill-opacity=".18"/>${inner}`, 2);

export const CAT_ICON: Record<string, string> = {
  more: F('<rect x="3.5" y="3.5" width="7" height="7" rx="2.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2.2"/><circle cx="17" cy="17" r="3.6"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>', 2.6),
  heart: F('<path d="M12 20.5s-8-4.9-8-10.8A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.7c0 5.9-8 10.8-8 10.8z"/>'),
  scratch: S('<path d="M6 4.5 9 10l3-5.5 3 5.5 3-5.5" fill="currentColor" fill-opacity=".2"/><path d="M7 15c1.5 1.4 3.3 2 5 2s3.5-.6 5-2M9 20h6"/>'),
  cheek: face('<path d="M9 10h.01M15 10h.01" stroke-width="3"/><circle cx="7.6" cy="14" r="1.6" fill="currentColor" stroke="none"/><circle cx="16.4" cy="14" r="1.6" fill="currentColor" stroke="none"/><path d="M10.5 15.5c.9.6 2.1.6 3 0"/>'),
  jump: S('<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 20c2-1.6 4.4-2.4 7-2.4s5 .8 7 2.4"/>'),
  sit: S('<path d="M7 3.5v9h10v8M7 12.5v8M7 12.5h10"/><path d="M5 3.5h4"/>'),
  wave: S('<path d="M9 11V6a1.5 1.5 0 0 1 3 0v4.5V5a1.5 1.5 0 0 1 3 0v6V7a1.5 1.5 0 0 1 3 0v6.5c0 4-2.5 7-6.5 7-2.8 0-4.3-1.5-5.8-4L4 13a1.5 1.5 0 0 1 2.5-1.6L9 14" fill="currentColor" fill-opacity=".2"/><path d="M3 6.5c.4-1.5 1.3-2.6 2.6-3.2" stroke-width="1.8"/>'),
  sing: S('<rect x="8.5" y="2.5" width="7" height="11" rx="3.5" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4"/>'),
  smile: face('<path d="M8.6 9.5l1.4 1M15.4 9.5 14 10.5"/><path d="M7.5 13.5h9a4.5 4.5 0 0 1-9 0z" fill="currentColor"/>'),
  wow: face('<path d="M9 9.5h.01M15 9.5h.01" stroke-width="3.2"/><ellipse cx="12" cy="15.3" rx="2" ry="2.5" fill="currentColor"/>'),
  blush: face('<path d="M8 10.3c.6-.8 1.6-.8 2.2 0M13.8 10.3c.6-.8 1.6-.8 2.2 0"/><path d="M6.6 13.6h2.4M15 13.6h2.4" stroke-width="2.4" stroke-opacity=".7"/><path d="M10.5 15.8c.9.5 2.1.5 3 0"/>'),
  pout: face('<path d="M8 9.5l2.5 1M16 9.5l-2.5 1"/><path d="M9.5 16.2c1.6-1.4 3.4-1.4 5 0"/>'),
  spiral: S('<path d="M12 12.2a1.4 1.4 0 1 1 1.4-1.4 3 3 0 0 1-3 3 4.4 4.4 0 0 1-4.4-4.4A5.8 5.8 0 0 1 11.8 3.6a7.4 7.4 0 0 1 7.4 7.4 8.6 8.6 0 0 1-8.6 8.6"/>'),
  moon: S('<path d="M15.5 4.5a7.5 7.5 0 1 0 4 12.7A6.5 6.5 0 0 1 15.5 4.5z" fill="currentColor" fill-opacity=".25"/><path d="M15.5 6h3.5l-3.5 4h3.5" stroke-width="1.8"/>'),
  sparkle: F('<path d="M10 2.5l1.7 5.3 5.3 1.7-5.3 1.7L10 16.5l-1.7-5.3L3 9.5l5.3-1.7z"/><path d="M18 13l.9 2.6 2.6.9-2.6.9L18 20l-.9-2.6-2.6-.9 2.6-.9z"/>'),
  bubbles: S('<circle cx="9" cy="13" r="5.5" fill="currentColor" fill-opacity=".18"/><circle cx="17" cy="7" r="3.2"/><circle cx="18" cy="16.5" r="1.8"/><path d="M6.5 11a3 3 0 0 1 2.3-1.8" stroke-width="1.8"/>', 2),
  gum: S('<circle cx="12" cy="10.5" r="7.5" fill="currentColor" fill-opacity=".22"/><path d="M8.5 8a4 4 0 0 1 3-2" stroke-width="1.8"/><path d="M9.5 20.5c1.6-.8 3.4-.8 5 0"/>', 2),
  draw: S('<path d="M4 18c3-6 6-.5 9-5s4-6.5 7-6"/><path d="M15.5 15.5s-3-1.8-3-3.8a1.6 1.6 0 0 1 3-.8 1.6 1.6 0 0 1 3 .8c0 2-3 3.8-3 3.8z" fill="currentColor" stroke-width="1.4"/>'),
  claws: S('<path d="M6 3.5c-1 5 0 10.5 3 17M11.5 3c-.8 5.4.2 11 3 17.5M17 3.5c-.6 5 .4 10 3 15.5"/>', 2.4),
  glass: S('<rect x="4" y="3" width="16" height="18" rx="3" fill="currentColor" fill-opacity=".14"/><path d="M8.5 9.5c1-1 2.2-1 3 0M14 13a2.5 2 0 1 1-5 0"/><path d="M15.5 6.5 17 5M16.5 9.5 18.5 9" stroke-width="1.7"/>', 2),
  kiss: F('<path d="M12 9.6c-1.2-1.6-2.7-2.6-4.3-2.6C5 7 3 9.6 3 12c3 .2 4.6 4.5 9 4.5S18 12.2 21 12c0-2.4-2-5-4.7-5-1.6 0-3.1 1-4.3 2.6z"/>'),
  knock: S('<path d="M8 13.5V9.6a1.6 1.6 0 0 1 3.2 0V9a1.6 1.6 0 0 1 3.2 0v.6a1.6 1.6 0 0 1 3.2 0v4.3c0 3.4-2.2 5.6-5.4 5.6-2.4 0-4.2-1.2-4.2-3.6 0-1 .2-1.8 0-2.4z" fill="currentColor" fill-opacity=".2"/><path d="M3.5 6.5 5.6 8M7.5 3.5 8.4 6M2.8 11h2.4" stroke-width="1.8"/>'),
  chat: S('<path d="M4 5.5h16v10H10l-4.5 4v-4H4z" fill="currentColor" fill-opacity=".18"/><path d="M8 9.2c.4-.9 1.4-1.2 2-.5M8 9.2v2.3M13 9.2c.4-.9 1.4-1.2 2-.5M13 9.2v2.3" stroke-width="1.9"/>', 2),
  /** чипы-ответы кота: сдаюсь, хватит, да, нет; раздел «Ещё» каталога */
  flag: S('<path d="M5.5 21V3.5"/><path d="M5.5 4.5c4-2 6.5 2 11 0v8c-4.5 2-7-2-11 0" fill="currentColor" fill-opacity=".2"/>'),
  rps: S('<path d="M7 20v-6.5a1.6 1.6 0 0 1 3.2 0V12a1.6 1.6 0 0 1 3.2 0v.6a1.6 1.6 0 0 1 3.2 0V14a1.6 1.6 0 0 1 3.2 0v1.5c0 2.8-2 4.5-5 4.5z" fill="currentColor" fill-opacity=".2"/><path d="M5 9l3-5.5M9.5 9 8 3.5"/>'),
  stop: F('<rect x="5" y="5" width="14" height="14" rx="3.5"/>'),
  yes: S('<path d="M4.5 12.5l5 5L19.5 6.5"/>', 2.8),
  no: S('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 2.8),
  /** фирменные действия пилота: скейт Хулигана, зеркальце Блёстки (какао — home_mug из home/icons.ts) */
  skate: S('<path d="M3 13.5h18" stroke-width="2.6"/><path d="M4.5 13.5c0-1.2.8-2 2-2h11c1.2 0 2 .8 2 2" fill="currentColor" fill-opacity=".18"/><circle cx="7.5" cy="17.5" r="1.8" fill="currentColor"/><circle cx="16.5" cy="17.5" r="1.8" fill="currentColor"/>'),
  mirror: S('<ellipse cx="12" cy="9" rx="5.5" ry="6.2" fill="currentColor" fill-opacity=".18"/><path d="M12 15.2V21M9.5 21h5"/><path d="M9.6 6.8c.6-1 1.5-1.5 2.4-1.5" stroke-width="1.6"/>'),
  gear: S('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M5.5 18.5l1.9-1.9M16.6 7.4l1.9-1.9"/>'),
};
