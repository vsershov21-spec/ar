/**
 * Быстрый вход (feature 'intro.quick', docs/EDITIONS.md): заставка и единственный экран — прямо в index.html,
 * без ожидания JS-бандла. Вставляет её сборка (vite.config.ts → quickSplash(), transformIndexHtml) только в редакциях,
 * где функция включена (lab, pilot); MVP-корень не меняется.
 *
 * Загадка (правки продакта 22.11, 23.11, 26.11 «как яйцо покемона»): кота до разрешений НЕ показываем — детская карта
 * Сбера «вылупляется», как яйцо: из щели смотрят глаза, карта качается рывками — 3 серии, каждая сильнее (2 → 3 → 4
 * рывка, с подскоком), с каждой серией сильнее зелёное свечение изнутри, растут трещины и щель с глазами (подробнее —
 * у CARD). Касание карты (это жест) — карта вздрагивает, «тук» синтезом Web Audio, без файлов.
 * «Узнать, кто там» — последняя серия (самая сильная, «тук-тук-ТУК») → вспышка, половинки карты расходятся (q-open),
 * звук треска; окно камеры появляется сразу в том же жесте — дальше камера.
 * Сам кот — только после разрешений, в катсцене пробуждения из карты (src/awake: те же трещины на настоящей карте).
 *
 * Встроенный скрипт (ES2017, ~4 КБ) работает до бандла: одно нажатие «Узнать, кто там» в ОДНОМ жесте —
 *   · AudioContext создаётся и будится (iOS), Audio (src/audio/audio.ts) потом берёт этот же контекст;
 *   · датчики движения (iOS requestPermission) — их промис забирает Input.requestSensors;
 *   · камера + микрофон одним getUserMedia (те же ограничения, что cardTracker.openCamera; не вышло вместе — камера
 *     отдельно); поток забирает cardTracker.startVideo (src/quick/early.ts takeEarlyCamera).
 * Окно разрешения появляется сразу, пока бандл ещё качается. Приложение готово — src/quick/entry.ts подхватывает
 * нажатие (window.__quick.tapped) и зовёт app.wake().
 * События воронки до бандла (splash_shown, cta_tap, camera_*, mic_*) копятся в window.__quick.ev, их отправляет
 * src/analytics при старте (с временем от начала навигации, ms).
 *
 * Чистая функция без DOM: тест tests/quick.test.ts (тексты, режимы согласия, ограничения камеры как у трекера).
 */
import { CONSENT_TEXT, PRIVACY_DRAFT_NOTE, PRIVACY_SHEET, hasPolicyUrl, type ConsentMode } from '../config/consent';

export const QUICK_TEXT = {
  title: 'Кто-то живёт в&nbsp;твоей карте…',
  sub: 'Положи карту Сбера на&nbsp;стол — и&nbsp;узнаешь, кто',
  cta: 'Узнать, кто там',
  busy: 'Будим…',
  deniedTitle: 'Без камеры кот не&nbsp;увидит карту',
  deniedSub: 'Разреши камеру — и&nbsp;попробуем ещё раз. Попроси взрослого помочь.',
  retry: 'Попробовать ещё раз',
  reload: 'Обновить страницу',
  /** камера уже есть, приложение ещё качается: плашка поверх камеры (кот — только в пробуждении) */
  searchTitle: 'Положи карту Сбера на&nbsp;стол и&nbsp;наведи камеру',
  searchSub: 'Кто-то просыпается…',
  /** приложение не загрузилось (BOOT-01): главный JS не пришёл, пришёл HTML вместо JS или не стартовал за BOOT_MS */
  failTitle: 'Кот не&nbsp;проснулся',
  failSub: 'Не получилось загрузить игру. Проверь интернет и&nbsp;попробуй снова.',
  failRetry: 'Попробовать снова',
} as const;

/**
 * Дедлайн загрузки приложения после «Узнать, кто там» (BOOT-01), мс: бандл не исполнился за это время — заставка
 * сбрасывается, ранние дорожки камеры и микрофона останавливаются, на экране «Попробовать снова» (перезагрузка с
 * параметром _boot — мимо кэша страницы). Сбой скрипта (404, HTML вместо JS) — сразу, не дожидаясь дедлайна.
 * Бандл всё же пришёл позже дедлайна — заставка возвращается к кнопке (камера — по новому нажатию, без дубля).
 */
export const BOOT_MS = 15_000;
/** DOMContentLoaded был, а бандл так и не отметился (упал при исполнении модулей) — через столько мс экран сбоя */
export const BOOT_GRACE_MS = 3_000;

export interface SplashOptions {
  consent: ConsentMode;
  policyUrl: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Детская карта Сбера (как на онбординге) — «яйцо покемона перед вылуплением» (продакт 23.11, 26.11): из тёмной щели
 * светят и моргают глаза; цикл 6 с — три серии рывков, каждая сильнее: 1) 2 качка ±2,5°; 2) 3 качка ±5° с подскоком
 * 6 px; 3) 4 качка ±9° с подскоком 18 px. С каждой серией сильнее зелёное свечение изнутри (ореол q-card::before и
 * свет q-in), раскрываются трещины c1 → c2 → c3, щель с глазами растёт; на третьей — лучи и искры; потом затишье.
 * Кот целиком до разрешений не показывается (тайна).
 * Карта — две половинки по линии главной трещины (одна разметка лица дважды, clip-path): на «Узнать, кто там»
 * они расходятся, из щели — вспышка (класс q-open). Всё — transform/opacity (60 к/с на iPhone), без картинок.
 */
const FACE = `<span class="q-dots"></span><span class="q-chip"></span><span class="q-logo"><i class="q-ring"></i>СБЕР&nbsp;KIDS</span>`;
/** главная трещина (по ней же режутся половинки) и ветки трёх толчков; viewBox карты 160×101 */
const MAIN = 'M93 0L102 18L91 34L106 48L96 63L107 79L98 101';
const CR1 = `${MAIN}M106 48L121 44L131 50M91 34L78 30`;
const CR2 = 'M96 63L80 70L70 66L58 74M102 18L116 12L124 3M121 44L136 36L150 39';
const CR3 = 'M107 79L124 84L140 80L160 88M80 70L74 86L62 101M78 30L64 37L50 30L34 38M131 50L147 62M116 12L134 18';
const crack = (cls: string, d: string) => `<g class="${cls}"><path class="g" d="${d}"/><path class="k" d="${d}"/></g>`;
const CARD = `
<button class="q-card" type="button" aria-label="Постучать в карту">
  <span class="q-rays" aria-hidden="true"></span>
  <span class="q-face" aria-hidden="true">
    <span class="q-core"></span>
    <span class="q-half a">${FACE}</span><span class="q-half b">${FACE}</span>
    <span class="q-in"></span>
    <svg class="q-cracks" viewBox="0 0 160 101" preserveAspectRatio="none">${crack('c1', CR1)}${crack('c2', CR2)}${crack('c3', CR3)}</svg>
    <span class="q-hole"><span class="q-ears"><i></i><i></i></span><span class="q-eyes"><i></i><i></i></span></span>
  </span>
  <span class="q-sparks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
</button>`;

/** линия главной трещины в процентах (половинки карты) */
const SEAM = '58% 0,64% 18%,57% 34%,66% 48%,60% 62%,67% 78%,61% 100%';
const SEAM_R = '61% 100%,67% 78%,60% 62%,66% 48%,57% 34%,64% 18%,58% 0';
/** цикл «вылупления», с: все слои идут одной длительностью — толчки, трещины, лучи и искры совпадают */
const CYCLE = '6s';

const CSS = `
#quick{position:fixed;inset:0;z-index:2147482000;display:flex;flex-direction:column;align-items:center;justify-content:space-between;
  padding:calc(env(safe-area-inset-top,0px) + 18px) 22px calc(env(safe-area-inset-bottom,0px) + 14px);box-sizing:border-box;overflow:hidden;
  background:radial-gradient(120% 80% at 50% 38%,#163a2a 0%,#0b1a12 58%,#050b08 100%);color:#fff;
  font:16px/1.35 -apple-system,BlinkMacSystemFont,"SB Sans Text","Segoe UI",Roboto,system-ui,sans-serif;
  -webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;transition:opacity .45s ease}
#quick *{box-sizing:border-box}
#quick .hidden{display:none!important}
#quick.q-leave{opacity:0;pointer-events:none}
#quick .q-sky{position:absolute;inset:0;pointer-events:none}
#quick .q-sky i{position:absolute;width:3px;height:3px;border-radius:50%;background:#cfe;opacity:.5;animation:qTw 3.6s ease-in-out infinite}
#quick .q-sky i:nth-child(1){left:12%;top:14%}#quick .q-sky i:nth-child(2){left:82%;top:10%;animation-delay:.8s}
#quick .q-sky i:nth-child(3){left:68%;top:30%;animation-delay:1.7s}#quick .q-sky i:nth-child(4){left:22%;top:36%;animation-delay:2.3s}
#quick .q-sky i:nth-child(5){left:90%;top:44%;animation-delay:.4s}#quick .q-sky i:nth-child(6){left:6%;top:52%;animation-delay:1.2s}
#quick .q-stage{flex:1 1 auto;display:flex;align-items:center;justify-content:center;width:100%;min-height:0;position:relative}
#quick .q-stage::after{content:"";position:absolute;left:50%;top:50%;width:min(64vw,260px);height:26px;margin:calc(min(74vw,300px)/3.17 + 6px) 0 0 calc(min(64vw,260px)/-2);
  border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.55),transparent);animation:qShadow ${CYCLE} ease-in-out infinite;pointer-events:none}
#quick .q-card{position:relative;z-index:1;width:min(74vw,300px);aspect-ratio:1.586;border:0;padding:0;background:none;cursor:pointer;outline:none;
  transform:rotate(-8deg);animation:qHatch ${CYCLE} ease-in-out infinite;will-change:transform}
#quick .q-card::before{content:"";position:absolute;inset:-28% -18%;border-radius:50%;pointer-events:none;opacity:0;
  background:radial-gradient(closest-side,rgba(170,255,110,.8),rgba(60,220,100,.35) 55%,rgba(30,160,80,0));animation:qGlow ${CYCLE} ease-out infinite}
#quick .q-face{position:absolute;inset:0;border-radius:16px;box-shadow:0 18px 40px rgba(0,0,0,.55),0 0 60px rgba(150,255,110,.14)}
#quick .q-core{position:absolute;inset:6% 22% 6% 40%;border-radius:40%;background:radial-gradient(closest-side,#fffbe0,#f6ff9a 35%,#9cf05a 65%,rgba(80,220,90,0))}
#quick .q-half{position:absolute;inset:0;border-radius:16px;overflow:hidden;background:linear-gradient(135deg,#2bd36a 0%,#16a34a 42%,#0e7a5a 78%,#0b5c63 100%);
  box-shadow:0 0 0 1px rgba(255,255,255,.12) inset;transition:transform .5s cubic-bezier(.2,1.4,.4,1)}
#quick .q-half.a{clip-path:polygon(0 0,${SEAM},0 100%)}
#quick .q-half.b{clip-path:polygon(${SEAM.split(',')[0]},100% 0,100% 100%,${SEAM_R})}
#quick .q-dots{position:absolute;inset:0;opacity:.18;background:radial-gradient(circle at 20% 30%,#fff 0 2px,transparent 3px) 0 0/26px 26px}
#quick .q-chip{position:absolute;left:9%;top:30%;width:15%;aspect-ratio:1.3;border-radius:5px;background:linear-gradient(135deg,#f7e6a6,#cfa84a);box-shadow:0 0 0 1px rgba(0,0,0,.15) inset}
#quick .q-logo{position:absolute;left:9%;top:9%;font-weight:800;font-size:clamp(11px,3.4vw,14px);letter-spacing:.06em;display:flex;align-items:center;gap:6px}
#quick .q-ring{width:15px;height:15px;border-radius:50%;border:2.5px solid #fff;display:inline-block}
#quick .q-in{position:absolute;left:30%;top:10%;width:70%;height:84%;border-radius:50%;pointer-events:none;
  background:radial-gradient(closest-side,rgba(255,246,170,.85),rgba(200,255,110,.45) 45%,rgba(120,240,120,0));opacity:0;animation:qIn ${CYCLE} ease-out infinite}
#quick .q-cracks{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
#quick .q-cracks path{fill:none;stroke-linecap:round;stroke-linejoin:round}
#quick .q-cracks .g{stroke:#d8ff6a;stroke-width:4;opacity:.3}
#quick .q-cracks .k{stroke:#fffbe0;stroke-width:1.1}
#quick .q-cracks .c1{opacity:.4;animation:qC1 ${CYCLE} ease-out infinite}
#quick .q-cracks .c2{opacity:0;animation:qC2 ${CYCLE} ease-out infinite}
#quick .q-cracks .c3{opacity:0;animation:qC3 ${CYCLE} ease-out infinite}
#quick .q-hole{position:absolute;left:51%;top:30%;width:30%;height:46%;background:radial-gradient(ellipse at 50% 60%,#000,#04100a 70%,#0a2a17);
  clip-path:polygon(18% 6%,42% 0,62% 10%,86% 4%,100% 40%,90% 70%,98% 96%,62% 100%,38% 90%,8% 100%,0 60%,10% 34%);
  transform:scale(.5);animation:qHole ${CYCLE} ease-in-out infinite;overflow:hidden}
#quick .q-ears{position:absolute;left:22%;right:22%;top:14%;height:30%;display:flex;justify-content:space-between}
#quick .q-ears i{width:36%;height:100%;background:#1b3a2a;clip-path:polygon(30% 0,100% 100%,0 100%)}
#quick .q-ears i+i{clip-path:polygon(70% 0,100% 100%,0 100%)}
#quick .q-eyes{position:absolute;left:24%;right:24%;top:48%;height:24%;display:flex;justify-content:space-between}
#quick .q-eyes i{width:32%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 45%,#fbffd0 0,#d7ff4f 38%,#7bd800 70%);
  box-shadow:0 0 10px #c6ff3a,0 0 22px rgba(170,255,60,.55);animation:qBlink 2.5s infinite}
#quick .q-rays{position:absolute;left:62%;top:52%;width:300%;aspect-ratio:1;margin:-150% 0 0 -150%;border-radius:50%;pointer-events:none;
  background:repeating-conic-gradient(from 8deg,rgba(255,244,170,.55) 0 3deg,rgba(255,244,170,0) 6deg 26deg);
  -webkit-mask:radial-gradient(closest-side,#000 8%,rgba(0,0,0,.5) 40%,transparent 72%);mask:radial-gradient(closest-side,#000 8%,rgba(0,0,0,.5) 40%,transparent 72%);
  opacity:0;transform:scale(.5) rotate(0);animation:qRays ${CYCLE} ease-out infinite}
#quick .q-sparks{position:absolute;left:62%;top:52%;width:0;height:0;pointer-events:none}
#quick .q-sparks i{position:absolute;width:6px;height:6px;margin:-3px;border-radius:50%;background:#fff6b0;box-shadow:0 0 8px #ffe76a;opacity:0;animation:qSpark ${CYCLE} ease-out infinite}
#quick .q-sparks i:nth-child(1){--x:-70px;--y:-60px}#quick .q-sparks i:nth-child(2){--x:60px;--y:-80px}#quick .q-sparks i:nth-child(3){--x:96px;--y:-10px}
#quick .q-sparks i:nth-child(4){--x:-96px;--y:10px}#quick .q-sparks i:nth-child(5){--x:20px;--y:-110px}#quick .q-sparks i:nth-child(6){--x:-30px;--y:70px}
#quick .q-sparks i:nth-child(7){--x:80px;--y:60px}#quick .q-sparks i:nth-child(8){--x:-110px;--y:-40px}
#quick .q-sparks i:nth-child(odd){background:#d8ff6a;box-shadow:0 0 8px #b8ff3a}
#quick .q-card.knock{animation:qKnock .42s ease-in-out}
#quick .q-card.knock .q-cracks .c1,#quick .q-card.knock .q-cracks .c2{animation:qTap .6s ease-out}
#quick .q-card.knock .q-in{animation:qTap .6s ease-out}
#quick .q-flash{position:absolute;inset:0;z-index:3;pointer-events:none;opacity:0;
  background:radial-gradient(60% 45% at 50% 38%,rgba(255,250,210,.95),rgba(214,255,120,.7) 40%,rgba(40,170,80,.35) 75%,rgba(10,40,25,0))}
#quick.q-open .q-flash{animation:qFlash 1.1s ease-out .5s forwards}
#quick.q-open .q-card{animation:qOpen .9s ease-in forwards}
#quick.q-open .q-card::before{animation:qGlowOpen .9s ease-in forwards}
#quick.q-open .q-half{transition-delay:.5s}
#quick.q-open .q-half.a{transform:translate(-16%,-4%) rotate(-9deg)}
#quick.q-open .q-half.b{transform:translate(16%,5%) rotate(8deg)}
#quick.q-open .q-cracks .c1,#quick.q-open .q-cracks .c2,#quick.q-open .q-cracks .c3{animation:none;opacity:1}
#quick.q-open .q-cracks{opacity:0;transition:opacity .3s .18s}
#quick.q-open .q-in{animation:none;opacity:1;transform:scale(1.6);transition:transform .5s .45s}
#quick.q-open .q-hole{animation:none;transform:scale(1.1);opacity:0;transition:opacity .2s .5s}
#quick.q-open .q-rays{animation:none;opacity:1;transform:scale(1.4) rotate(20deg);transition:transform .8s ease-out .45s,opacity .3s .45s}
#quick.q-open .q-sparks i{animation:qSpark1 .8s ease-out .5s both}
#quick .q-text{text-align:center;max-width:340px;margin:6px 0 10px}
#quick h1{font-size:clamp(24px,7.4vw,30px);line-height:1.15;margin:0 0 8px;font-weight:800;letter-spacing:-.01em}
#quick .q-text p{margin:0;font-size:17px;opacity:.86}
#quick .q-foot{width:100%;max-width:400px;display:flex;flex-direction:column;align-items:stretch;gap:10px}
#quick .q-cta{appearance:none;border:0;border-radius:20px;min-height:64px;padding:0 20px;font-weight:800;font-size:20px;line-height:1;font-family:inherit;color:#fff;cursor:pointer;
  background:linear-gradient(180deg,#2fd36b,#18a74a);box-shadow:0 10px 26px rgba(24,167,74,.45),0 -2px 0 rgba(0,0,0,.12) inset;
  display:flex;align-items:center;justify-content:center;gap:10px;animation:qPulse 2.4s ease-in-out infinite;touch-action:manipulation}
#quick .q-cta:active{transform:scale(.98)}
#quick .q-cta[disabled]{opacity:.85;animation:none}
#quick .q-cta.q-off{background:#4b5a52;box-shadow:none;animation:none}
#quick .q-spin{display:none;width:20px;height:20px;border-radius:50%;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;animation:qSpin .8s linear infinite}
#quick .q-cta.busy .q-spin{display:block}
#quick .q-check{display:flex;gap:10px;align-items:center;font-size:15px;padding:4px 2px}
#quick .q-check input{width:24px;height:24px;accent-color:#21a038;flex:none;margin:0}
#quick .q-check.need{animation:qKnock .45s}
#quick .q-need{font-size:13px;color:#ffd27a;text-align:center;min-height:0}
#quick .q-fine{margin:0;font-size:11.5px;line-height:1.35;opacity:.72;text-align:center}
#quick .q-link{appearance:none;border:0;background:none;color:#9ff0bd;font:inherit;text-decoration:underline;padding:2px;cursor:pointer}
#quick .q-sheet,#quick .q-denied,#quick .q-fail{position:absolute;inset:0;z-index:2;display:flex;align-items:flex-end;justify-content:center;background:rgba(3,8,6,.72)}
#quick .q-denied,#quick .q-fail{align-items:center;background:radial-gradient(120% 80% at 50% 30%,#1d2a24,#070c0a)}
#quick .q-panel{width:100%;max-width:440px;max-height:86%;overflow:auto;background:#fff;color:#14201a;border-radius:22px 22px 0 0;padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px)}
#quick .q-denied .q-panel,#quick .q-fail .q-panel{background:none;color:#fff;border-radius:0;max-height:100%;text-align:center}
#quick .q-panel h2{font-size:20px;margin:0 0 10px;line-height:1.2}
#quick .q-panel p,#quick .q-panel li{font-size:14.5px;margin:0 0 10px}
#quick .q-panel b{font-weight:700}
#quick .q-panel ol{text-align:left;padding-left:22px;margin:4px 0 12px}
#quick .q-panel .q-how{background:rgba(255,255,255,.08);border-radius:14px;padding:10px 12px;margin:0 0 10px;text-align:left}
#quick .q-panel .q-how h3{font-size:15px;margin:0 0 4px}
#quick .q-note{font-size:12px;opacity:.6}
#quick .q-btn{display:block;width:100%;min-height:54px;border:0;border-radius:16px;font-weight:800;font-size:18px;line-height:1;font-family:inherit;color:#fff;background:#21a038;margin-top:8px;cursor:pointer}
#quick .q-btn.q-ghost{background:none;color:inherit;border:2px solid rgba(255,255,255,.35)}
#quick .q-sheet .q-btn.q-ghost{border-color:rgba(0,0,0,.2)}
#quick .q-noeye{width:96px;height:60px;margin:6px auto 14px;border-radius:999px;background:#000;position:relative;box-shadow:0 0 0 3px #16a34a}
#quick .q-noeye::before,#quick .q-noeye::after{content:"";position:absolute;top:26px;width:22px;height:4px;border-radius:2px;background:#c6ff3a;opacity:.8}
#quick .q-noeye::before{left:20px}#quick .q-noeye::after{right:20px}
#quick .q-search{position:absolute;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);display:flex;align-items:center;gap:12px;
  padding:12px 14px;border-radius:20px;background:rgba(8,20,14,.82);box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:auto}
#quick .q-search .q-slot{position:relative;flex:none;width:58px;height:36px;border-radius:999px;overflow:hidden;
  background:radial-gradient(ellipse at 50% 60%,#000 0%,#020604 55%,#06140d 100%);box-shadow:0 0 0 2px rgba(0,0,0,.35),0 0 22px rgba(0,0,0,.7) inset}
#quick .q-search .q-eyes{left:22%;right:22%;top:32%;height:36%}
#quick .q-search b{display:block;font-size:16px;line-height:1.25}
#quick .q-search small{display:block;font-size:13px;opacity:.75;margin-top:2px}
#quick.q-searching{background:transparent;pointer-events:none}
#quick.q-searching>.q-sky,#quick.q-searching>.q-stage,#quick.q-searching>.q-text,#quick.q-searching>.q-foot{display:none}
@keyframes qTw{0%,100%{opacity:.15}50%{opacity:.8}}
@keyframes qHatch{0%,8%{transform:rotate(-8deg)}
  10%{transform:rotate(-10.5deg)}13%{transform:rotate(-5.5deg)}16%{transform:rotate(-10deg)}19%{transform:rotate(-6deg)}22%,32%{transform:rotate(-8deg)}
  34%{transform:translateY(-6px) rotate(-13deg)}37%{transform:rotate(-3deg)}40%{transform:translateY(-5px) rotate(-12.5deg)}43%{transform:rotate(-3.5deg)}
  46%{transform:translateY(-3px) rotate(-11deg)}49%,58%{transform:rotate(-8deg)}
  60%{transform:translateY(-18px) rotate(-17deg) scale(1.05)}63%{transform:rotate(1deg) scale(1.02)}66%{transform:translateY(-15px) rotate(-17deg) scale(1.05)}
  69%{transform:rotate(1deg) scale(1.02)}72%{transform:translateY(-11px) rotate(-16deg) scale(1.04)}75%{transform:rotate(0deg)}78%{transform:rotate(-10deg)}81%,100%{transform:rotate(-8deg)}}
@keyframes qShadow{0%,32%,37%,43%,49%,58%,63%,69%,75%,100%{transform:scale(1);opacity:1}34%,40%{transform:scale(.9);opacity:.75}60%,66%{transform:scale(.78);opacity:.5}72%{transform:scale(.84);opacity:.6}}
@keyframes qGlow{0%,8%{opacity:0;transform:scale(.8)}11%,19%{opacity:.3;transform:scale(.88)}26%,32%{opacity:.12;transform:scale(.85)}
  35%,46%{opacity:.6;transform:scale(.96)}52%,58%{opacity:.3;transform:scale(.92)}61%,76%{opacity:1;transform:scale(1.08)}88%,100%{opacity:0;transform:scale(.8)}}
@keyframes qGlowOpen{0%{opacity:.6;transform:scale(.95)}50%{opacity:1;transform:scale(1.15)}100%{opacity:1;transform:scale(1.6)}}
@keyframes qC1{0%,9%{opacity:.2}10%{opacity:1}22%,80%{opacity:.85}92%,100%{opacity:.2}}
@keyframes qC2{0%,33%{opacity:0}34%,46%{opacity:1}52%,80%{opacity:.8}92%,100%{opacity:0}}
@keyframes qC3{0%,59%{opacity:0}60%,76%{opacity:1}92%,100%{opacity:0}}
@keyframes qIn{0%,8%,24%,32%,52%,58%,88%,100%{opacity:0}10%,19%{opacity:.3}34%,46%{opacity:.65}60%,76%{opacity:1}}
@keyframes qRays{0%,33%,48%,59%,82%,100%{opacity:0;transform:scale(.5) rotate(0)}36%,44%{opacity:.35;transform:scale(.7) rotate(5deg)}61%{opacity:1;transform:scale(1) rotate(10deg)}76%{opacity:.8;transform:scale(1.05) rotate(16deg)}}
@keyframes qHole{0%,8%,88%,100%{transform:scale(.5)}10%,22%{transform:scale(.62)}34%,49%{transform:scale(.8)}60%,78%{transform:scale(1)}}
@keyframes qSpark{0%,33%{opacity:0;transform:translate(0,0) scale(.6)}34%{opacity:.8;transform:translate(0,0) scale(.8)}44%{opacity:0;transform:translate(calc(var(--x)*.5),calc(var(--y)*.5)) scale(.3)}
  59.9%{opacity:0;transform:translate(0,0)}60%{opacity:1;transform:translate(0,0) scale(1.3)}76%,100%{opacity:0;transform:translate(var(--x),var(--y)) scale(.3)}}
@keyframes qSpark1{0%{opacity:1;transform:translate(0,0) scale(1.4)}100%{opacity:0;transform:translate(calc(var(--x)*1.8),calc(var(--y)*1.8)) scale(.3)}}
@keyframes qKnock{0%,100%{transform:rotate(-8deg)}20%{transform:translateY(-8px) rotate(-5deg) scale(1.03)}45%{transform:rotate(-11deg)}65%{transform:rotate(-6.5deg)}85%{transform:rotate(-9deg)}}
@keyframes qTap{0%{opacity:1}100%{opacity:.5}}
@keyframes qFlash{0%{opacity:0}25%{opacity:1}100%{opacity:.25}}
@keyframes qOpen{0%{transform:rotate(-8deg)}10%{transform:translateY(-16px) rotate(-18deg) scale(1.05)}20%{transform:rotate(2deg)}30%{transform:translateY(-20px) rotate(-19deg) scale(1.07)}40%{transform:rotate(3deg)}50%{transform:translateY(-8px) rotate(-8deg) scale(1.1)}100%{transform:translateY(-10px) rotate(-8deg) scale(1.08)}}
@keyframes qBlink{0%,40%,46%,100%{transform:scaleY(1)}43%{transform:scaleY(.08)}}
@keyframes qPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.025)}}
@keyframes qSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#quick *,#quick .q-card{animation:none!important;transition:none!important}#quick .q-sparks,#quick .q-rays,#quick .q-flash{display:none}
  #quick .q-cracks .c1,#quick .q-cracks .c2{opacity:.9!important}#quick .q-in{opacity:.45}}
@media (max-height:640px){#quick .q-card{width:min(60vw,240px)}#quick h1{font-size:23px}#quick .q-text p{font-size:15px}}
`;

/**
 * Встроенный скрипт. Ограничения камеры — те же, что src/tracker/cardTracker.ts openCamera (960×540 / ?cam=720, 30 к/с,
 * ?aec=0) — сверяет tests/quick.test.ts. Свой поток заставка берёт, только когда приложение откроет трекер карты
 * (без ?tracker, ?nocard, ?desktop, ?debug) — иначе камеру откроет само приложение после бандла.
 */
const SCRIPT = `(function(){
var Q=window.__quick=window.__quick||{};Q.ev=[];Q.tapped=false;Q.ready=false;
var el=document.getElementById('quick');if(!el)return;
var qs=new URLSearchParams(location.search);
function now(){return Math.round(performance.now())}
function ev(n,p){p=p||{};p.ms=now();Q.ev.push([n,p]);if(Q.track)Q.track(n,p)}
Q.emit=ev;
requestAnimationFrame(function(){requestAnimationFrame(function(){ev('splash_shown')})});
var AC=window.AudioContext||window.webkitAudioContext;
function ctx(){var c=Q.ctx;if(!c&&AC){try{c=Q.ctx=new AC({latencyHint:qs.get('latency')||'playback'})}catch(e){}}
 if(c){try{if(c.state!=='running')c.resume();if(!Q.blip){Q.blip=1;var b=c.createBuffer(1,1,22050),s=c.createBufferSource();s.buffer=b;s.connect(c.destination);s.start(0)}}catch(e){}}return c}
function thump(c,t,f){var o=c.createOscillator(),g=c.createGain();o.frequency.setValueAtTime(f,t);o.frequency.exponentialRampToValueAtTime(55,t+.12);
 g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.5,t+.008);g.gain.exponentialRampToValueAtTime(.0001,t+.16);o.connect(g);g.connect(c.destination);o.start(t);o.stop(t+.2)}
function snap(c,t){var n=c.sampleRate*.35|0,b=c.createBuffer(1,n,c.sampleRate),d=b.getChannelData(0);for(var i=0;i<n;i++){var k=i/n;d[i]=(Math.random()*2-1)*Math.pow(1-k,3)*(Math.random()<.2?1:.35)}
 var s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();f.type='highpass';f.frequency.value=900;g.gain.value=.6;s.buffer=b;s.connect(f);f.connect(g);g.connect(c.destination);s.start(t)}
var card=el.querySelector('.q-card'),knocks=0;
card.addEventListener('click',function(){if(el.classList.contains('q-open'))return;card.classList.remove('knock');void card.offsetWidth;card.classList.add('knock');
 var c=ctx();if(!c)return;var t=c.currentTime+.02;thump(c,t,knocks++%3===2?120:170)});
card.addEventListener('animationend',function(e){if(e.animationName==='qKnock')card.classList.remove('knock')});
function hatch(){el.classList.add('q-open');var c=Q.ctx;if(c){try{var t=c.currentTime+.03;thump(c,t,130);thump(c,t+.18,160);thump(c,t+.36,200);snap(c,t+.48)}catch(e){}}}
var own=!(qs.has('tracker')||qs.has('nocard')||qs.has('desktop')||qs.has('debug'));
function vc(){var hd=qs.get('cam')==='720';return{facingMode:'environment',width:{ideal:hd?1280:960},height:{ideal:hd?720:540},frameRate:{ideal:30}}}
function ac(){var aec=qs.get('aec')!=='0';return{echoCancellation:aec,noiseSuppression:aec,autoGainControl:false,channelCount:1}}
Q.streams=[];
function keep(s){if(s)Q.streams.push(s);return s}
function camera(){var md=navigator.mediaDevices;if(!own||!md||!md.getUserMedia)return null;
 try{var as=navigator.audioSession;if(as&&!qs.get('session')&&as.type!=='play-and-record')as.type='play-and-record'}catch(e){}
 return md.getUserMedia({video:vc(),audio:ac()}).then(function(s){keep(s);ev('camera_granted');ev(s.getAudioTracks().length?'mic_granted':'mic_denied');return{stream:s}},
  function(e){return md.getUserMedia({video:vc(),audio:false}).then(function(s){keep(s);ev('camera_granted');ev('mic_denied');return{stream:s,mic:e&&e.name}},
   function(e2){ev('camera_denied');return{error:{name:e2&&e2.name||'Error',message:String(e2&&e2.message||e2)}}})})}
function motion(){var r=[],M=window.DeviceMotionEvent,O=window.DeviceOrientationEvent;
 try{if(M&&M.requestPermission)r.push(M.requestPermission().catch(function(){return'denied'}));if(O&&O.requestPermission)r.push(O.requestPermission().catch(function(){return'denied'}))}catch(e){}
 if(r.length)Q.motion=Promise.all(r).then(function(x){return x[0]==='granted'})}
var cta=el.querySelector('.q-cta'),txt=el.querySelector('.q-cta-t'),chk=el.querySelector('.q-check input'),need=el.querySelector('.q-need');
function busy(on){cta.classList.toggle('busy',on);cta.disabled=on;txt.textContent=on?cta.getAttribute('data-busy'):cta.getAttribute('data-idle')}
Q.busy=busy;
function sync(){if(chk){cta.classList.toggle('q-off',!chk.checked);cta.setAttribute('aria-disabled',chk.checked?'false':'true');if(chk.checked)need.classList.add('hidden')}}
if(chk){chk.addEventListener('change',sync);sync()}
var sheet=el.querySelector('.q-sheet'),fail=el.querySelector('.q-fail'),bootT=0,BOOT=Q.bootMs||${BOOT_MS};
function sheetOpen(){return !sheet.classList.contains('hidden')}
function go(retry){if(sheetOpen()||Q.failed)return;ctx();motion();Q.cam=camera();busy(true);hatch();
 if(Q.cam)Q.cam.then(function(r){if(r.error&&!Q.ready&&!Q.failed)Q.denied(r.error,retry)});
 if(!Q.booted&&!bootT)bootT=setTimeout(function(){bootT=0;if(!Q.booted)fails('timeout')},BOOT);
 var h=retry?Q.onRetry:Q.onTap;if(h)h()}
function stopEarly(){Q.cam=null;var a=Q.streams;Q.streams=[];for(var i=0;i<a.length;i++){try{a[i].getTracks().forEach(function(t){t.stop()})}catch(e){}}}
function fails(why){if(Q.ready||Q.failed)return;Q.failed=why;clearTimeout(bootT);bootT=0;ev('boot_fail',{why:why});stopEarly();busy(false);
 el.classList.remove('q-open');el.classList.remove('q-searching');el.querySelector('.q-search').classList.add('hidden');den.classList.add('hidden');if(sheetOpen())closeSheet();
 fail.classList.remove('hidden');try{fail.querySelector('[data-q="reboot"]').focus()}catch(e){}}
Q.fail=fails;
Q.boot=function(){Q.booted=true;clearTimeout(bootT);bootT=0;if(Q.failed==='timeout'){Q.failed=false;Q.tapped=false;fail.classList.add('hidden')}};
window.addEventListener('error',function(e){var t=e&&e.target;if(Q.booted||!t||t===window||t.tagName!=='SCRIPT'||t.type!=='module')return;fails('script')},true);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(function(){if(!Q.booted)fails('noboot')},${BOOT_GRACE_MS})});
cta.addEventListener('click',function(){if(Q.tapped||sheetOpen()||Q.failed)return;
 if(chk&&!chk.checked){need.classList.remove('hidden');var l=chk.closest('.q-check');l.classList.remove('need');void l.offsetWidth;l.classList.add('need');return}
 Q.tapped=true;ev('cta_tap',{early:Q.ready?0:1});go(false)});
var den=el.querySelector('.q-denied'),again=el.querySelector('.q-again');
Q.nd=0;
Q.denied=function(e,second){if(Q.failed)return;busy(false);el.classList.remove('q-open');den.classList.remove('hidden');Q.nd++;if(second||Q.nd>1)again.classList.remove('hidden');
 var ios=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 el.querySelector(ios?'.q-how-a':'.q-how-i').classList.add('q-later');var w=el.querySelector('.q-hows');var l=w.querySelector('.q-later');if(l)w.appendChild(l)};
el.querySelector('[data-q="retry"]').addEventListener('click',function(){den.classList.add('hidden');ev('camera_retry');go(true)});
el.querySelector('[data-q="reload"]').addEventListener('click',function(){location.reload()});
el.querySelector('[data-q="reboot"]').addEventListener('click',function(){ev('boot_retry');var u=new URL(location.href);u.searchParams.set('_boot',Date.now().toString(36));location.replace(u.href)});
var terms=el.querySelector('[data-q="terms"]'),opener=null,bg=['.q-sky','.q-stage','.q-text','.q-foot','.q-search'];
function inert(on){var n=bg.map(function(s){return el.querySelector(s)});n.push(document.getElementById('app'));
 n.forEach(function(x){if(!x)return;if(on){x.setAttribute('inert','');x.setAttribute('aria-hidden','true')}else{x.removeAttribute('inert');x.removeAttribute('aria-hidden')}})}
function tabbables(){return Array.prototype.filter.call(sheet.querySelectorAll('a[href],button,input,[tabindex]'),function(x){return !x.disabled&&x.getAttribute('tabindex')!=='-1'})}
function openSheet(){if(sheetOpen())return;opener=document.activeElement&&document.activeElement!==document.body?document.activeElement:terms;sheet.classList.remove('hidden');inert(true);ev('terms_open');
 var p=sheet.querySelector('.q-panel');try{p.focus()}catch(e){}}
function closeSheet(){if(!sheetOpen())return;sheet.classList.add('hidden');inert(false);var o=opener||terms;opener=null;try{o.focus()}catch(e){}}
terms.addEventListener('click',openSheet);
el.querySelector('[data-q="close"]').addEventListener('click',closeSheet);
sheet.addEventListener('click',function(e){if(e.target===sheet)closeSheet()});
document.addEventListener('keydown',function(e){if(!sheetOpen())return;
 if(e.key==='Escape'||e.key==='Esc'){e.preventDefault();closeSheet();return}
 if(e.key!=='Tab')return;var f=tabbables();if(!f.length){e.preventDefault();return}var a=document.activeElement,i=f.indexOf(a);
 if(e.shiftKey&&(i<=0)){e.preventDefault();f[f.length-1].focus()}else if(!e.shiftKey&&(i<0||i===f.length-1)){e.preventDefault();f[0].focus()}},true);
document.addEventListener('focusin',function(e){if(sheetOpen()&&!sheet.contains(e.target)){var f=tabbables();if(f[0])f[0].focus()}},true);
Q.search=function(){busy(false);el.classList.add('q-searching');el.querySelector('.q-search').classList.remove('hidden')};
Q.hide=function(){el.classList.add('q-leave');setTimeout(function(){el.classList.add('hidden')},480)};
})();`;

/** HTML заставки для <body> (до #app): стили, разметка, встроенный скрипт */
export function quickSplash(o: SplashOptions): string {
  const t = QUICK_TEXT;
  const check = o.consent === 'notice' ? '' : `<label class="q-check"><input type="checkbox" name="consent"><span>${esc(o.consent === 'parent' ? CONSENT_TEXT.parent : CONSENT_TEXT.checkbox)}</span></label>
    <div class="q-need hidden" role="alert">${esc(CONSENT_TEXT.needCheck)}</div>`;
  const policy = hasPolicyUrl(o.policyUrl)
    ? `<p><a href="${esc(o.policyUrl)}" target="_blank" rel="noopener">Полная политика конфиденциальности Сбера</a></p>`
    : '<p class="q-note">Ссылка на полную политику конфиденциальности Сбера будет здесь (TODO: src/config/consent.ts PRIVACY_POLICY_URL).</p>';
  return `<style id="quick-css">${CSS.replace(/\n\s*/g, '')}</style>
<div id="quick" data-consent="${o.consent}">
  <div class="q-sky" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <div class="q-stage">${CARD}</div>
  <div class="q-flash" aria-hidden="true"></div>
  <div class="q-text"><h1>${t.title}</h1><p>${t.sub}</p></div>
  <div class="q-foot">
    ${check}
    <button class="q-cta" type="button" data-a="wake" data-idle="${t.cta}" data-busy="${t.busy}"><span class="q-spin" aria-hidden="true"></span><span class="q-cta-t">${t.cta}</span></button>
    <p class="q-fine">${esc(CONSENT_TEXT.notice)} <button class="q-link" type="button" data-q="terms">${esc(CONSENT_TEXT.link)}</button></p>
  </div>
  <div class="q-search hidden" role="status" aria-live="polite"><span class="q-slot" aria-hidden="true"><span class="q-eyes"><i></i><i></i></span></span><span><b>${t.searchTitle}</b><small>${t.searchSub}</small></span></div>
  <div class="q-sheet hidden" role="dialog" aria-modal="true" aria-label="${esc(CONSENT_TEXT.link)}">
    <div class="q-panel" tabindex="-1">
      <h2>${esc(CONSENT_TEXT.link)}</h2>
      ${PRIVACY_SHEET.map(([h, p]) => `<p><b>${esc(h)}.</b> ${esc(p)}</p>`).join('')}
      ${policy}
      <p class="q-note">${esc(PRIVACY_DRAFT_NOTE)}</p>
      <button class="q-btn" type="button" data-q="close">Понятно</button>
    </div>
  </div>
  <div class="q-fail hidden" role="alertdialog" aria-modal="true" aria-label="Не загрузилось">
    <div class="q-panel">
      <div class="q-noeye" aria-hidden="true"></div>
      <h2>${t.failTitle}</h2>
      <p>${t.failSub}</p>
      <button class="q-btn" type="button" data-q="reboot">${t.failRetry}</button>
    </div>
  </div>
  <div class="q-denied hidden" role="alertdialog" aria-modal="true" aria-label="Нет доступа к камере">
    <div class="q-panel">
      <div class="q-noeye" aria-hidden="true"></div>
      <h2>${t.deniedTitle}</h2>
      <p>${t.deniedSub}</p>
      <div class="q-hows">
        <div class="q-how q-how-i"><h3>iPhone (Safari)</h3><ol><li>Нажми <b>«аА»</b> слева в адресной строке.</li><li><b>«Настройки веб-сайта»</b> → <b>«Камера»</b> → <b>«Разрешить»</b>.</li><li>Или: Настройки iPhone → Safari → Камера → «Спросить».</li></ol></div>
        <div class="q-how q-how-a"><h3>Android (Chrome)</h3><ol><li>Нажми значок слева от адреса сайта.</li><li><b>«Разрешения»</b> → <b>«Камера»</b> → <b>«Разрешить»</b>.</li></ol></div>
      </div>
      <button class="q-btn" type="button" data-q="retry">${t.retry}</button>
      <div class="q-again hidden"><p class="q-note">Окошко не появилось? Включи камеру в настройках (см. выше) и обнови страницу.</p><button class="q-btn q-ghost" type="button" data-q="reload">${t.reload}</button></div>
    </div>
  </div>
</div>
<script>${SCRIPT}</script>`;
}

/** тот же скрипт — для теста ограничений камеры */
export const QUICK_SCRIPT = SCRIPT;
