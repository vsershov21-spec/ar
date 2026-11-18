/** Иконки «Мира кота» — в стиле каталога (24×24, currentColor). Регистрируются в CAT_ICON, чтобы чипы и каталог их нашли. */
import { CAT_ICON } from '../ui/catalogIcons';

const S = (body: string, w = 2.2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const HOME_ICON: Record<string, string> = {
  home_house: S('<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5" fill="currentColor" fill-opacity=".18"/><path d="M10 20v-5a2 2 0 0 1 4 0v5"/>'),
  home_card: S('<rect x="3" y="6" width="18" height="12.5" rx="2.5" fill="currentColor" fill-opacity=".16"/><path d="M3 10.2h18M7 15h4"/>'),
  home_sofa: S('<path d="M5 11V8.5A2.5 2.5 0 0 1 7.5 6h9A2.5 2.5 0 0 1 19 8.5V11"/><path d="M3.5 11.5a1.8 1.8 0 0 1 3.5 0V14h10v-2.5a1.8 1.8 0 0 1 3.5 0V17H3.5z" fill="currentColor" fill-opacity=".2"/><path d="M6 17v2M18 17v2"/>'),
  home_kitchen: S('<path d="M5 10h14v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="currentColor" fill-opacity=".2"/><path d="M3 10h2M19 10h2M9 6.5c0-1 1-1.5 1-2.5M13 6.5c0-1 1-1.5 1-2.5"/>'),
  home_moon: S('<path d="M15.5 4.5a7.5 7.5 0 1 0 4 12.7A6.5 6.5 0 0 1 15.5 4.5z" fill="currentColor" fill-opacity=".25"/><path d="M6 4.5v2M5 5.5h2" stroke-width="1.6"/>'),
  home_mug: S('<path d="M5 8h11v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="currentColor" fill-opacity=".2"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8.5 5c0-1 1-1.2 1-2.2M12 5c0-1 1-1.2 1-2.2"/>'),
  home_ball: S('<circle cx="12" cy="12" r="8.5" fill="currentColor" fill-opacity=".2"/><path d="M3.8 10.5c3 1.6 13.4 1.6 16.4 0M12 3.5c-2.5 3-2.5 14 0 17"/>'),
  home_chev_l: S('<path d="M15 5l-7 7 7 7"/>', 2.8),
  home_chev_r: S('<path d="M9 5l7 7-7 7"/>', 2.8),
};

let done = false;
export function registerHomeIcons() {
  if (done) return;
  done = true;
  Object.assign(CAT_ICON, HOME_ICON);
}
