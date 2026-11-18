#!/usr/bin/env node
// Проверка двух редакций после `npm run build` (docs/EDITIONS.md):
//   статически — dist/ (mvp) и dist/lab/ (lab) есть; lab не дублирует ассеты public/ и модели; html lab — под /lab/;
//                каждая сжатая модель из карты бандла lab лежит в dist/models/opt (одна копия на обе редакции);
//   в браузере — локальный сервер как Caddy (статика dist/, /lab/* → /lab/index.html), headless Chrome:
//                window.__edition; в mvp параметры выключенных функций вырезаны из адреса (таблица PARAMS) и новых
//                мини-игр нет в диалогах (games.new); в lab — всё на месте, плашка LAB, ассеты только из корня (без 404),
//                ключи localStorage и cookie id устройства — свои (lab:…, lab_ar_device).
//
//   npm run check:editions [-- --no-browser] [-- --dist path]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const DIST = path.resolve(argv.includes('--dist') ? argv[argv.indexOf('--dist') + 1] : path.join(root, 'dist'));
const LAB = path.join(DIST, 'lab');
const fails = [];
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) fails.push(msg);
};

// ───────────── статика ─────────────
console.log('check-editions: сборки');
ok(fs.existsSync(path.join(DIST, 'index.html')), 'dist/index.html (mvp)');
ok(fs.existsSync(path.join(LAB, 'index.html')), 'dist/lab/index.html (lab)');
const SHARED = ['models', 'voice', 'sounds', 'video', 'targets', 'stickers', 'personas', 'external'];
const dup = SHARED.filter((d) => fs.existsSync(path.join(LAB, d)));
ok(!dup.length, `lab не копирует общие ассеты (${dup.join(', ') || 'нет копий'})`);
ok(!fs.existsSync(path.join(LAB, 'test')), 'lab без страниц /test (они общие: /test)');
const labHtml = fs.existsSync(path.join(LAB, 'index.html')) ? fs.readFileSync(path.join(LAB, 'index.html'), 'utf8') : '';
const refs = [...labHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:'));
ok(refs.length > 0 && refs.every((u) => u.startsWith('/lab/assets/')), `html lab: js/css под /lab/assets/ (${refs.length})`);
const js = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : '');
const labJs = js(path.join(LAB, 'assets'));
const mvpJs = js(path.join(DIST, 'assets'));
const optPaths = (s) => [...new Set([...s.matchAll(/models\/(?:props\/)?opt\/[\w.-]+\.glb/g)].map((m) => m[0]))];
const labOpt = optPaths(labJs), mvpOpt = optPaths(mvpJs);
const missing = labOpt.filter((p) => !fs.existsSync(path.join(DIST, p)));
ok(labOpt.length > 0 || mvpOpt.length === 0, `карта сжатых моделей в lab (${labOpt.length})`);
ok(!missing.length, `сжатые модели lab — те же файлы в dist/models/opt${missing.length ? ': нет ' + missing.join(', ') : ''}`);
ok(labOpt.join() === mvpOpt.join(), 'карта сжатых моделей mvp и lab совпадает');

// ───────────── браузер ─────────────
if (argv.includes('--no-browser')) finish();
else await browser().then(finish, (e) => {
  fails.push('браузер: ' + (e?.message ?? e));
  finish();
});

function finish() {
  if (fails.length) {
    console.error(`check-editions: ОШИБКИ (${fails.length})`);
    process.exit(1);
  }
  console.log('check-editions: всё в порядке');
  process.exit(0);
}

function serve() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mind': 'application/octet-stream' };
  const file = (p) => {
    const f = path.join(DIST, p);
    if (!f.startsWith(DIST)) return null;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    if (fs.existsSync(path.join(f, 'index.html'))) return path.join(f, 'index.html');
    return null;
  };
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/api/')) return void (res.writeHead(404), res.end());
    // как Caddy (docs/DEPLOY.md): файл → каталог/index.html → /lab/* → /lab/index.html → /index.html (только для «страниц»)
    let f = file(p);
    const isPage = !path.extname(p) || p.endsWith('.html');
    if (!f && isPage) f = p.startsWith('/lab/') || p === '/lab' ? file('/lab/index.html') : file('/index.html');
    if (!f) return void (res.writeHead(404), res.end('404'));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function browser() {
  const { default: puppeteer } = await import('puppeteer-core');
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  console.log(`check-editions: браузер (${base})`);
  const br = await puppeteer.launch({
    executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await br.newPage();
    const reqs = [];
    page.on('response', (r) => reqs.push({ url: r.url(), status: r.status() }));
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
    const open = async (url) => {
      reqs.length = 0;
      await page.goto(base + url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window).__edition, { timeout: 20000 });
      // ждём режиссёра (диалоги загружены) — не дольше 25 с
      await page.waitForFunction(() => !!(window).__app?.director, { timeout: 25000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      return page.evaluate(() => {
        const w = window;
        const dl = w.__app?.director?.cfg?.dialogs;
        return {
          edition: w.__edition,
          search: location.search,
          badge: !!document.querySelector('.edition-badge'),
          triggers: dl ? Object.keys(dl.triggers) : null,
          dialogs: dl ? Object.keys(dl.dialogs) : null,
          progress: !!w.__progress?.sync,
          device: w.__progress?.device ?? null,
          rawKeys: Object.keys(localStorage),
          cookie: document.cookie,
        };
      });
    };
    const assetReq = (list) => list.filter((r) => /\/(models|voice|sounds|video|targets|stickers|personas)\//.test(new URL(r.url).pathname));
    // озвучки нет в сборке без /srv/ar-extra (ноутбук, CI) — её 404 не ошибка (так же и в mvp)
    const noVoice = !fs.existsSync(path.join(DIST, 'voice'));
    const bad = (r) => r.status >= 400 && !(noVoice && /^\/voice\//.test(new URL(r.url).pathname));

    // mvp: параметры выключенных функций — вырезаны
    const m = await open('/?anycard&grab=bitmap&flow=rps&glb=models/x.glb&nocard&debug');
    const mAssets = assetReq(reqs);
    ok(m.edition === 'mvp', `/ → редакция ${m.edition}`);
    ok(m.search === '?debug', `mvp: адрес очищен до «${m.search}» (anycard, grab=bitmap, flow, glb, nocard — выключены)`);
    ok(!m.badge, 'mvp: без плашки LAB');
    ok(!!m.triggers && !['emo_game', 'rps', 'simon'].some((t) => m.triggers.includes(t)) && !['emo', 'rps', 'simon'].some((d) => m.dialogs.includes(d)), `mvp: новых мини-игр нет (диалоги: ${m.dialogs?.join(', ')})`);
    ok(m.triggers?.includes('riddle') && m.triggers?.includes('echo_start'), 'mvp: загадка и повторялка есть');
    ok(!m.rawKeys.some((k) => k.startsWith('lab:')), 'mvp: ключи localStorage без префикса');
    ok(!mAssets.some(bad), `mvp: ассеты без ошибок (${mAssets.length})${mAssets.filter(bad).map((r) => ' ' + r.url).join('')}`);
    // mvp со страницы /test: флоу остаётся (но не новой игры)
    const mt = await open('/?from=test&flow=riddle&nocard');
    ok(/flow=riddle/.test(mt.search) && /nocard/.test(mt.search), `mvp, ссылка с /test: флоу остаётся (${mt.search})`);
    const mt2 = await open('/?from=test&flow=simon');
    ok(!/flow=/.test(mt2.search), 'mvp, ссылка с /test: ?flow=simon (новая игра) — вырезан');

    // lab
    const l = await open('/lab/?anycard&grab=bitmap&debug');
    const lAssets = assetReq(reqs);
    ok(l.edition === 'lab', `/lab/ → редакция ${l.edition}`);
    ok(l.search === '?anycard&grab=bitmap&debug', `lab: параметры остаются (${l.search})`);
    ok(l.badge, 'lab: плашка LAB');
    ok(!!l.triggers && ['emo_game', 'rps', 'simon'].every((t) => l.triggers.includes(t)), 'lab: новые мини-игры есть');
    ok(lAssets.length > 0, `lab: грузит ассеты (${lAssets.length})`);
    ok(lAssets.every((r) => !new URL(r.url).pathname.startsWith('/lab/')), `lab: ассеты из корня (${[...new Set(lAssets.map((r) => new URL(r.url).pathname.split('/')[1]))].join(', ')})`);
    ok(!lAssets.some(bad), `lab: ассеты без 404${lAssets.filter(bad).map((r) => ' ' + r.url).join('')}`);
    const labOwn = l.rawKeys.filter((k) => /^(lab:)?(ar\.|sber-ar-cat)/.test(k));
    ok(l.rawKeys.includes('lab:ar.device') && l.rawKeys.includes('ar.device'), 'lab: свой id устройства (lab:ar.device рядом с ar.device mvp)');
    ok(labOwn.every((k) => k.startsWith('lab:') || m.rawKeys.includes(k) || mt.rawKeys.includes(k) || mt2.rawKeys.includes(k)), 'lab: новые ключи — только с префиксом lab:');
    ok(/(^|; )lab_ar_device=/.test(l.cookie) && /(^|; )ar_device=/.test(l.cookie), 'cookie: ar_device (mvp) и lab_ar_device (lab)');
    ok(l.device !== m.device, 'id устройства lab ≠ mvp');
    const deep = await open('/lab/some/deep/link');
    ok(deep.edition === 'lab', 'SPA-фолбэк /lab/* → /lab/index.html');
    // страница /test: переключатель «Lab / MVP» для ссылок
    if (fs.existsSync(path.join(DIST, 'test/index.html'))) {
      await page.goto(base + '/test/', { waitUntil: 'networkidle0' });
      const links = () => page.evaluate(() => [...document.querySelectorAll('a.go[data-params]')].map((a) => ({ p: a.dataset.params, href: new URL(a.href).pathname + new URL(a.href).search, off: a.classList.contains('off') })));
      const lab = await links();
      const has = (await page.$('[data-group="ed"]')) !== null;
      ok(has, '/test: переключатель редакции');
      if (has) {
        ok(lab.length > 0 && lab.every((x) => x.href.startsWith('/lab/') && !x.off), `/test, Lab: ссылки на /lab/ (${lab.length})`);
        await page.click('[data-group="ed"] [data-mod="mvp"]');
        const mvp = await links();
        ok(mvp.every((x) => x.href.startsWith('/?from=test')), '/test, MVP: ссылки на /?from=test');
        const off = mvp.filter((x) => x.off).map((x) => x.p);
        ok(['anycard', 'flow=emo', 'flow=rps', 'flow=simon'].every((p) => off.includes(p)) && !off.includes('flow=riddle') && !off.includes('fresh'), `/test, MVP: «только Lab» — ${off.join(', ')}`);
      }
    }
    ok(!errors.length, `без ошибок страницы${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  } finally {
    await br.close();
    srv.close();
  }
}
