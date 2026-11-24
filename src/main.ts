// редакция (docs/EDITIONS.md) — первым импортом: свои ключи localStorage в lab, без отладочных параметров в MVP
import './config/boot';
import { EDITION, feature, showEditionBadge } from './config/edition';
import './ui/styles.css';
import { App, readParams } from './app';
import { installCatApi } from './debug/catApi';
import { perf } from './core/perf';
import { bootProgress, trackSession } from './progress';
import { bootAnalytics } from './analytics';
import { bootFailed, markBooted } from './quick/early';

// быстрый вход: бандл исполнился — заставка снимает дедлайн загрузки (BOOT-01, src/quick/splash.ts)
markBooted();

perf.enabled = new URLSearchParams(location.search).has('perf');
(window as any).__perf = perf;
(window as any).__edition = EDITION;
showEditionBadge();

// прогресс на сервере по признаку устройства (src/progress, server/progress): до App — ?reset=1 чистит память раньше, чем её прочтут
bootProgress();
// воронка пилота (src/analytics, docs/ANALYTICS.md): pilot и lab, ?noanalytics — выкл.
bootAnalytics();
const params = readParams();
const app = new App(document.getElementById('app')!, params);
(window as any).__app = app;
app
  .init()
  .then(async () => {
    installCatApi(app); // window.__cat: проверка реплик и событий с телефона/консоли
    trackSession(app.director);
    // десктоп-просмотр (?desktop, без касаний): панель умений и «Тест» справа (src/ui/deskPanel.ts, feature 'desktop.panel')
    if (app.desktopView && feature('desktop.panel')) {
      const { DeskPanel } = await import('./ui/deskPanel');
      new DeskPanel(app);
    }
    if (params.debug) {
      (await import('./progress/debugTab')).registerProgressTab();
      const { DebugPanel } = await import('./debug/debugPanel');
      new DebugPanel(app);
    }
  })
  .catch((e) => {
    console.error(e);
    bootFailed('init');
    document.body.insertAdjacentHTML('beforeend', `<div class="toast">Не удалось запустить: ${String(e?.message ?? e)}</div>`);
  });
