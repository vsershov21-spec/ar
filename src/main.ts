import './ui/styles.css';
import { App, readParams } from './app';

const params = readParams();
const app = new App(document.getElementById('app')!, params);
(window as any).__app = app;
app
  .init()
  .then(async () => {
    if (params.debug) {
      const { DebugPanel } = await import('./debug/debugPanel');
      new DebugPanel(app);
    }
  })
  .catch((e) => {
    console.error(e);
    document.body.insertAdjacentHTML('beforeend', `<div class="toast">Не удалось запустить: ${String(e?.message ?? e)}</div>`);
  });
