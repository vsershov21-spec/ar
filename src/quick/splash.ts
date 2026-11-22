/**
 * Быстрый вход (feature 'intro.quick', docs/EDITIONS.md): заставка и единственный экран — прямо в index.html,
 * без ожидания JS-бандла. Вставляет её сборка (vite.config.ts → quickSplash(), transformIndexHtml) только в редакциях,
 * где функция включена (lab, pilot); MVP-корень не меняется.
 *
 * Загадка (правка продакта 22.11): кота до разрешений НЕ показываем — только детская карта Сбера, из тёмной щели
 * которой смотрят светящиеся глаза, моргают, виден силуэт ушек, карта подрагивает, из щели летят искры, из-за края
 * мелькает лапка. Касание карты (это жест) — «тук-тук» / «мурр» синтезом Web Audio, без файлов.
 * Сам кот — только после нажатия, в катсцене пробуждения из карты (src/awake) как раскрытие тайны.
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
} as const;

export interface SplashOptions {
  consent: ConsentMode;
  policyUrl: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** детская карта Сбера (как на онбординге): чип, знак, «СБЕР KIDS»; щель с глазами и ушками, лапка, искры */
const CARD = `
<button class="q-card" type="button" aria-label="Постучать в карту">
  <span class="q-paw" aria-hidden="true"><i></i><i></i><i></i><b></b></span>
  <span class="q-face" aria-hidden="true">
    <span class="q-chip"></span>
    <span class="q-logo"><i class="q-ring"></i>СБЕР&nbsp;KIDS</span>
    <span class="q-dots"></span>
    <span class="q-slot"><span class="q-ears"><i></i><i></i></span><span class="q-eyes"><i></i><i></i></span></span>
  </span>
  <span class="q-sparks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span>
</button>`;

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
#quick .q-card{position:relative;width:min(74vw,300px);aspect-ratio:1.586;border:0;padding:0;background:none;cursor:pointer;
  transform:rotate(-8deg);animation:qJig 6s ease-in-out infinite;outline:none}
#quick .q-face{position:absolute;inset:0;border-radius:16px;overflow:hidden;
  background:linear-gradient(135deg,#2bd36a 0%,#16a34a 42%,#0e7a5a 78%,#0b5c63 100%);
  box-shadow:0 18px 40px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.12) inset,0 0 60px rgba(70,255,160,.16)}
#quick .q-dots{position:absolute;inset:0;opacity:.18;background:radial-gradient(circle at 20% 30%,#fff 0 2px,transparent 3px) 0 0/26px 26px}
#quick .q-chip{position:absolute;left:9%;top:30%;width:15%;aspect-ratio:1.3;border-radius:5px;background:linear-gradient(135deg,#f7e6a6,#cfa84a);box-shadow:0 0 0 1px rgba(0,0,0,.15) inset}
#quick .q-logo{position:absolute;left:9%;top:9%;font-weight:800;font-size:clamp(11px,3.4vw,14px);letter-spacing:.06em;display:flex;align-items:center;gap:6px}
#quick .q-ring{width:15px;height:15px;border-radius:50%;border:2.5px solid #fff;display:inline-block}
#quick .q-slot{position:absolute;left:36%;right:10%;top:44%;height:36%;border-radius:999px;
  background:radial-gradient(ellipse at 50% 60%,#000 0%,#020604 55%,#06140d 100%);box-shadow:0 0 0 2px rgba(0,0,0,.35),0 0 22px rgba(0,0,0,.7) inset;overflow:hidden}
#quick .q-slot::before{content:"";position:absolute;left:27%;right:27%;top:30%;bottom:-30%;border-radius:48% 48% 40% 40%;background:#0f241a;animation:qEars 7s ease-in-out infinite}
#quick .q-ears{position:absolute;left:27%;right:27%;top:4%;height:34%;display:flex;justify-content:space-between;opacity:.9;animation:qEars 7s ease-in-out infinite}
#quick .q-ears i{width:36%;height:100%;background:#0f241a;clip-path:polygon(30% 0,100% 100%,0 100%)}
#quick .q-ears i+i{clip-path:polygon(70% 0,100% 100%,0 100%)}
#quick .q-eyes{position:absolute;left:30%;right:30%;top:46%;height:30%;display:flex;justify-content:space-between;animation:qLook 5.2s ease-in-out infinite}
#quick .q-eyes i{width:30%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 45%,#fbffd0 0,#d7ff4f 38%,#7bd800 70%);
  box-shadow:0 0 10px #c6ff3a,0 0 22px rgba(170,255,60,.55);animation:qBlink 4.3s infinite}
#quick .q-paw{position:absolute;right:-2%;top:20%;width:22%;aspect-ratio:1;z-index:-1;animation:qPaw 7.5s ease-in-out infinite;transform:translateX(-40%)}
#quick .q-paw b{position:absolute;left:18%;top:30%;width:64%;height:60%;border-radius:50%;background:#2a3b33}
#quick .q-paw i{position:absolute;top:8%;width:24%;height:30%;border-radius:50%;background:#2a3b33}
#quick .q-paw i:nth-child(1){left:10%;top:22%}#quick .q-paw i:nth-child(2){left:38%}#quick .q-paw i:nth-child(3){left:66%;top:22%}
#quick .q-sparks{position:absolute;left:58%;top:52%;width:0;height:0;pointer-events:none}
#quick .q-sparks i{position:absolute;width:5px;height:5px;border-radius:50%;background:#fff6b0;box-shadow:0 0 8px #ffe76a;opacity:0;animation:qSpark 2.8s ease-out infinite}
#quick .q-sparks i:nth-child(2){animation-delay:.45s;--x:-30px}#quick .q-sparks i:nth-child(3){animation-delay:.9s;--x:26px}
#quick .q-sparks i:nth-child(4){animation-delay:1.4s;--x:-12px}#quick .q-sparks i:nth-child(5){animation-delay:1.9s;--x:40px}#quick .q-sparks i:nth-child(6){animation-delay:2.3s;--x:-44px}
#quick .q-card.knock{animation:qKnock .5s ease-in-out}
#quick .q-card.knock .q-eyes i{transform:scale(1.25);animation:none}
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
#quick .q-sheet,#quick .q-denied{position:absolute;inset:0;z-index:2;display:flex;align-items:flex-end;justify-content:center;background:rgba(3,8,6,.72)}
#quick .q-denied{align-items:center;background:radial-gradient(120% 80% at 50% 30%,#1d2a24,#070c0a)}
#quick .q-panel{width:100%;max-width:440px;max-height:86%;overflow:auto;background:#fff;color:#14201a;border-radius:22px 22px 0 0;padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px)}
#quick .q-denied .q-panel{background:none;color:#fff;border-radius:0;max-height:100%;text-align:center}
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
#quick .q-search .q-slot{position:relative;left:auto;right:auto;top:auto;flex:none;width:58px;height:36px}
#quick .q-search .q-eyes{left:22%;right:22%;top:32%;height:36%}
#quick .q-search b{display:block;font-size:16px;line-height:1.25}
#quick .q-search small{display:block;font-size:13px;opacity:.75;margin-top:2px}
#quick.q-searching{background:transparent;pointer-events:none}
#quick.q-searching>.q-sky,#quick.q-searching>.q-stage,#quick.q-searching>.q-text,#quick.q-searching>.q-foot{display:none}
@keyframes qTw{0%,100%{opacity:.15}50%{opacity:.8}}
@keyframes qJig{0%,78%,100%{transform:rotate(-8deg)}81%{transform:rotate(-6deg) translateY(-2px)}84%{transform:rotate(-10deg)}87%{transform:rotate(-7deg)}90%{transform:rotate(-9deg)}}
@keyframes qKnock{0%,100%{transform:rotate(-8deg)}20%{transform:rotate(-4deg) scale(1.03)}40%{transform:rotate(-12deg)}60%{transform:rotate(-6deg)}80%{transform:rotate(-9deg)}}
@keyframes qBlink{0%,44%,50%,100%{transform:scaleY(1)}47%{transform:scaleY(.08)}}
@keyframes qLook{0%,30%{transform:translateX(0)}40%,55%{transform:translateX(-14%)}65%,85%{transform:translateX(12%)}100%{transform:translateX(0)}}
@keyframes qEars{0%,60%,100%{transform:translateY(0)}68%,76%{transform:translateY(-10%)}}
@keyframes qPaw{0%,55%,100%{transform:translateX(-40%) rotate(0)}62%,70%{transform:translateX(38%) rotate(14deg)}74%{transform:translateX(30%) rotate(4deg)}80%{transform:translateX(-40%)}}
@keyframes qSpark{0%{opacity:0;transform:translate(0,0) scale(.6)}15%{opacity:1}100%{opacity:0;transform:translate(var(--x,14px),-80px) scale(.2)}}
@keyframes qPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.025)}}
@keyframes qSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#quick *,#quick .q-card{animation:none!important;transition:none!important}#quick .q-sparks{display:none}}
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
function purr(c,t){var n=c.sampleRate*1.1|0,b=c.createBuffer(1,n,c.sampleRate),d=b.getChannelData(0);for(var i=0;i<n;i++){var k=i/c.sampleRate;d[i]=(Math.random()*2-1)*(.55+.45*Math.sin(2*Math.PI*23*k))*Math.min(1,k*6,(1.1-k)*4)}
 var s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();f.type='lowpass';f.frequency.value=320;g.gain.value=.55;s.buffer=b;s.connect(f);f.connect(g);g.connect(c.destination);s.start(t)}
var card=el.querySelector('.q-card'),knocks=0;
card.addEventListener('click',function(){card.classList.remove('knock');void card.offsetWidth;card.classList.add('knock');
 var c=ctx();if(!c)return;var t=c.currentTime+.02;if(knocks++%2===0){thump(c,t,180);thump(c,t+.19,150)}else purr(c,t)});
var own=!(qs.has('tracker')||qs.has('nocard')||qs.has('desktop')||qs.has('debug'));
function vc(){var hd=qs.get('cam')==='720';return{facingMode:'environment',width:{ideal:hd?1280:960},height:{ideal:hd?720:540},frameRate:{ideal:30}}}
function ac(){var aec=qs.get('aec')!=='0';return{echoCancellation:aec,noiseSuppression:aec,autoGainControl:false,channelCount:1}}
function camera(){var md=navigator.mediaDevices;if(!own||!md||!md.getUserMedia)return null;
 try{var as=navigator.audioSession;if(as&&!qs.get('session')&&as.type!=='play-and-record')as.type='play-and-record'}catch(e){}
 return md.getUserMedia({video:vc(),audio:ac()}).then(function(s){ev('camera_granted');ev(s.getAudioTracks().length?'mic_granted':'mic_denied');return{stream:s}},
  function(e){return md.getUserMedia({video:vc(),audio:false}).then(function(s){ev('camera_granted');ev('mic_denied');return{stream:s,mic:e&&e.name}},
   function(e2){ev('camera_denied');return{error:{name:e2&&e2.name||'Error',message:String(e2&&e2.message||e2)}}})})}
function motion(){var r=[],M=window.DeviceMotionEvent,O=window.DeviceOrientationEvent;
 try{if(M&&M.requestPermission)r.push(M.requestPermission().catch(function(){return'denied'}));if(O&&O.requestPermission)r.push(O.requestPermission().catch(function(){return'denied'}))}catch(e){}
 if(r.length)Q.motion=Promise.all(r).then(function(x){return x[0]==='granted'})}
var cta=el.querySelector('.q-cta'),txt=el.querySelector('.q-cta-t'),chk=el.querySelector('.q-check input'),need=el.querySelector('.q-need');
function busy(on){cta.classList.toggle('busy',on);cta.disabled=on;txt.textContent=on?cta.getAttribute('data-busy'):cta.getAttribute('data-idle')}
Q.busy=busy;
function sync(){if(chk){cta.classList.toggle('q-off',!chk.checked);cta.setAttribute('aria-disabled',chk.checked?'false':'true');if(chk.checked)need.classList.add('hidden')}}
if(chk){chk.addEventListener('change',sync);sync()}
function go(retry){ctx();motion();Q.cam=camera();busy(true);
 if(Q.cam)Q.cam.then(function(r){if(r.error&&!Q.ready)Q.denied(r.error,retry)});
 var h=retry?Q.onRetry:Q.onTap;if(h)h()}
cta.addEventListener('click',function(){if(Q.tapped)return;
 if(chk&&!chk.checked){need.classList.remove('hidden');var l=chk.closest('.q-check');l.classList.remove('need');void l.offsetWidth;l.classList.add('need');return}
 Q.tapped=true;ev('cta_tap',{early:Q.ready?0:1});go(false)});
var den=el.querySelector('.q-denied'),again=el.querySelector('.q-again');
Q.nd=0;
Q.denied=function(e,second){busy(false);den.classList.remove('hidden');Q.nd++;if(second||Q.nd>1)again.classList.remove('hidden');
 var ios=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 el.querySelector(ios?'.q-how-a':'.q-how-i').classList.add('q-later');var w=el.querySelector('.q-hows');var l=w.querySelector('.q-later');if(l)w.appendChild(l)};
el.querySelector('[data-q="retry"]').addEventListener('click',function(){den.classList.add('hidden');ev('camera_retry');go(true)});
el.querySelector('[data-q="reload"]').addEventListener('click',function(){location.reload()});
var sheet=el.querySelector('.q-sheet');
el.querySelector('[data-q="terms"]').addEventListener('click',function(){sheet.classList.remove('hidden');ev('terms_open')});
el.querySelector('[data-q="close"]').addEventListener('click',function(){sheet.classList.add('hidden')});
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
  <div class="q-text"><h1>${t.title}</h1><p>${t.sub}</p></div>
  <div class="q-foot">
    ${check}
    <button class="q-cta" type="button" data-a="wake" data-idle="${t.cta}" data-busy="${t.busy}"><span class="q-spin" aria-hidden="true"></span><span class="q-cta-t">${t.cta}</span></button>
    <p class="q-fine">${esc(CONSENT_TEXT.notice)} <button class="q-link" type="button" data-q="terms">${esc(CONSENT_TEXT.link)}</button></p>
  </div>
  <div class="q-search hidden" role="status" aria-live="polite"><span class="q-slot" aria-hidden="true"><span class="q-eyes"><i></i><i></i></span></span><span><b>${t.searchTitle}</b><small>${t.searchSub}</small></span></div>
  <div class="q-sheet hidden" role="dialog" aria-modal="true" aria-label="${esc(CONSENT_TEXT.link)}">
    <div class="q-panel">
      <h2>${esc(CONSENT_TEXT.link)}</h2>
      ${PRIVACY_SHEET.map(([h, p]) => `<p><b>${esc(h)}.</b> ${esc(p)}</p>`).join('')}
      ${policy}
      <p class="q-note">${esc(PRIVACY_DRAFT_NOTE)}</p>
      <button class="q-btn" type="button" data-q="close">Понятно</button>
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
