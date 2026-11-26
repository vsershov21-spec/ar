// Сценарии E2E пилота (docs/qa/E2E.md). Каждый — { name, title, timeout (с), allow (доп. белый список), fn(t) }.
// t: browser, server, out, log, note, track(P) — страницы, которые прогон проверит на ошибки и снимет на провале.
import { openPhone, toPlay, sleep, watchTexts, catalogItems, pick, SETTLED, catBox, swipe, longPress, events, tapChip } from './lib.mjs';

const PERSONAS = ['hooligan', 'kind', 'glitter'];
const MET = (persona) => ({ met: true, persona, visits: 3, name: null });
/** «Скажи…» — кот зовёт говорить (без микрофона нельзя) */
const SAY_RE = /(^|[^а-яё])скажи/i;
const SLOW4G = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (750 * 1024 / 8) * 0.9 };

function assert(c, msg) {
  if (!c) throw new Error(msg);
}

/** готовый к игре кот: знакомы (память), карта найдена, phase play */
async function playing(t, persona, q = '', o = {}) {
  const P = t.track(await openPhone(t.browser, t.server, { q: `cat=${persona}${q ? '&' + q : ''}`, memory: MET(persona), ...o }));
  await toPlay(P);
  await watchTexts(P);
  await P.must(SETTLED, 30000, 'кот свободен после приветствия');
  return P;
}

/** ждём, пока действие освободит кота; возвращает мс или бросает (зависшая поза / действие) */
async function settle(P, what, ms = 16000) {
  const t0 = Date.now();
  await sleep(250);
  if (!(await P.until(SETTLED, ms))) {
    const st = await P.ev(() => {
      const d = window.__app.director;
      return { cur: d.orch.current?.id ?? null, pending: d.orch.pending?.id ?? null, clip: d.character?.currentClip, walking: window.__app.stage.walking, phase: d.state.phase };
    });
    throw new Error(`«${what}»: кот не освободился за ${ms / 1000} с — ${JSON.stringify(st)}`);
  }
  return Date.now() - t0;
}

/** что произошло после шага: реплики (speak), пузыри, клипы — по записи стенда с момента from (rt) */
async function since(P, from) {
  return P.ev((from) => {
    const r = (window.__qaRec ?? []).filter((x) => x.rt >= from);
    return {
      speak: r.filter((x) => x.kind === 'speak').map((x) => x.id),
      bubble: r.filter((x) => x.kind === 'bubble' && x.on && !x.hint).map((x) => x.txt),
      clips: [...new Set(r.filter((x) => x.kind === 'sample').map((x) => x.clip))],
      log: r.filter((x) => x.kind === 'log').map((x) => x.s),
    };
  }, from);
}
const rt = (P) => P.ev(() => window.__qaT().rt);
/** пилот без «ласки» (pilot.noCare): этих слов нет в меню, подсказках и репликах */
const NO_CARE_RE = /(^|[^а-яё])(по)?глад(ь|ить|ят|ишь|ит)(?![а-яё])|(по)?щекоч|щекотать|щекотк|обним|обнять|обнима|ласк|почеш|почесать/i;
/** кадр экрана: E2E_SHOTS=<папка> — jpg туда (иначе в bench-out/e2e) */
async function shot(t, P, name) {
  const dir = process.env.E2E_SHOTS || t.out;
  await P.ev(() => window.__qaDraw?.(2)).catch(() => undefined);
  await P.page.screenshot({ path: `${dir}/${name}.jpg`, type: 'jpeg', quality: 82 }).catch(() => undefined);
}

export const TESTS = [
  // ───────────── 1. вход intro.quick ─────────────
  {
    name: '01_entry_splash',
    title: 'вход: заставка < 1,5 с (Slow 4G), нет кота до нажатия, «Узнать, кто там», условия',
    timeout: 300,
    async fn(t) {
      const n0 = t.server.requests.length;
      const P = t.track(await openPhone(t.browser, t.server, { url: null }));
      const cdp = await P.page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', SLOW4G);
      await P.go('');
      // первый кадр страницы = заставка (она прямо в index.html, до бандла); splash_shown (rAF после первого кадра) — в воронке
      await P.must(() => performance.getEntriesByType('paint').some((p) => p.name === 'first-contentful-paint') && !!document.querySelector('#quick'), 10000, 'первый кадр с заставкой');
      const fcp = await P.ev(() => Math.round(performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint').startTime));
      const nav = await P.ev(() => Math.round(performance.getEntriesByType('navigation')[0]?.responseStart ?? 0));
      t.note(`заставка на экране: ${fcp} мс от навигации (первый байт HTML ${nav} мс, Slow 4G)`);
      assert(fcp < 1500, `заставка через ${fcp} мс (> 1,5 с)`);
      assert(await P.visible('#quick .q-cta'), 'кнопка не видна');
      const cta = await P.ev(() => document.querySelector('#quick .q-cta-t')?.textContent);
      assert(cta === 'Узнать, кто там', `текст кнопки «${cta}»`);
      assert(await P.ev(() => document.querySelector('#quick')?.dataset.consent === 'notice' && !document.querySelector('#quick .q-check')), 'режим notice: галочки быть не должно');
      // кота до нажатия нет: ни модели на сцене, ни картинки кота в плашке — до и после готовности приложения
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await P.must(() => !!window.__app?.input && window.__quick?.ready, 180000, 'приложение готово');
      await sleep(1500);
      const st = await P.ev(() => ({ vis: window.__app.stage.root.visible, phase: window.__app.director.state.phase, peek: !!document.querySelector('.scan-peek'), quick: !document.querySelector('#quick').classList.contains('hidden'), gum: window.__qaGum ?? 0 }));
      assert(!st.vis, 'кот на сцене до нажатия');
      assert(st.phase === 'start', `фаза до нажатия ${st.phase}`);
      assert(!st.peek && st.quick, 'картинка кота / заставка ушла до нажатия');
      assert(st.gum === 0, 'камеру спросили до нажатия');
      // лист условий: открыть, прочитать, закрыть
      await P.tap('#quick [data-q="terms"]');
      await P.must(() => !document.querySelector('#quick .q-sheet').classList.contains('hidden'), 3000, 'лист условий открылся');
      const txt = await P.ev(() => document.querySelector('#quick .q-sheet').textContent);
      assert(/Камера/.test(txt) && /Микрофон/.test(txt), 'в листе нет разделов «Камера»/«Микрофон»');
      await P.tap('#quick [data-q="close"]');
      await P.must(() => document.querySelector('#quick .q-sheet').classList.contains('hidden'), 3000, 'лист условий закрылся');
      assert(await P.ev(() => !window.__quick.tapped && (window.__qaGum ?? 0) === 0), 'лист условий нажал «Узнать» / спросил камеру');
      await sleep(600);
      const ev = events(t.server, n0).filter((e) => ['splash_shown', 'terms_open'].includes(e.name));
      const ss = ev.find((e) => e.name === 'splash_shown');
      assert(ss && ss.props.ms < 1500, `splash_shown: ${ss ? ss.props.ms + ' мс' : 'нет события'}`);
      assert(ev.some((e) => e.name === 'terms_open'), 'нет события terms_open');
      await cdp.detach().catch(() => undefined);
    },
  },
  {
    name: '01_entry_consent',
    title: 'согласие: notice — сразу; checkbox и parent — без галочки кнопка не жмётся',
    timeout: 300,
    async fn(t) {
      for (const mode of ['checkbox', 'parent']) {
        const P = t.track(await openPhone(t.browser, t.server, { q: `consent=${mode}` }));
        await P.must(() => !!document.querySelector('#quick .q-check input'), 10000, `${mode}: галочка на экране`);
        const label = await P.ev(() => document.querySelector('#quick .q-check span').textContent);
        assert(mode === 'parent' ? /взрослый|родитель/i.test(label) : /Согласен/.test(label), `${mode}: подпись галочки «${label}»`);
        assert(await P.ev(() => document.querySelector('#quick .q-cta').getAttribute('aria-disabled') === 'true'), `${mode}: кнопка не приглушена`);
        await P.tap('#quick .q-cta');
        await sleep(400);
        assert(await P.visible('#quick .q-need'), `${mode}: нет подсказки «Сначала отметь галочку»`);
        assert(await P.ev(() => !window.__quick.tapped && (window.__qaGum ?? 0) === 0), `${mode}: без галочки ушли за камерой`);
        await sleep(500); // галочка «трясётся» 0,45 с (qKnock)
        await P.tap('#quick .q-check input');
        await sleep(200);
        assert(!(await P.visible('#quick .q-need')), `${mode}: подсказка не ушла после галочки`);
        await P.tap('#quick .q-cta');
        await P.must(() => window.__quick.tapped && (window.__qaGum ?? 0) > 0, 5000, `${mode}: с галочкой камера спрошена`);
        await P.close();
      }
    },
  },

  {
    name: '01_entry_boot_fail',
    title: 'BOOT-01: главный JS — HTML вместо JS (после нажатия) и 404 (до нажатия) → «Попробовать снова» ≤15 с, дорожки ended; ассет вернулся → поиск карты без дубля камеры',
    timeout: 400,
    allow: [
      { re: /MIME type|Failed to load module script|Expected a JavaScript/i, why: 'сценарий сам отдаёт HTML вместо main.js' },
    ],
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, { url: null }));
      // дорожки камеры/микрофона, выданные странице: после сбоя все должны быть ended
      await P.page.evaluateOnNewDocument(() => {
        window.__qaTracks = [];
        const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md);
        md.getUserMedia = async (c) => {
          const s = await gum(c);
          window.__qaTracks.push(...s.getTracks());
          return s;
        };
      });
      let mode = 'html';
      const index = await (await fetch(`${t.server.base}/mvp/`)).text();
      await P.page.setRequestInterception(true);
      P.page.on('request', (r) => {
        if (mode !== 'ok' && /\/mvp\/assets\/main-[^/]*\.js(\?|$)/.test(r.url())) {
          // HTML вместо JS — с задержкой: ребёнок успевает нажать «Узнать, кто там» (камера уже открыта), потом сбой
          if (mode === 'html') return void setTimeout(() => r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: index }).catch(() => undefined), 4000);
          return void r.respond({ status: 404, contentType: 'text/plain', body: 'not found' });
        }
        r.continue().catch(() => undefined);
      });
      const failShown = () => !document.querySelector('#quick .q-fail').classList.contains('hidden');
      const state = () => P.ev(() => ({
        tracks: (window.__qaTracks ?? []).map((x) => x.readyState),
        gum: window.__qaGum ?? 0,
        cta: document.querySelector('#quick .q-cta-t').textContent,
        busy: document.querySelector('#quick .q-cta').classList.contains('busy'),
        focus: document.activeElement?.getAttribute('data-q'),
        app: !!window.__app,
      }));
      // 1) HTML вместо main.js, нажали до сбоя
      const nav = P.page.goto(`${t.server.base}/mvp/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await P.page.waitForSelector('#quick .q-cta', { timeout: 10000 });
      const t0 = Date.now();
      await P.tap('#quick .q-cta');
      await P.must(() => (window.__qaTracks ?? []).length > 0, 5000, 'html: камера открыта заставкой до сбоя');
      await nav;
      await P.must(failShown, 15000, 'html: экран «Попробовать снова» за ≤15 с');
      let st = await state();
      t.note(`html: экран сбоя через ${((Date.now() - t0) / 1000).toFixed(1)} с после нажатия, дорожки ${st.tracks.join(',')}`);
      assert(!st.app, 'html: приложение всё-таки стартовало');
      assert(!st.busy && st.cta !== 'Будим…', 'html: кнопка осталась «Будим…»');
      assert(st.tracks.length && st.tracks.every((x) => x === 'ended'), `html: ранние дорожки не остановлены (${st.tracks.join(',')})`);
      assert(st.focus === 'reboot', `html: фокус не на «Попробовать снова» (${st.focus})`);
      // 2) «Попробовать снова» → 404 на main.js: экран сбоя ещё до нажатия, камеру не спрашиваем
      mode = '404';
      await P.tap('#quick [data-q="reboot"]');
      await P.must(() => /_boot=/.test(location.search) && !!document.querySelector('#quick .q-fail') && !document.querySelector('#quick .q-fail').classList.contains('hidden'), 20000, '404: перезагрузка с _boot и экран сбоя');
      mode = 'ok'; // ассет вернулся
      await P.tap('#quick [data-q="reboot"]');
      await P.must(() => !!window.__quick?.booted, 60000, 'перезагрузка после восстановления ассета');
      st = await state();
      assert(st.gum === 0, `404: камеру спросили (${st.gum})`);
      // 3) ассет на месте: одно нажатие → один захват камеры → поиск карты
      await P.must(() => !!document.querySelector('#quick .q-cta') && !document.querySelector('#quick .q-cta').disabled, 10000, 'кнопка после перезагрузки');
      await P.tap('#quick .q-cta');
      await P.install();
      await P.must(() => window.__app.director.state.phase !== 'start' && (window.__app.tracker.video?.readyState ?? 0) >= 2, 60000, 'камера и поиск карты');
      const after = await P.ev(() => ({ gum: window.__qaGum ?? 0, live: (window.__qaTracks ?? []).filter((x) => x.readyState === 'live' && x.kind === 'video').length, url: location.search, phase: window.__app.director.state.phase }));
      t.note(`после восстановления: фаза ${after.phase}, getUserMedia ×${after.gum}, живых видеодорожек ${after.live}`);
      assert(after.gum === 1, `дубль захвата камеры: getUserMedia ×${after.gum}`);
      assert(after.live === 1, `живых видеодорожек ${after.live}`);
      assert(!/_boot=/.test(after.url), 'метка _boot осталась в адресе');
    },
  },

  // ───────────── 2. камера ─────────────
  {
    name: '02_camera_granted_meet',
    title: 'камера разрешена → поиск (глаза, лапки) → карта → пробуждение → знакомство (поле имени) → игра',
    timeout: 400,
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, {}));
      await P.must(() => !!document.querySelector('#quick .q-cta'), 10000, 'кнопка');
      await P.tap('#quick .q-cta');
      await P.install();
      await watchTexts(P);
      // детский слой поиска: плашка с глазами (кота нет), холст лапок
      const seen = { eyes: false, search: false, found: false, awake: false, nameField: false };
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        const s = await P.ev(() => {
          const a = window.__app, sc = document.querySelector('.scan');
          return {
            eyes: !!sc && !sc.classList.contains('hidden') && !!sc.querySelector('.scan-eyes') && !sc.querySelector('.scan-peek'),
            search: !!document.querySelector('canvas.card-search'),
            found: !!a.tracker.isTracking,
            awake: !!a.awake?.active,
            phase: a.director.state.phase,
            catVisibleScanning: a.director.state.phase === 'scanning' && a.stage.root.visible && !a.awake?.active,
          };
        });
        for (const k of ['eyes', 'search', 'found', 'awake']) if (s[k]) seen[k] = true;
        assert(!s.catVisibleScanning, 'кот виден во время поиска карты (до пробуждения)');
        if (s.phase === 'ask_name') break;
        await sleep(150);
      }
      t.note(`поиск: глаза ${seen.eyes}, лапки ${seen.search}, карта ${seen.found}, пробуждение ${seen.awake}`);
      assert(seen.search, 'нет слоя поиска (лапки по карте)');
      assert(seen.eyes, 'нет плашки с глазами при поиске');
      assert(seen.found, 'карта не найдена');
      assert(seen.awake, 'не было пробуждения');
      // знакомство: голос недоступен (на стенде нет модели Vosk) → поле ввода имени
      await P.must(() => !document.querySelector('.namebox').classList.contains('hidden'), 60000, 'поле «Как тебя зовут?»');
      await P.tap('.namebox input');
      await P.page.keyboard.type('Ксюша');
      await P.tap('.namebox [data-a="name"]');
      // выбор кота (pilot.catPick): лист после имени — касание карточки того, кто вышел
      await P.must(() => !document.querySelector('.choice-sheet').classList.contains('hidden'), 30000, 'лист «Выбери своего кота»');
      await P.tap(`.choice-sheet .choice[data-p="${await P.ev(() => window.__app.director.persona.id)}"]`);
      await P.must(() => ['play', 'free'].includes(window.__app.director.state.phase), 60000, 'игра после имени');
      // пилот без «ласки» (pilot.noCare): meet_skills звучит озвученным вариантом help («Я умею сальто, танцы…») — с его id
      await P.must(() => (window.__qaRec ?? []).some((r) => r.kind === 'speak' && /meet_skills|\.help\./.test(r.id ?? '')), 60000, 'кот договорил знакомство (meet_skills)');
      await P.must(() => !window.__app.voice.speaking, 20000, 'реплика знакомства кончилась');
      const said = (await P.rec('speak')).map((r) => r.id);
      t.note(`знакомство: ${said.join(', ')}`);
      // первая игра: кнопки работают (гейт «сначала познакомимся» снят)
      await P.must(SETTLED, 40000, 'кот свободен после знакомства');
      const r0 = await rt(P);
      const how = await pick(P, 'dance');
      await settle(P, 'dance');
      const s = await since(P, r0);
      assert(s.log.some((l) => /dance|танц/i.test(l)), `первое действие «Потанцуем» (${how}) не прошло`);
      t.note(`первое действие: ${how}, клипы ${s.clips.join(',')}`);
    },
  },
  {
    name: '02_camera_denied_retry',
    title: 'камера запрещена → экран инструкции → «Попробовать ещё раз» (снова нет → «Обновить»; разрешили → поиск)',
    timeout: 300,
    allow: [{ re: /Permission denied|NotAllowedError/, why: 'запрет камеры — ожидаемое console.error(e) в app.wake' }],
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, { url: null }));
      await P.page.evaluateOnNewDocument(() => {
        window.__denyCam = true;
        const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md);
        md.getUserMedia = (c) => (window.__denyCam && c?.video ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : gum(c));
      });
      await P.go('');
      await P.tap('#quick .q-cta');
      await P.must(() => !document.querySelector('#quick .q-denied').classList.contains('hidden'), 15000, 'экран «Без камеры кот не увидит карту»');
      const txt = await P.ev(() => document.querySelector('#quick .q-denied').textContent);
      assert(/iPhone/.test(txt) && /Разрешить/.test(txt), 'нет инструкции для iPhone');
      assert(await P.ev(() => document.querySelector('#quick .q-how-i') === document.querySelector('#quick .q-hows').firstElementChild), 'iPhone: инструкция Safari должна быть первой');
      await P.must(() => !!window.__app?.input && window.__quick?.ready, 180000, 'приложение готово');
      // снова нет — повторный экран и «Обновить страницу»
      await P.tap('#quick [data-q="retry"]');
      await P.must(() => !document.querySelector('#quick .q-again').classList.contains('hidden') && !document.querySelector('#quick .q-denied').classList.contains('hidden'), 15000, '«Обновить страницу» после второго отказа');
      // разрешили в настройках → «Попробовать ещё раз» → камера и поиск
      await P.ev(() => (window.__denyCam = false));
      await P.tap('#quick [data-q="retry"]');
      await P.must(() => (window.__app.tracker.video?.readyState ?? 0) >= 2 && window.__app.director.state.phase !== 'start', 30000, 'камера пошла после «Попробовать ещё раз»');
      await P.must(() => document.querySelector('#quick').classList.contains('hidden') || document.querySelector('#quick').classList.contains('q-leave'), 10000, 'заставка ушла');
      const evs = events(t.server).map((e) => e.name);
      assert(evs.includes('camera_denied') && evs.includes('camera_retry'), `воронка: нет camera_denied/camera_retry (${evs.join(',')})`);
    },
  },
  {
    name: '02_mic_denied',
    title: 'микрофон запрещён → тост «жми кнопки», кот не зовёт «Скажи…»',
    timeout: 400,
    async fn(t) {
      const n0 = t.server.requests.length;
      const P = t.track(await openPhone(t.browser, t.server, { denyMic: true, memory: MET('hooligan') }));
      await toPlay(P);
      await watchTexts(P);
      await P.must(() => (window.__e2eTexts ?? []).some((x) => x.sel === '.toast' && /микрофон/i.test(x.t)), 20000, 'тост «Нет доступа к микрофону — жми кнопки»');
      // тишина: подсказки кота (help, чипы, idle) — минуту виртуального времени
      await P.setK(4);
      await sleep(25000);
      await P.setK(1);
      const texts = await P.ev(() => window.__e2eTexts.map((x) => `${x.sel}: ${x.t}`));
      const speak = (await P.rec('speak')).map((r) => `${r.id}: ${r.text}`);
      const bad = [...texts, ...speak].filter((s) => SAY_RE.test(s.split(': ').slice(1).join(': ')));
      t.note(`показано ${texts.length} текстов, ${speak.length} реплик`);
      assert(!bad.length, `без микрофона кот зовёт говорить: ${bad.slice(0, 4).join(' | ')}`);
      // OPT-01: без микрофона модель распознавания (46 МБ) не качаем — ни HEAD, ни GET (прогрев после посадки — 40 с)
      const vosk = t.server.requests.slice(n0).filter((r) => /vosk/i.test(r.path)).map((r) => `${r.method} ${r.path}`);
      assert(!vosk.length, `без микрофона запрошена модель Vosk: ${vosk.slice(0, 3).join(', ')}`);
    },
  },

  // ───────────── 3. каждый кот: каталог, фирменное, касания ─────────────
  ...PERSONAS.map((persona) => ({
    name: `03_cat_${persona}`,
    title: `${persona}: все кнопки каталога пилота, фирменное, двойной тап, касания пальцем — без зависших поз`,
    timeout: 900,
    async fn(t) {
      const P = await playing(t, persona);
      const items = await catalogItems(P);
      const acts = items.filter((i) => i.action && i.action !== 'other' && i.action !== 'riddle');
      const sig = { hooligan: ['skate', 'glass'], kind: ['cocoa', 'bubbles'], glitter: ['mirror', 'bubbles'] }[persona];
      for (const s of sig) assert(acts.some((a) => a.action === s), `в каталоге нет фирменного «${s}»`);
      assert(!items.some((i) => i.sec === 'say'), 'в пилоте раздел «Скажи мне» должен быть скрыт');
      const rows = [];
      for (const it of acts) {
        const r0 = await rt(P);
        const how = await pick(P, it.id);
        assert(how, `не нажать «${it.label}»`);
        const ms = await settle(P, it.label);
        // «К стеклу» (Хулиган) дышит на стекло — туман на весь экран (glass.fogDraw): протираем, иначе касания — по туману
        if (await P.ev(() => !!window.__app.fogBoard?.on)) {
          await P.tap('.fogb-wipe');
          await P.must(() => !window.__app.fogBoard.on, 3000, `«${it.label}»: «Протереть стекло»`);
          await settle(P, `${it.label}: туман`);
        }
        const s = await since(P, r0);
        const cut = s.log.find((l) => /нет в наборе пилота/.test(l));
        assert(!cut, `«${it.label}» в каталоге, но вырезано: ${cut}`);
        const visible = s.speak.length + s.bubble.length > 0;
        rows.push(`${it.action}(${how}) ${ms}мс ${s.clips.filter((c) => c !== 'idle').join('/') || '-'}${visible ? ' 💬' : ''}`);
        assert(s.clips.some((c) => c && !/^(idle|talk)$/.test(c)) || visible || s.log.some((l) => l.includes(it.action)), `«${it.label}»: нет ни клипа, ни реплики`);
      }
      t.note(rows.join(' · '));
      // касания пальцем: тап по голове, двойной тап, погладить (провести по спине) — каждое с реакцией
      const gest = [];
      const gesture = async (what, fn) => {
        await P.must(SETTLED, 15000, `кот свободен перед «${what}»`);
        const box = await catBox(P);
        assert(box, 'кот не на экране');
        const r0 = await rt(P);
        await fn(box);
        await sleep(1500);
        await settle(P, what);
        const s = await since(P, r0);
        const hit = s.log.filter((l) => /^interaction:|stroke|погла|мурч/i.test(l));
        gest.push(`${what}: ${hit[0] ?? '—'}`);
        if (!hit.length) {
          const under = await P.ev((b) => {
            const e = document.elementFromPoint(b.cx, b.head);
            return `${e?.tagName}.${e?.className} в (${Math.round(b.cx)}, ${Math.round(b.head)}), кот ${JSON.stringify(window.__app.rawCatRect())}; fog ${document.querySelector('.fogb')?.className}; phase ${window.__app.director.state.phase}`;
          }, box);
          throw new Error(`«${what}»: кот не отреагировал (под пальцем ${under}; лог: ${s.log.slice(0, 4).join(' | ')})`);
        }
      };
      await gesture('тап по голове', (b) => P.tapXY(b.cx, b.head));
      await gesture('двойной тап', async (b) => {
        await P.tapXY(b.cx, b.mid);
        await sleep(90);
        await P.tapXY(b.cx, b.mid);
      });
      await gesture('погладить пальцем', (b) => swipe(P, [{ x: b.cx - b.half * 0.6, y: b.mid - 10 }, { x: b.cx + b.half * 0.6, y: b.mid - 10 }, { x: b.cx - b.half * 0.6, y: b.mid - 10 }, { x: b.cx + b.half * 0.6, y: b.mid - 10 }], 1200));
      t.note(gest.join(' · '));
    },
  })),

  // ───────────── 4. быстрые нажатия, очередь, смена кота ─────────────
  {
    name: '04_rapid_taps_queue',
    title: '10 тапов за 2 с (кот и кнопка), действие → другое действие, «Пропустить» имени',
    timeout: 500,
    async fn(t) {
      const P = await playing(t, 'hooligan');
      const box = await catBox(P);
      for (let i = 0; i < 10; i++) {
        await P.tapXY(box.cx + (i % 3) * 6, box.head + (i % 2) * 20);
        await sleep(190);
      }
      await settle(P, '10 тапов по коту', 20000);
      // 10 нажатий одной кнопки за 2 с: одно действие, остальное — «повтор»
      const r0 = await rt(P);
      for (let i = 0; i < 10; i++) {
        await pick(P, 'dance');
        await sleep(190);
      }
      await settle(P, '10 × «Потанцуем»', 25000);
      const s = await since(P, r0);
      const starts = s.log.filter((l) => /🎬/.test(l) && /dance/.test(l) && /конец/.test(l)).length;
      t.note(`10 × «Потанцуем»: ${starts} законченных номеров, «повтор»: ${s.log.filter((l) => /повторно|уже идёт/.test(l)).length}`);
      assert(starts <= 3, `«Потанцуем» сыграно ${starts} раз из 10 быстрых нажатий`);
      // действие → другое действие: сальто сразу за танцем ждёт очереди и выполняется
      const r1 = await rt(P);
      await pick(P, 'dance');
      await sleep(300);
      await pick(P, 'flip');
      await settle(P, 'танец → сальто', 25000);
      const s1 = await since(P, r1);
      assert(s1.log.some((l) => /«flip»/.test(l)), 'сальто после танца потерялось');
      // «Пропустить» на знакомстве: новый ребёнок, быстрые тапы во время знакомства, имя — «Пропустить»
      const Q = t.track(await openPhone(t.browser, t.server, {}));
      await Q.tap('#quick .q-cta');
      await Q.install();
      await Q.must(() => !document.querySelector('.namebox').classList.contains('hidden'), 180000, 'поле имени');
      const b2 = await catBox(Q);
      if (b2) for (let i = 0; i < 6; i++) await Q.tapXY(b2.cx, b2.head), await sleep(150);
      await Q.tap('.namebox [data-a="skip"]');
      // после «Пропустить» — лист «Выбери своего кота» (pilot.catPick): выбираем того, кто вышел
      await Q.must(() => !document.querySelector('.choice-sheet').classList.contains('hidden'), 30000, 'лист выбора кота после «Пропустить»');
      await Q.tap(`.choice-sheet .choice[data-p="${await Q.ev(() => window.__app.director.persona.id)}"]`);
      await Q.must(() => ['play', 'free'].includes(window.__app.director.state.phase), 60000, 'игра после «Пропустить»');
      const mem = await Q.ev(() => JSON.parse(localStorage.getItem('sber-ar-cat:v1') || '{}'));
      assert(!mem.name, 'после «Пропустить» в памяти есть имя');
    },
  },
  {
    name: '04_switch_cooldown',
    title: 'смена кота листом «Позвать другого кота» (26.11): «Не сейчас» (кот прежний, кулдаун цел) → карточка → новый кот со вспышкой; таймер на кнопке, «Чуть позже»; ?cooldown=0 — смена ×3',
    timeout: 600,
    async fn(t) {
      const P = await playing(t, 'hooligan');
      // «Другой кот» — лист с двумя другими котами и «Не сейчас»; «Не сейчас» — кот прежний, кулдаун цел
      await pick(P, 'other');
      await P.must(() => !document.querySelector('.choice-sheet').classList.contains('hidden'), 8000, 'лист «Позвать другого кота»');
      const sheet = await P.ev(() => ({ title: document.querySelector('.choice-sheet .sheet-title').textContent, cards: [...document.querySelectorAll('.choice-sheet .choice')].map((b) => b.dataset.p) }));
      t.note(`лист: ${sheet.title} — ${sheet.cards.join(', ')}`);
      assert(sheet.title === 'Позвать другого кота', `заголовок листа: ${sheet.title}`);
      assert(sheet.cards.length === 2 && !sheet.cards.includes('hooligan'), `карточки: ${sheet.cards.join(', ')}`);
      assert(await P.ev(() => !document.querySelector('.sticker, .stickers-cover') && window.__app.director.state.phase !== 'switching'), 'наклейки при «Другой кот»');
      await P.tap('.choice-sheet .choice-close');
      await P.must(() => document.querySelector('.choice-sheet').classList.contains('hidden'), 5000, '«Не сейчас» закрыл лист');
      await settle(P, '«Не сейчас»', 20000);
      await sleep(900); // то же действие сразу после конца — «повтор» (оркестратор, REPEAT_MS)
      assert(await P.ev(() => window.__app.director.persona.id === 'hooligan' && window.__app.switchCooldown.allow(performance.now())), '«Не сейчас»: кот сменился или кулдаун потрачен');
      // карточка → новый кот (модель, голос, пузырь — его)
      await pick(P, 'other');
      await P.must(() => !document.querySelector('.choice-sheet').classList.contains('hidden'), 8000, 'лист (2)');
      const r0 = await rt(P);
      await P.tap('.choice-sheet .choice[data-p="kind"]');
      await P.must(() => window.__app.director.persona.id === 'kind', 10000, 'выбран Добряк');
      await P.must(() => window.__app.charFor === 'kind' && /kind/.test(window.__app.character.url ?? ''), 30000, 'модель Добряка');
      await P.must(SETTLED, 30000, 'новый кот свободен');
      const s1 = await since(P, r0);
      t.note(`после выбора: ${s1.speak.join(', ')} | ${s1.bubble.join(' | ')}`);
      assert(s1.speak.some((id) => /^kind\.meet_self/.test(id)), `Добряк не представился своим голосом: ${s1.speak.join(', ')}`);
      assert(!s1.speak.some((id) => /^hooligan\./.test(id)), `после выбора говорил Хулиган: ${s1.speak.join(', ')}`);
      // кулдаун: таймер на кнопке, «Чуть позже»
      const wait = await P.ev(() => document.querySelector('[data-act="other"], [data-item="other"]')?.dataset.wait ?? null);
      t.note(`таймер на «Другой кот»: ${wait}`);
      assert(wait && /^\d:\d\d$/.test(wait), `нет таймера на кнопке «Другой кот» (${wait})`);
      const r1 = await rt(P);
      await pick(P, 'other');
      const later = await P.until((r0) => (window.__qaRec ?? []).some((x) => x.rt >= r0 && ((x.kind === 'bubble' && /Чуть позже/.test(x.txt ?? '')) || (x.kind === 'speak' && /switch_later/.test(x.id ?? '')))), 10000, r1);
      const s = await since(P, r1);
      assert(later, `нет «Чуть позже» (${s.bubble.join(' | ')})`);
      assert(await P.ev(() => document.querySelector('.choice-sheet').classList.contains('hidden') && window.__app.director.persona.id === 'kind'), 'кулдаун пропустил смену (лист открылся)');
      await P.close();
      // ?cooldown=0 (страница /test): смена ×3 подряд
      const Q = await playing(t, 'hooligan', 'from=test&cooldown=0');
      const seen = [await Q.ev(() => window.__app.director.persona.id)];
      for (let i = 0; i < 3; i++) {
        await pick(Q, 'other');
        if (!(await Q.until(() => !document.querySelector('.choice-sheet').classList.contains('hidden'), 10000))) throw new Error(`смена ${i + 1}: лист не открылся (${(await Q.log()).slice(-4).join(' | ')})`);
        const to = await Q.ev(() => document.querySelector('.choice-sheet .choice').dataset.p);
        await Q.tap(`.choice-sheet .choice[data-p="${to}"]`);
        await Q.must((p) => window.__app.director.persona.id === p, 20000, `смена ${i + 1}`, to);
        seen.push(to);
        await Q.must(() => window.__app.charFor === window.__app.director.persona.id, 30000, `смена ${i + 1}: модель нового кота`);
        await settle(Q, `смена ${i + 1}`, 30000);
        await sleep(900);
      }
      t.note(`cooldown=0: ${seen.join(' → ')}`);
    },
  },

  // ───────────── 5. дом ─────────────
  {
    name: '05_home',
    title: 'дом: вход/выход, комнаты, кухня (покормить), спальня (уложить → разбудить), обратно на карту без «карточка пропала»',
    timeout: 600,
    async fn(t) {
      const P = await playing(t, 'kind');
      await P.tap('.tom-home');
      await P.must(() => window.__app.home.phase === 'home', 20000, 'дома');
      // камера дома выключена (индикатор камеры iOS гаснет)
      assert(await P.ev(() => !window.__app.tracker.video), 'дома камера не выключилась');
      // стрелки встают над рядом комнаты на первом такте меню (~250 мс; до этого — посередине края)
      await sleep(600);
      // комнаты: стрелки
      const z0 = await P.ev(() => window.__app.home.zone);
      const under = await P.ev(() => {
        const r = document.querySelector('.home-arrow.l').getBoundingClientRect(), e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return e?.closest('.home-arrow') ? 'стрелка' : `${e?.tagName}.${e?.className?.baseVal ?? e?.className}`;
      });
      await P.tap('.home-arrow.l');
      if (!(await P.until((z) => window.__app.home.zone !== z && !window.__app.home.moving, 15000, z0))) throw new Error(`стрелка «влево» не сменила комнату (под пальцем: ${under})`);
      const zones = [z0, await P.ev(() => window.__app.home.zone)];
      // кухня: покормить
      if (zones[1] !== 'kitchen') await P.ev(() => window.__app.home.go('kitchen'));
      await P.must(() => window.__app.home.zone === 'kitchen' && !window.__app.home.moving, 15000, 'кухня');
      await P.must(() => !!document.querySelector('.tom-room [data-item="home:treat"]'), 10000, 'кнопка «Угостить»');
      const r0 = await rt(P);
      await P.tap('.tom-room [data-item="home:treat"]');
      await settle(P, 'Угостить', 20000);
      const s = await since(P, r0);
      assert(s.log.some((l) => /treat|угост|миск/i.test(l)), 'кормление без реакции');
      // спальня: уложить → разбудить
      await P.ev(() => window.__app.home.go('bedroom'));
      await P.must(() => window.__app.home.zone === 'bedroom' && !window.__app.home.moving, 15000, 'спальня');
      await P.must(() => !!document.querySelector('.tom-room [data-item="home:sleep"]'), 10000, 'кнопка «Уложить спать»');
      await P.tap('.tom-room [data-item="home:sleep"]');
      await P.must(() => window.__app.home.bed?.state === 'asleep' || window.__app.director.dozing, 30000, 'кот уснул');
      await P.must(() => !!document.querySelector('.tom-room [data-item="home:wake"]'), 10000, 'кнопка «Разбудить»');
      await P.tap('.tom-room [data-item="home:wake"]');
      await P.must(() => (window.__app.home.bed?.state ?? 'idle') !== 'asleep' && !window.__app.director.dozing, 30000, 'кот проснулся');
      await P.must(() => !window.__app.home.bed || ['idle', 'awake', 'none'].includes(window.__app.home.bed.state) || !window.__app.home.bed.holdsCat, 30000, 'кот встал с кровати');
      await settle(P, 'разбудить', 25000);
      // на карту
      const r1 = await rt(P);
      await P.tap('.tom-home');
      await P.must(() => window.__app.home.phase === 'ar' && window.__app.tracker.isTracking, 40000, 'снова на карте');
      await sleep(9000);
      const s1 = await since(P, r1);
      const lost = [...s1.bubble, ...s1.speak].filter((x) => /пропал|card_lost/i.test(x ?? ''));
      assert(!lost.length, `после «На карту» — «карточка пропала»: ${lost.join(' | ')}`);
      assert(await P.ev(() => (window.__qaGum ?? 0) <= 2), 'на карту — второй запрос разрешения');
      t.note(`комнаты: ${zones.join(' → ')} → kitchen → bedroom; запросов камеры ${await P.ev(() => window.__qaGum ?? 0)}`);
    },
  },

  // ───────────── 6. раскраска и туман ─────────────
  {
    name: '06_paint',
    title: 'раскраска карты: лист цветов («Не надо»), старт → завершение, стереть',
    timeout: 400,
    async fn(t) {
      const P = await playing(t, 'glitter');
      await pick(P, 'ui:paint');
      await P.must(() => !!document.querySelector('.paint-sheet .ps-sw'), 10000, 'лист «Выбери цвет»');
      await P.tap('.paint-sheet .ps-no');
      await P.must(() => !document.querySelector('.paint-sheet') || !window.__app.paint.sheetOpen, 5000, '«Не надо» закрыл лист');
      await settle(P, 'лист цветов', 15000);
      await pick(P, 'ui:paint');
      await P.must(() => !!document.querySelector('.paint-sheet .ps-sw'), 10000, 'лист «Выбери цвет» (2)');
      await P.tap('.paint-sheet .ps-sw[data-i="1"]');
      await P.must(() => window.__app.paint.painting, 5000, 'рисует');
      await P.must(() => !window.__app.paint.painting, 30000, 'рисунок закончен');
      await settle(P, 'раскраска', 20000);
      const log = await P.log();
      assert(log.some((l) => /раскраск/i.test(l)), 'нет записи раскраски');
      const saved = await P.ev(() => localStorage.getItem('sber-ar-cat:paint'));
      assert(saved, 'рисунок не запомнен');
      await pick(P, 'ui:paint_erase');
      await P.must(() => !localStorage.getItem('sber-ar-cat:paint'), 5000, '«Стереть рисунок» очистил память');
      const evs = events(t.server).map((e) => e.name);
      assert(evs.includes('paint_start') && evs.includes('paint_done') && evs.includes('paint_erase'), `воронка раскраски: ${evs.filter((e) => /paint/.test(e)).join(',')}`);
    },
  },
  {
    name: '06_fog',
    title: 'туман на стекле: долгое нажатие мимо кота → рисование пальцем → «Протереть стекло»',
    timeout: 300,
    async fn(t) {
      const P = await playing(t, 'kind');
      const box = await catBox(P);
      // мимо кота: свободное место на холсте эффектов (не кнопка, не кот)
      const pt = await P.ev((b) => {
        // зона касания кота шире его силуэта (hitZone) — подальше от кота: под картой, у краёв
        const cands = [[195, 620], [110, 640], [290, 640], [195, 560], [60, 120], [330, 120]];
        for (const [x, y] of cands) {
          const e = document.elementFromPoint(x, y);
          const onCat = x > b.cx - b.half * 1.8 && x < b.cx + b.half * 1.8 && y > b.top - 60 && y < b.bottom + 40;
          if (e?.classList.contains('fx-layer') && !onCat) return { x, y };
        }
        return null;
      }, box);
      assert(pt, 'нет свободного места мимо кота для долгого нажатия');
      await longPress(P, pt.x, pt.y, 1000);
      await P.must(() => window.__app.fogBoard?.on, 6000, 'стекло запотело');
      await sleep(1000); // туман расходится (0,9 с) — ребёнок начинает рисовать, когда видит его
      await swipe(P, [{ x: 80, y: 300 }, { x: 300, y: 340 }, { x: 120, y: 480 }, { x: 290, y: 520 }], 800);
      const drawn = await P.ev(() => window.__app.fogBoard.drawn);
      t.note(`нарисовано пальцем: ${Math.round(drawn)}`);
      assert(drawn > 0, 'палец не рисует по туману (touch)');
      await P.tap('.fogb-wipe');
      await P.must(() => !window.__app.fogBoard.on, 3000, '«Протереть стекло» убрал туман');
      await settle(P, 'туман', 15000);
    },
  },

  // ───────────── 7. СберKids ─────────────
  {
    name: '07_sberkids',
    title: 'кнопка СберKids: дома (закрыть) и после игры (клик → событие и страница СберKids)',
    timeout: 500,
    async fn(t) {
      const n0 = t.server.requests.length;
      // день (hour=14): утром первый вход в дом — кот спит в кровати (home/bedFlow.ts), карточка СберKids ждёт его
      // пробуждения — сценарий зависел от часов стенда (24.11 в 09:00 падал и на main)
      const P = await playing(t, 'hooligan', 'hour=14');
      await P.tap('.tom-home');
      await P.must(() => window.__app.home.phase === 'home', 20000, 'дома');
      await P.must(() => !document.querySelector('.kids-card').classList.contains('hidden'), 20000, 'карточка «Войти в СберKids» дома');
      assert(await P.ev(() => document.querySelector('.kids-card').dataset.where === 'home'), 'карточка не «home»');
      await P.tap('.kids-card .kc-x');
      await P.must(() => document.querySelector('.kids-card').classList.contains('hidden'), 3000, 'карточка закрылась');
      await P.tap('.tom-home');
      await P.must(() => window.__app.home.phase === 'ar' && window.__app.tracker.isTracking, 40000, 'на карте');
      await settle(P, 'на карту', 20000);
      // после игры: 12 действий и ≥ 90 с игры (время ×6)
      await P.setK(6);
      // пилот без «ласки» (pilot.noCare): угостить, лапа, танец, сальто
      const acts = ['paw', 'dance', 'flip', 'treat', 'paw', 'dance', 'flip', 'treat', 'paw', 'dance', 'flip', 'treat', 'paw'];
      for (const a of acts) {
        await pick(P, a);
        await P.until(SETTLED, 8000);
        if (await P.visible('.kids-card')) break;
      }
      await P.must(() => !document.querySelector('.kids-card').classList.contains('hidden'), 30000, 'карточка СберKids после игры');
      await P.setK(1);
      assert(await P.ev(() => document.querySelector('.kids-card').dataset.where === 'play'), 'карточка не «play»');
      const popup = new Promise((r) => t.browser.once('targetcreated', (tg) => r(tg.url())));
      await P.tap('.kids-card .kc-go');
      const url = await Promise.race([popup, sleep(5000).then(() => null)]);
      const sheet = await P.visible('.kids-sheet');
      t.note(`клик: ${url ? 'вкладка ' + url : sheet ? 'лист со ссылкой' : 'ничего'}`);
      assert(url || sheet, 'клик по «Войти в СберKids» ничего не открыл');
      await sleep(800);
      const kinds = events(t.server, n0).filter((e) => e.name === 'sberkids_click').map((e) => e.props.kind);
      assert(kinds.includes('close_home') && kinds.some((k) => /_play$/.test(k) && !/close/.test(k)), `события sberkids_click: ${kinds.join(',')}`);
      for (const pg of await t.browser.pages()) if (/sber|kids/i.test(pg.url()) && !pg.url().includes('127.0.0.1')) await pg.close().catch(() => undefined);
    },
  },

  {
    name: '07_sberkids_morning',
    title: 'утро (?hour=8): дома кот спит — карточка СберKids ждёт (не будит и не мешает), «Разбудить» → карточка «home»',
    timeout: 300,
    async fn(t) {
      const P = await playing(t, 'hooligan', '', { hour: 8 });
      await P.tap('.tom-home');
      await P.must(() => window.__app.home.phase === 'home', 20000, 'дома');
      await P.must(() => window.__app.home.bed?.state === 'asleep', 15000, 'утром кот спит в кровати');
      // кот спит (uiContext busy 'sleep') — карточку не показываем; через 6 с она была бы днём
      await sleep(10000);
      assert(await P.ev(() => document.querySelector('.kids-card').classList.contains('hidden')), 'карточка СберKids поверх спящего кота');
      await P.must(() => !!document.querySelector('.tom-room [data-item="home:wake"]'), 10000, 'кнопка «Разбудить»');
      await P.tap('.tom-room [data-item="home:wake"]');
      await P.must(() => (window.__app.home.bed?.state ?? 'idle') !== 'asleep' && !window.__app.director.dozing, 30000, 'кот проснулся');
      await P.must(() => !document.querySelector('.kids-card').classList.contains('hidden'), 40000, 'карточка «Войти в СберKids» дома после пробуждения');
      assert(await P.ev(() => document.querySelector('.kids-card').dataset.where === 'home'), 'карточка не «home»');
    },
  },

  // ───────────── 8. аналитика ─────────────
  {
    name: '08_analytics_funnel',
    title: 'воронка page_open…first_action с ?src=test1, без имени ребёнка ни в одном запросе, /api/progress — мок',
    timeout: 400,
    async fn(t) {
      const n0 = t.server.requests.length;
      const NAME = 'Ксюша';
      const P = t.track(await openPhone(t.browser, t.server, { q: 'src=test1' }));
      await toPlay(P, { name: NAME });
      await P.must(SETTLED, 40000, 'кот договорил');
      await pick(P, 'paw');
      await settle(P, 'paw');
      await sleep(2500);
      // события только этого телефона: сервер стенда общий, и session_end прошлого сценария (его вкладку закрыли —
      // sendBeacon при pagehide) иногда доходит уже после n0 — без src=test1 (флейк 24.11 «события без src=test1: session_end»)
      const device = await P.ev(() => window.__analytics?.o?.device ?? null);
      assert(device, 'нет id устройства аналитики (window.__analytics)');
      // pagehide → session_end
      await P.page.goto('about:blank').catch(() => undefined);
      await sleep(1000);
      const all = events(t.server, n0);
      const evs = all.filter((e) => e.device === device);
      if (all.length > evs.length) t.note(`чужих событий (прошлые вкладки): ${all.filter((e) => e.device !== device).map((e) => e.name).join(' ')}`);
      const names = evs.map((e) => e.name);
      t.note(`события: ${names.join(' ')}`);
      assert(names.includes('session_end'), 'нет session_end при уходе со страницы');
      const want = ['page_open', 'splash_shown', 'cta_tap', 'camera_granted', 'mic_granted', 'card_search_start', 'card_found', 'cat_awake', 'named', 'first_action'];
      const miss = want.filter((n) => !names.includes(n));
      assert(!miss.length, `в воронке нет: ${miss.join(', ')}`);
      // порядок шагов воронки входа (ms от навигации не убывает)
      // page_open шлёт бандл при старте (его ms — когда бандл загрузился, позже splash_shown из index.html) — вне порядка
      const ms = want.filter((n) => n !== 'page_open' && evs.find((e) => e.name === n)?.props?.ms !== undefined).map((n) => [n, evs.find((e) => e.name === n).props.ms]);
      t.note(`ms от навигации: ${ms.map(([n, v]) => `${n} ${v}`).join(', ')}; page_open ${evs.find((e) => e.name === 'page_open')?.props?.ms}`);
      for (let i = 1; i < ms.length; i++) assert(ms[i][1] >= ms[i - 1][1] - 5, `шаги воронки не по порядку: ${ms[i - 1][0]} ${ms[i - 1][1]} > ${ms[i][0]} ${ms[i][1]}`);
      const noSrc = evs.filter((e) => e.src !== 'test1');
      assert(!noSrc.length, `события без src=test1: ${noSrc.map((e) => e.name).join(',')}`);
      const dup = want.filter((n) => names.filter((x) => x === n).length > 1);
      assert(!dup.length, `шаги воронки отправлены дважды: ${dup.join(',')}`);
      // имя не уходит никуда: ни в теле, ни в адресе, ни в каком виде
      const forms = [NAME, NAME.toLowerCase(), encodeURIComponent(NAME), encodeURIComponent(NAME.toLowerCase()), JSON.stringify(NAME).slice(1, -1).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))];
      const leak = t.server.requests.slice(n0).filter((r) => forms.some((f) => r.body.includes(f) || r.path.includes(f)));
      assert(!leak.length, `имя ребёнка ушло в запрос: ${leak.map((r) => `${r.method} ${r.path}`).join(', ')}`);
      const api = t.server.requests.slice(n0).filter((r) => r.path.startsWith('/api/'));
      t.note(`запросов к /api: ${api.length} (${[...new Set(api.map((r) => r.method + ' ' + r.path.replace(/[0-9a-f-]{20,}/, ':id')))].join(', ')})`);
      // имя осталось в телефоне
      const props = evs.flatMap((e) => Object.keys(e.props ?? {}));
      assert(!props.some((k) => /name|text|speech/i.test(k)), `подозрительные свойства событий: ${props.join(',')}`);
    },
  },

  // ───────────── 9. длинная сессия ─────────────
  {
    name: '09_long_session',
    title: '10 мин (время ×8): нет утечек памяти JS, геометрий, текстур, AudioBuffer, миксеров; FPS стабилен',
    timeout: 900,
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, { q: 'cat=hooligan', memory: MET('hooligan'), url: null }));
      // счётчики AudioBuffer и миксеров (живые = созданные − собранные сборщиком)
      await P.page.evaluateOnNewDocument(() => {
        const live = (window.__e2eLive = { buffers: 0, mixers: 0, mixersSeen: 0 });
        const fr = new FinalizationRegistry((k) => live[k]--);
        const reg = (b) => (b && (live.buffers++, fr.register(b, 'buffers')), b);
        const B = window.BaseAudioContext?.prototype ?? window.AudioContext?.prototype;
        if (B) {
          const cb = B.createBuffer, dd = B.decodeAudioData;
          B.createBuffer = function (...a) { return reg(cb.apply(this, a)); };
          B.decodeAudioData = function (buf, ok, err) {
            const p = dd.call(this, buf, ok && ((b) => ok(reg(b))), err);
            return p?.then ? p.then((b) => (ok ? b : reg(b))) : p;
          };
        }
        window.__e2eMixers = new WeakSet();
        window.__e2eMixerReg = fr;
      });
      await P.go('cat=hooligan');
      await toPlay(P);
      await P.must(SETTLED, 30000, 'кот свободен');
      // миксеры: считаем по update() (прототип AnimationMixer из three, берём у кота)
      await P.ev(() => {
        const mx = window.__app.character.mixer;
        if (!mx) return;
        const proto = Object.getPrototypeOf(mx), up = proto.update, live = window.__e2eLive;
        window.__e2eMixUpd = new Set();
        proto.update = function (dt) {
          if (!window.__e2eMixers.has(this)) {
            window.__e2eMixers.add(this);
            live.mixers++;
            live.mixersSeen++;
            window.__e2eMixerReg.register(this, 'mixers');
          }
          window.__e2eMixUpd.add(this);
          return up.call(this, dt);
        };
      });
      const cdp = await P.page.createCDPSession();
      await cdp.send('Performance.enable');
      const sample = async (tag) => {
        await P.ev(() => window.__qaDraw?.(3));
        await cdp.send('HeapProfiler.collectGarbage');
        await sleep(300);
        await cdp.send('HeapProfiler.collectGarbage');
        const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const a = await P.ev(() => {
          const i = window.__app.renderer.info, upd = window.__e2eMixUpd;
          const active = upd ? upd.size : 0;
          window.__e2eMixUpd = new Set();
          return { geo: i.memory.geometries, tex: i.memory.textures, prog: i.programs?.length ?? 0, buffers: window.__e2eLive.buffers, mixers: window.__e2eLive.mixers, mixActive: active, renders: window.__qaRenders, real: window.__qaReal.now(), nodes: document.getElementsByTagName('*').length };
        });
        return { tag, heap: Math.round(m.JSHeapUsedSize / 1048576), listeners: m.JSEventListeners, ...a };
      };
      // прогрев: всё, что сессия сделает, — один раз (первые загрузки моделей, клипов, звуков — не утечка)
      const loop = ['paw', 'dance', 'flip', 'skate', 'treat', 'glass'];
      const cycle = async () => {
        for (const a of loop) {
          await pick(P, a);
          await P.until(SETTLED, 15000);
        }
        await P.tap('.tom-home');
        await P.until(() => window.__app.home.phase === 'home', 20000);
        await sleep(1500);
        await P.tap('.tom-home').catch(() => undefined);
        await P.until(() => window.__app.home.phase === 'ar' && window.__app.tracker.isTracking, 40000);
        await P.until(SETTLED, 15000);
      };
      await cycle();
      const base = await sample('после прогрева');
      const rows = [base];
      await P.setK(8);
      const vStart = await P.ev(() => performance.now());
      let fps = [];
      while ((await P.ev(() => performance.now())) - vStart < 600_000) {
        const r0 = await P.ev(() => [window.__qaRenders, window.__qaReal.now()]);
        await cycle();
        // тишина между циклами (дрёма, подсказки)
        await sleep(4000);
        const r1 = await P.ev(() => [window.__qaRenders, window.__qaReal.now()]);
        fps.push(+(((r1[0] - r0[0]) * 1000) / (r1[1] - r0[1])).toFixed(1));
        const v = Math.round(((await P.ev(() => performance.now())) - vStart) / 1000);
        t.log(`${v} с виртуальных, кадров/с ${fps[fps.length - 1]}`);
      }
      await P.setK(1);
      await P.until(SETTLED, 20000);
      const end = await sample('через 10 мин');
      rows.push(end);
      t.note(rows.map((r) => `${r.tag}: heap ${r.heap} МБ, geo ${r.geo}, tex ${r.tex}, prog ${r.prog}, AudioBuffer ${r.buffers}, миксеров живых ${r.mixers} (активных ${r.mixActive}), DOM ${r.nodes}, слушателей ${r.listeners}`).join(' | '));
      t.note(`кадров/с по циклам: ${fps.join(', ')}`);
      assert(end.heap <= base.heap * 1.3 + 15, `рост кучи JS: ${base.heap} → ${end.heap} МБ`);
      assert(end.geo <= base.geo + 10, `рост геометрий: ${base.geo} → ${end.geo}`);
      assert(end.tex <= base.tex + 6, `рост текстур: ${base.tex} → ${end.tex}`);
      assert(end.buffers <= base.buffers + 20, `рост AudioBuffer: ${base.buffers} → ${end.buffers}`);
      assert(end.mixers <= base.mixers + 1 && end.mixActive <= Math.max(base.mixActive, 2), `рост миксеров: ${base.mixers}/${base.mixActive} → ${end.mixers}/${end.mixActive}`);
      assert(end.nodes <= base.nodes * 1.2 + 50, `рост DOM: ${base.nodes} → ${end.nodes}`);
      const head = fps.slice(0, 2), tail = fps.slice(-2);
      const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
      assert(avg(tail) >= avg(head) * 0.6, `FPS падает: ${avg(head).toFixed(1)} → ${avg(tail).toFixed(1)}`);
      await cdp.detach().catch(() => undefined);
    },
  },

  // ───────────── 11. ненадёжная озвучка (iPhone 22.11: «со звуком проблемы — зависал и не грузился») ─────────────
  {
    name: '11_voice_flaky',
    title: 'медленная сеть + потерянные/зависшие mp3 + AudioContext «interrupted»: реплики — пузырём без звука, кот не зависает, причины в voice_issue',
    timeout: 600,
    // потерянные mp3 — нарочно (Fetch.failRequest); зависшие обрывает сам плеер (AbortController — ERR_ABORTED, не ошибка)
    allow: [{ re: /voice\/el\/.*\.(mp3|wav).*(ERR_FAILED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION)|Failed to load resource: net::ERR_FAILED/i, why: 'mp3 роняет сценарий 11 нарочно' }],
    async fn(t) {
      const n0 = t.server.requests.length;
      const P = t.track(await openPhone(t.browser, t.server, { url: null, memory: MET('kind') }));
      const cdp = await P.page.createCDPSession();
      await cdp.send('Network.enable');
      // медленная сеть: 3G-подобная задержка и полоса
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: (3 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      // записи озвучки (на стенде — тишина .wav от fake-voice, на сайте — mp3): каждый 3-й — ошибка сети, каждый 3-й — висит без ответа, остальные — с задержкой 1,5 с
      let n = 0;
      const lost = { fail: 0, hang: 0, slow: 0 };
      let flaky = true;
      await P.page.setRequestInterception(true);
      P.page.on('request', (r) => {
        if (!flaky || !/\/voice\/el\/.*\.(mp3|wav)(\?|$)/.test(r.url())) return void r.continue().catch(() => undefined);
        const k = n++ % 3;
        if (k === 0) {
          lost.fail++;
          void r.abort('failed').catch(() => undefined);
        } else if (k === 1) lost.hang++; // не отвечаем никогда (плеер обрывает сам по таймауту)
        else {
          lost.slow++;
          setTimeout(() => void r.continue().catch(() => undefined), 1500);
        }
      });
      await P.go('cat=kind');
      await toPlay(P);
      await watchTexts(P);
      await P.must(SETTLED, 60000, 'кот свободен после приветствия');

      /** действия подряд: каждая реплика (speak) заканчивается (speak_end) ≤ 12 с, кот освобождается */
      const round = async (tag, acts) => {
        const from = await rt(P);
        for (const a of acts) {
          if (a === 'tap') {
            const b = await catBox(P);
            if (b) await P.tapXY(b.cx, b.head);
          } else await pick(P, a);
          await settle(P, `${tag}: ${a}`, 25000);
          await sleep(800);
        }
        await sleep(3000);
        const rec = await P.ev((from) => (window.__qaRec ?? []).filter((x) => x.rt >= from && /^(speak|speak_end|bubble)$/.test(x.kind)), from);
        const speaks = rec.filter((x) => x.kind === 'speak');
        const ends = rec.filter((x) => x.kind === 'speak_end');
        const bubbles = rec.filter((x) => x.kind === 'bubble' && x.on && !x.hint);
        const long = ends.filter((x) => x.dur > 12000);
        t.note(`${tag}: реплик ${speaks.length}, закончились ${ends.length}, пузырей ${bubbles.length}, дольше 12 с: ${long.length}`);
        assert(speaks.length > 0, `${tag}: кот не сказал ни одной реплики`);
        // последняя реплика могла ещё звучать — остальные обязаны закончиться
        assert(ends.length >= speaks.length - 1, `${tag}: реплики не закончились (${ends.length} из ${speaks.length}) — кот «висит»`);
        assert(!long.length, `${tag}: реплика шла ${Math.max(...long.map((x) => x.dur))} мс`);
        assert(bubbles.length > 0, `${tag}: ни одного пузыря (реплики пропали молча)`);
        return rec;
      };

      await round('сеть', ['dance', 'tap', 'flip', 'tap']);
      t.note(`mp3: ошибка ${lost.fail}, висит ${lost.hang}, медленно ${lost.slow}`);
      assert(lost.fail + lost.hang > 0, 'ни один mp3 не потерялся — сценарий ничего не проверил');

      // AudioContext «interrupted» (iOS: камера, микрофон, звонок) и resume не отвечает: часы контекста стоят.
      // Записи — снова доходят (сеть по-прежнему медленная): немая реплика теперь — из-за контекста
      flaky = false;
      await P.ev(async () => {
        const ctx = window.__app.audio.ctx;
        await ctx.suspend();
        window.__qaCtxResume = ctx.resume;
        Object.defineProperty(ctx, 'state', { configurable: true, get: () => 'interrupted' });
        ctx.resume = () => new Promise(() => {});
      });
      await round('interrupted', ['dance', 'tap']);
      const st = await P.ev(() => window.__app.voice.timings.slice(-6).map((x) => `${x.outcome}:${x.reason ?? ''}`));
      t.note(`interrupted: ${st.join(', ')}`);
      assert(st.some((x) => /ctx_/.test(x)), 'немая реплика без причины ctx_*');

      // восстановление: контекст проснулся, сеть нормальная — снова звук
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await P.ev(async () => {
        const ctx = window.__app.audio.ctx;
        delete ctx.state;
        ctx.resume = window.__qaCtxResume;
        await ctx.resume();
      });
      await round('восстановление', ['flip', 'tap']);
      const okNow = await P.ev(() => window.__app.voice.timings.slice(-3).some((x) => x.outcome === 'ok'));
      assert(okNow, 'после восстановления контекста и сети звук не вернулся');

      // причины — в аналитику (без текста реплик и имени)
      await sleep(1000);
      const vi = events(t.server, n0).filter((e) => e.name === 'voice_issue');
      const reasons = [...new Set(vi.map((e) => e.props?.reason))];
      t.note(`voice_issue: ${vi.length} (${reasons.join(', ')})`);
      assert(vi.length > 0, 'нет событий voice_issue');
      assert(reasons.some((r) => /^ctx_/.test(r)), `в voice_issue нет причины ctx_*: ${reasons.join(', ')}`);
      assert(reasons.some((r) => /^(net_|http_|no_audio|decode_)/.test(r)), `в voice_issue нет сетевой причины: ${reasons.join(', ')}`);
      for (const e of vi) assert(Object.keys(e.props ?? {}).every((k) => ['reason', 'ms', 'net', 'dec', 'warm', 'ev', 'ctx', 'src'].includes(k)), `лишнее в voice_issue: ${JSON.stringify(e.props)}`);
      await cdp.detach().catch(() => undefined);
    },
  },

  // ───────────── 12. онборды в сервисы и пилот без «ласки» (продакт 26.11, docs/scenario/ONBOARDS.md) ─────────────
  {
    name: '12_onb_samokat',
    title: 'онборд Самоката: значок «Самокат?» → кот собирает 6 продуктов в корзину → лист «Перекус от …» → «Отправить маме на оплату»',
    timeout: 300,
    async fn(t) {
      const n0 = t.server.requests.length;
      const P = await playing(t, 'kind');
      assert(await P.ev(() => !!document.querySelector('.tom [data-item="svc:samokat"]')), 'нет значка «Самокат» в меню');
      const how = await pick(P, 'svc:samokat');
      t.note(`значок «Самокат?»: ${how}`);
      await P.must(() => window.__app.onb?.active === 'samokat', 5000, 'онборд Самоката открылся');
      await P.must(() => window.__app.onb.cart >= 2, 15000, 'продукты летят в корзину');
      await shot(t, P, 'onb_samokat_cart');
      await P.must(() => window.__app.onb.stage === 'sheet', 20000, 'лист «Перекус от …»');
      const cart = await P.ev(() => window.__app.onb.cart);
      assert(cart === 6, `в корзине ${cart}, а не 6`);
      const head = await P.ev(() => document.querySelector('.onb-head b')?.textContent ?? '');
      assert(/^Перекус от Добряка$/.test(head), `заголовок листа: «${head}»`);
      await P.must(() => !!document.querySelector('.onb [data-k="send"]'), 3000, 'кнопка «Отправить маме на оплату»');
      await sleep(600);
      await shot(t, P, 'onb_samokat_sheet');
      await P.tap('.onb [data-k="send"]');
      await P.must(() => window.__app.onb.stage === 'sent', 3000, '«Отправить» — заглушка «покажи маме»');
      await shot(t, P, 'onb_samokat_sent');
      await P.tap('.onb [data-k="done"]');
      await P.must(() => !window.__app.onb.active, 3000, 'онборд закрылся');
      const said = await P.ev(() => window.__e2eTexts.filter((x) => x.sel === '.bubble .txt').map((x) => x.t));
      for (const re of [/Это Самокат/, /собираю нам перекус/, /Отправим маме/]) assert(said.some((x) => re.test(x)), `кот не сказал ${re}: ${said.slice(-6).join(' | ')}`);
      await settle(P, 'после онборда', 15000);
      await sleep(800);
      const st = events(t.server, n0).filter((e) => e.name === 'onb_step' && e.props.svc === 'samokat').map((e) => e.props.step);
      t.note(`onb_step: ${st.join(' ')}`);
      for (const k of ['open', 'hello', 'collect', 'item', 'sheet', 'send', 'done']) assert(st.includes(k), `нет шага ${k} в onb_step`);
      for (const e of events(t.server, n0).filter((e) => e.name === 'onb_step')) assert(Object.keys(e.props ?? {}).every((k) => ['svc', 'step', 'n', 'kind', 'at', 'src'].includes(k)), `лишнее в onb_step: ${JSON.stringify(e.props)}`);
    },
  },
  {
    name: '12_onb_kids',
    title: 'онборд СберKids: значок «СберKids?» → копилка с монетками → экскурс 3 шага → «Войти в СберKids»',
    timeout: 300,
    async fn(t) {
      const n0 = t.server.requests.length;
      const P = await playing(t, 'glitter', 'src=onbtest');
      t.note(`значок «СберKids?»: ${await pick(P, 'svc:kids')}`);
      await P.must(() => window.__app.onb?.active === 'kids', 5000, 'онборд СберKids открылся');
      await P.must(() => window.__app.onb.piggy >= 40, 15000, 'монетки летят в копилку');
      await shot(t, P, 'onb_kids_piggy');
      await P.must(() => window.__app.onb.stage === 'tour', 15000, 'экскурс');
      await sleep(500);
      await shot(t, P, 'onb_kids_tour');
      // «Дальше» по шагам экскурса (шаг сам листается через 5,2 с — сколько нажатий, зависит от темпа стенда)
      const seen = new Set();
      for (let k = 0; k < 4 && (await P.ev(() => window.__app.onb.stage)) === 'tour'; k++) {
        seen.add(await P.ev(() => document.querySelector('.onb-tour')?.getAttribute('data-t')));
        await P.tap('.onb [data-k="next"]').catch(() => undefined);
        await sleep(500);
      }
      t.note(`экскурс: ${[...seen].join(' → ')}`);
      await P.must(() => window.__app.onb.stage === 'go' && !!document.querySelector('.onb [data-k="kids_go"]'), 5000, 'кнопка «Войти в СберKids»');
      await sleep(600);
      await shot(t, P, 'onb_kids_go');
      const popup = new Promise((r) => t.browser.once('targetcreated', (tg) => r(tg.url())));
      await P.tap('.onb [data-k="kids_go"]');
      const url = await Promise.race([popup, sleep(5000).then(() => null)]);
      const sheet = await P.visible('.kids-sheet');
      t.note(`«Войти в СберKids»: ${url ? 'вкладка ' + url : sheet ? 'лист со ссылкой' : 'ничего'}`);
      assert(url || sheet, '«Войти в СберKids» ничего не открыл');
      if (url) assert(/utm_source=ar_cat/.test(url) && /utm_campaign=onbtest/.test(url), `нет метки точки в ссылке: ${url}`);
      await sleep(800);
      const ev = events(t.server, n0);
      const said = await P.ev(() => window.__e2eTexts.filter((x) => x.sel === '.bubble .txt').map((x) => x.t));
      for (const re of [/Тут живут твои деньги и копилка/, /Заходи в СберKids/]) assert(said.some((x) => re.test(x)), `кот не сказал ${re}: ${said.slice(-6).join(' | ')}`);
      const st = ev.filter((e) => e.name === 'onb_step' && e.props.svc === 'kids').map((e) => e.props.step);
      t.note(`onb_step: ${st.join(' ')}`);
      for (const k of ['open', 'hello', 'piggy', 'coin', 'tour', 'go_offer', 'go']) assert(st.includes(k), `нет шага ${k} в onb_step`);
      assert(ev.some((e) => e.name === 'sberkids_click' && /_onb$/.test(e.props.kind)), 'нет sberkids_click *_onb');
      for (const pg of await t.browser.pages()) if (/sber|kids|rustore/i.test(pg.url()) && !pg.url().includes('127.0.0.1')) await pg.close().catch(() => undefined);
    },
  },
  {
    name: '12_no_care_words',
    title: 'пилот без «ласки»: новый ребёнок — знакомство и игра; в меню, подсказках и репликах нет «погладь / пощекочи / обними / ласка»',
    timeout: 400,
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, { q: 'cat=hooligan' }));
      await toPlay(P);
      await P.must(SETTLED, 40000, 'кот договорил знакомство');
      await P.ev(() => window.__app.ui.tom?.reveal());
      await sleep(1200);
      await shot(t, P, 'onb_menu');
      await sleep(12000); // подсказки «нажми сюда», чипы, пузырь-подсказка
      const items = await catalogItems(P);
      const menu = await P.ev(() => [...document.querySelectorAll('.tom .tom-btn, .tom .tom-head, .tom-col, .tom-dbtn, .chips .sug')].flatMap((e) => [e.textContent ?? '', e.getAttribute('aria-label') ?? '']).filter(Boolean));
      const left = await P.ev(() => [...document.querySelectorAll('.tom-col.l [data-item]')].map((e) => e.getAttribute('data-item')));
      t.note(`слева: ${left.join(', ')}`);
      assert(left.includes('svc:samokat') && left.includes('svc:kids'), `в левой колонке нет значков сервисов: ${left.join(', ')}`);
      const texts = await P.ev(() => window.__e2eTexts.map((x) => x.t));
      const speak = (await P.rec('speak')).map((r) => `${r.id}: ${r.text}`);
      const all = [...items.map((i) => i.label), ...menu, ...texts, ...speak];
      const bad = all.filter((x) => NO_CARE_RE.test(x));
      t.note(`проверено: ${items.length} пунктов, ${menu.length} подписей меню, ${texts.length} текстов, ${speak.length} реплик`);
      assert(!bad.length, `слова ласки: ${[...new Set(bad)].slice(0, 5).join(' | ')}`);
      for (const id of ['pet', 'scratch', 'tickle', 'hug', 'cheek']) assert(!items.some((i) => i.id === id), `в каталоге пилота «${id}»`);
    },
  },
  // ───────────── 13. персонажи (26.11): выбор кота, смена, предмет появления ─────────────
  {
    name: '13_pick_after_skip',
    title: 'новый ребёнок: «Пропустить» имя → лист «Выбери своего кота» (3 карточки, пузырь «Выбери, кто будет с тобой!») → Добряк: вспышка, его модель, он знакомится своим голосом, какао в лапах',
    timeout: 400,
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, { q: '' }));
      await toPlay(P, { pick: 'kind' });
      await P.must(() => window.__app.charFor === 'kind', 30000, 'модель Добряка загружена');
      const r = await P.ev(() => ({ p: window.__app.director.persona.id, url: window.__app.character.url, charFor: window.__app.charFor, picks: window.__e2ePick ?? null }));
      t.note(JSON.stringify(r));
      assert(r.picks && r.picks.title === 'Выбери своего кота', `заголовок листа: ${r.picks?.title}`);
      assert(r.picks.cards.join(',') === 'hooligan,kind,glitter', `карточки: ${r.picks.cards.join(',')}`);
      assert(r.p === 'kind' && /kind/.test(r.url) && r.charFor === 'kind', `кот ${r.p}, модель ${r.url}`);
      const tx = await P.ev(() => window.__e2eTexts ?? []);
      assert(tx.some((x) => /Выбери, кто будет с тобой/.test(x.t ?? '')) || (await P.rec('bubble')).some((x) => /Выбери, кто будет с тобой/.test(x.txt ?? '')), 'нет пузыря «Выбери, кто будет с тобой!»');
      const sp = (await P.rec('speak')).map((x) => x.id);
      t.note(`реплики: ${sp.join(', ')}`);
      assert(sp.some((id) => /^kind\.meet_self/.test(id)), 'Добряк не представился (meet_self)');
      assert(!sp.some((id) => /^hooligan\.meet_self/.test(id)), 'meet_self сказал Хулиган');
      assert(!sp.some((id) => /choose_|switch_start|hello_new/.test(id)), `реплики «переодевания»: ${sp.join(', ')}`);
      const att = await P.until(() => (window.__qaRec ?? []).some((x) => x.kind === 'log' && /предмет появления: cocoa/.test(x.s)), 20000);
      assert(att, 'нет какао при появлении Добряка');
    },
  },
  {
    name: '13_pick_after_name',
    title: 'имя полем → лист выбора → Блёстка (модель, зеркальце); без листа «Каким мне быть?»',
    timeout: 400,
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, { q: '' }));
      await toPlay(P, { name: 'Маша', pick: 'glitter' });
      await P.must(() => window.__app.charFor === 'glitter', 30000, 'модель Блёстки загружена');
      const r = await P.ev(() => ({ p: window.__app.director.persona.id, url: window.__app.character.url, phase: window.__app.director.state.phase }));
      assert(r.p === 'glitter' && /glitter/.test(r.url), `кот ${r.p}, модель ${r.url}`);
      assert(await P.until(() => (window.__qaRec ?? []).some((x) => x.kind === 'log' && /предмет появления: mirror/.test(x.s)), 20000), 'нет зеркальца при появлении Блёстки');
      assert(!(await P.ev(() => document.body.innerText.includes('Каким мне быть'))), 'лист «Каким мне быть?»');
    },
  },
  {
    name: '13_switch_from_play',
    title: 'смена кота из игры: «давай другого» голосом → лист → Блёстка; событие choose (запись 26.11) меняет модель, голос и пузырь; гонка загрузок моделей',
    timeout: 400,
    async fn(t) {
      const P = await playing(t, 'hooligan', 'from=test&cooldown=0');
      // голосом — тот же лист
      await P.ev(() => window.__app.director.text('давай другого'));
      await P.must(() => !document.querySelector('.choice-sheet').classList.contains('hidden'), 8000, 'лист по «давай другого»');
      const r0 = await rt(P);
      await P.tap('.choice-sheet .choice[data-p="glitter"]');
      await P.must(() => window.__app.charFor === 'glitter' && /glitter/.test(window.__app.character.url ?? ''), 30000, 'модель Блёстки');
      await P.must(SETTLED, 30000, 'Блёстка свободна');
      let s = await since(P, r0);
      assert(s.speak.some((id) => /^glitter\./.test(id)) && !s.speak.some((id) => /^hooligan\./.test(id)), `голос после смены: ${s.speak.join(', ')}`);
      // событие choose в игре (запись 26.11: «сменилась только подпись в пузыре»): модель, голос, пузырь — нового
      await sleep(1000);
      const r1 = await rt(P);
      await P.ev(() => window.__app.director.dispatch({ type: 'choose', persona: 'kind' }));
      await P.must(() => window.__app.director.persona.id === 'kind', 10000, 'режиссёр: кот kind');
      await P.must(() => window.__app.charFor === 'kind' && /kind/.test(window.__app.character.url ?? ''), 30000, 'модель Добряка');
      await P.must(SETTLED, 30000, 'Добряк свободен');
      s = await since(P, r1);
      t.note(`choose → kind: ${s.speak.join(', ')} | ${s.bubble.join(' | ')}`);
      assert(s.speak.some((id) => /^kind\./.test(id)) && !s.speak.some((id) => /^glitter\./.test(id)), `голос после choose: ${s.speak.join(', ')}`);
      const st = await P.ev(() => ({ n: window.__app.stage.root.children.filter((c) => c.name === 'character-glb').length, inStage: window.__app.stage.root.children.includes(window.__app.character.object) }));
      assert(st.n === 1 && st.inStage, `в сцене котов: ${st.n}`);
      // гонка загрузок: модель Хулигана — медленно (8 с), Добряк уже в кэше; ребёнок передумал — поздняя модель не подменяет
      await sleep(1000);
      await P.page.setRequestInterception(true);
      P.page.on('request', (q) => {
        if (q.isInterceptResolutionHandled()) return;
        if (/hooligan[^/]*\.glb/.test(q.url())) setTimeout(() => q.continue().catch(() => undefined), 8000);
        else q.continue().catch(() => undefined);
      });
      await P.ev(() => window.__app.director.dispatch({ type: 'choose', persona: 'hooligan' }));
      await sleep(700);
      await P.ev(() => window.__app.director.dispatch({ type: 'choose', persona: 'kind' }));
      await sleep(12000);
      const st2 = await P.ev(() => ({ p: window.__app.director.persona.id, url: window.__app.character.url, charFor: window.__app.charFor, n: window.__app.stage.root.children.filter((c) => c.name === 'character-glb').length }));
      t.note(`гонка: ${JSON.stringify(st2)}`);
      assert(st2.p === 'kind' && /kind/.test(st2.url) && st2.charFor === 'kind' && st2.n === 1, `гонка загрузок: кот ${st2.p}, модель ${st2.url}`);
      await P.page.setRequestInterception(false).catch(() => undefined);
    },
  },
  ...['hooligan', 'kind', 'glitter'].map((cat) => ({
    name: `13_attr_${cat}`,
    title: `появление ${cat} из карты — с фирменным предметом (${({ hooligan: 'скейт', kind: 'какао', glitter: 'зеркальце' })[cat]}): предмет у кости (кисть / стопы на деке), проникновение в кота ≤ 2 мм, предмет не улетает`,
    timeout: 300,
    async fn(t) {
      const P = t.track(await openPhone(t.browser, t.server, { q: `cat=${cat}`, memory: MET(cat) }));
      await toPlay(P);
      const act = { hooligan: 'skate_show', kind: 'cocoa', glitter: 'mirror' }[cat];
      await P.must((a) => window.__app.character.actState?.id === a, 20000, `предмет появления ${act}`, act);
      // кадры предмета: положение относительно кости (кисть / стопы на деке), проникновение (character/propPen.ts)
      const fr = [];
      for (let i = 0; i < 30; i++) {
        const f = await P.ev(() => {
          const c = window.__app.character, st = c.actState, po = c.props?.object;
          if (!st || !po || !po.visible) return null;
          const V = c.object.position.constructor;
          const s = c.object.getWorldScale(new V()).y || 1;
          const mm = window.__app.stage.cfg.height * 85.6;
          const pen = c.propPen(2);
          const r = { ph: st.phase, scale: +(po.getWorldScale(new V()).y / s).toFixed(2), pen: pen ? +(pen.depth * mm).toFixed(2) : 0, part: pen?.part ?? '' };
          if (st.id === 'skate_show') {
            r.deck = +(c.skateDbg.deck * mm).toFixed(1);
            r.onDeck = c.skateDbg.onDeck;
            // доска под котом: не дальше 0,6 роста от корня по горизонтали, не выше колен
            const p = c.object.worldToLocal(po.getWorldPosition(new V()));
            r.far = +(Math.hypot(p.x, p.z) * mm).toFixed(1);
            r.up = +(p.y * mm).toFixed(1);
          } else {
            const hand = c.bones.get(st.id === 'mirror' ? 'LeftHand' : 'RightHand');
            r.hand = +((po.getWorldPosition(new V()).distanceTo(hand.getWorldPosition(new V())) / s) * mm).toFixed(1);
          }
          return r;
        });
        if (f) fr.push(f);
        await sleep(150);
      }
      t.note(`${act}: кадров ${fr.length}, ${JSON.stringify(fr.filter((_, i) => i % 6 === 0))}`);
      assert(fr.length >= 8, `предмет виден в ${fr.length} кадрах`);
      const pen = Math.max(...fr.map((f) => f.pen));
      assert(pen <= 2, `проникновение предмета ${pen} мм (${fr.find((f) => f.pen === pen)?.part})`);
      if (cat === 'hooligan') {
        const deck = Math.max(...fr.filter((f) => f.onDeck).map((f) => f.deck), 0);
        assert(deck <= 6, `стопы не на деке: ${deck} мм`);
        assert(fr.every((f) => f.far <= 60 && f.up <= 15), `доска улетела от кота: ${JSON.stringify(fr.find((f) => f.far > 60 || f.up > 15))}`);
      } else {
        const full = fr.filter((f) => f.scale > 0.95);
        const far = Math.max(...full.map((f) => f.hand), 0);
        assert(far <= 25, `предмет оторвался от кисти: ${far} мм`);
      }
      await P.must(() => !window.__app.character.actState, 15000, 'предмет убран');
      assert(await P.ev(() => !window.__app.character.props?.object?.visible), 'предмет остался на сцене');
    },
  })),
];

// ───────────── 10. ошибки за весь прогон ─────────────
// Отдельного сценария нет: каждый сценарий падает, если на его страницах был console.error / pageerror / unhandledrejection
// (белый список — lib.mjs ALLOW и allow сценария, каждая строка с причиной). Сводка — в конце прогона (run.mjs).
