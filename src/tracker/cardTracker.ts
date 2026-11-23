/**
 * Трекер «карта Сбера»: камера → уменьшенный кадр (320 px по длинной стороне) → Web Worker (детектор, ведение по
 * ключевому кадру, проверка «карта Сбера») → углы карты → ядро на главном потоке (./card/session.ts: машина
 * состояний, поза на момент съёмки, гироскоп, фильтр в мире) → якорь кота на каждый кадр рендера.
 *
 *   SEARCH → CANDIDATE (проверка «карта Сбера» + стабильность, кольцо 0–100 %) → LOCKED (ведение)
 *          → HOLD (карты не видно: поверхность/гироскоп) → RELOCALIZE (та же карта рядом с прогнозом) → LOST
 *
 * Здесь — только браузер: камера и её сторож, отправка кадров (с ориентацией телефона в момент съёмки и
 * поворотом с прошлого кадра для прогноза), оверлей, события. Логика — в session.ts/fsm.ts (тесты, стенд).
 * Причины переходов — в ?debug (строка на экране и консоль). Описание: docs/CARD_DETECTION.md.
 */
import * as THREE from 'three';
import { TrackerBase } from './base';
import type { Tracker } from './types';
import { CARD_ASPECT, type Intrinsics, type Pose, type Pt, type Quad } from './card/geometry';
import { focalFromFov } from './card/detector';
import type { CardWorkerIn, CardWorkerOut } from './card/worker';
import { CardOverlay } from './card/overlay';
import type { CardKind } from './card/verify';
import { CardSession, OrientationHistory } from './card/session';
import type { TrackState } from './card/fsm';
import { perf } from '../core/perf';
import { trackerLuma } from './cardMonitor';
import { CardRecorder, recRequested } from './cardRecorder';
import { takeEarlyCamera } from '../quick/early';

export interface CardView {
  /** углы карты (TL, TR, BR, BL) в px экрана */
  quad: Quad;
  pose: Pose;
  /** проекция точки модели карты (X, Y — ширины карты) в px экрана */
  project: (x: number, y: number) => Pt | null;
}

export class CardTracker extends TrackerBase implements Tracker {
  readonly capabilities = { imageTarget: true, worldTracking: false, orientationFallback: true };
  readonly name = 'card';
  readonly aspect = CARD_ASPECT;
  video: HTMLVideoElement | null = null;
  readonly overlay: CardOverlay;
  /** последнее, что видел детектор (для оверлея, энергобюджета и debug) */
  view: CardView | null = null;
  stats = { ms: 0, fps: 0, score: 0, mode: 'none', ver: '' as CardKind | '', verLine: '', state: 'search' as TrackState, hint: '' as string, progress: 0, key: '' };
  /**
   * Проверка «это карта Сбера?» по содержимому кандидата (чип, знак Сбера, оборот — src/tracker/card/verify.ts).
   * ?anycard — выключить: кот садится на любой прямоугольник с пропорциями карты (старое поведение).
   */
  readonly verify = !hasParam('anycard');
  private verDebug = hasParam('debug');
  /** ядро: машина состояний, поза, гироскоп, фильтр (без DOM) */
  readonly session = new CardSession(this.verify);
  /** ориентация телефона по времени — чтобы знать её в момент съёмки кадра */
  private orient = new OrientationHistory();
  /**
   * Задержка камеры: кадр, показанный в <video> (requestVideoFrameCallback), снят примерно на столько раньше, мс.
   * Источник правды — session.camLatMs: начинается с сохранённой оценки этого телефона (или 33 мс), уточняется по
   * самой карте (session.ts LatencyEstimator); ?camlat=N — задать и не уточнять.
   */
  get camLatMs() {
    return this.session.camLatMs;
  }

  private worker: Worker | null = null;
  private busy = false;
  private running = false;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  /** фрагмент кадра вокруг карты в большем разрешении — для чипа и знака Сбера */
  private cropCanvas = document.createElement('canvas');
  private cropCtx = this.cropCanvas.getContext('2d', { willReadFrequently: true })!;
  private cropAt = -1e9;
  private dw = 320;
  private dh = 180;
  /** последние углы карты в кадре детектора (для фрагмента под проверку) */
  private prevQuad: Quad | null = null;
  private w = 1;
  private h = 1;
  /** видео на экране (object-fit: cover): размер и сдвиг */
  private vw = 1;
  private vh = 1;
  private frames = 0;
  private fpsT = 0;
  /** номер отправленного кадра и ориентация телефона при его съёмке */
  private sendId = 0;
  private sentCap: { id: number; q: THREE.Quaternion | null; shownAt: number } | null = null;
  /** когда на экране появился последний кадр камеры (rVFC; без него — время отправки) */
  private shownAt = 0;
  /** пересадка без новой карты дольше 6 с — «карта потеряна» (как раньше) */
  private reanchorAt = -1;
  /** воркер сказал: следующий кадр — с полным поиском (к нему — фрагмент под проверку) */
  private nextDetect = true;
  /**
   * Кот уже стоит на экране (была посадка, не «Пересадить»): никакого поискового интерфейса поверх кота — ни кольца,
   * ни пунктира, ни «Держи телефон ровно…», ни повторного «Нашёл карту!»; повторная посадка — тихо.
   */
  private catPlaced = false;
  /**
   * Кот уже сидел на карте в этой сессии (переживает «Пересадить» и возврат из «Мира кота»): кот на экране (у стекла),
   * поэтому подсказки поиска — без текста поверх игры («Держи телефон ровно…», «Поднеси телефон ближе», «Это не
   * карта» висели поверх кота после «На карту» — запись 20.11), только пунктир и кольцо над самой картой.
   */
  private everPlaced = false;
  /** телефон вплотную к карте: множитель роста кота (anchor.userData.catScale) и когда в последний раз просили отодвинуть */
  private catScale = 1;
  private nearSince = -1;
  private nearHintAt = -1e9;

  constructor(private container: HTMLElement) {
    super();
    this.overlay = new CardOverlay(container);
    const fixed = numParam('camlat', NaN);
    let savedLat = NaN;
    try {
      savedLat = parseFloat(localStorage.getItem(LAT_KEY) ?? '');
    } catch {
      /* приватный режим */
    }
    this.session.camLatMs = Number.isFinite(fixed) ? fixed : savedLat > 0 && savedLat < 200 ? savedLat : 33;
    this.session.latFixed = Number.isFinite(fixed);
    this.session.history = this.orient;
    this.session.onLatency = (ms) => {
      try {
        localStorage.setItem(LAT_KEY, ms.toFixed(1));
      } catch {
        /* приватный режим */
      }
    };
    this.session.onFocal = (f) => {
      this.resize(this.w, this.h);
      try {
        localStorage.setItem(FOCAL_KEY, String(f / Math.max(this.dw, this.dh)));
      } catch {
        /* приватный режим */
      }
    };
  }

  private get K(): Intrinsics {
    return this.session.K;
  }

  /**
   * Открыть камеру ВМЕСТЕ с микрофоном одним getUserMedia (iOS: второй запрос за микрофоном рвёт видео).
   * Аудиодорожка — в audioStream, её забирает MicInput.adopt. Микрофон запрещён/не нужен — камера откроется одна.
   */
  withAudio = false;
  audioStream: MediaStream | null = null;
  /**
   * Камера открылась, а микрофон — нет (имя ошибки getUserMedia: NotAllowedError…): App.wake сообщает об этом
   * микрофону (MicInput.markDenied) — без этого запрет, полученный в общем запросе, забывался: тоста «нет доступа к
   * микрофону» не было, и кот звал «Скажи…» (E2E 22.11, scripts/qa/e2e).
   */
  micError: string | null = null;

  /** Камера: вызывать прямо из обработчика жеста (iOS требует user gesture для getUserMedia/play). */
  async startVideo(): Promise<void> {
    // повтор после отказа в камере (быстрый вход, «Попробовать ещё раз»): пустой прошлый <video> — убрать
    if (this.video && !this.video.srcObject) this.video.remove();
    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.playsInline = true;
    video.className = 'camera-video';
    // экран заполняет сам браузер (object-fit: cover); геометрию той же обрезки считаем в resize()
    Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '0' });
    this.container.prepend(video);
    // iOS: размер кадра становится известен (и меняется при повороте) после старта — пересчитать всё
    video.addEventListener('resize', () => this.onVideoSize());
    video.addEventListener('loadedmetadata', () => this.onVideoSize());
    this.video = video;
    this.watchFrames(video);
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-getusermedia');
    await this.openCamera(video, this.withAudio);
    this.watchCamera();
  }

  private async openCamera(video: HTMLVideoElement, withAudio = false) {
    // 720p и 30 к/с: больше трекеру (320 px) и экрану не нужно, а камера 60 к/с / 4K греет телефон
    // 960×540: детектору нужно 320 px, фрагменту под проверку знака — карта ≈ 280 px (при карте на полкадра хватает);
    // чтение кадра в главном потоке (iOS) дешевле, чем с 1280×720 (?cam=720 — как раньше)
    const hd = new URLSearchParams(location.search).get('cam') === '720';
    const vc: MediaTrackConstraints = { facingMode: 'environment', width: { ideal: hd ? 1280 : 960 }, height: { ideal: hd ? 720 : 540 }, frameRate: { ideal: 30 } };
    let stream: MediaStream | null = null;
    // быстрый вход (src/quick/splash.ts): заставка уже открыла камеру (+ микрофон) в жесте теми же ограничениями
    const early = takeEarlyCamera();
    if (early) {
      const r = await early;
      if (r.error) throw Object.assign(new Error(r.error.message), { name: r.error.name, early: true });
      if (r.stream) {
        const at = r.stream.getAudioTracks();
        if (withAudio) this.audioStream = at.length ? new MediaStream(at) : null;
        else at.forEach((t) => t.stop());
        if (r.mic) this.debug('заставка: камера+микрофон вместе не вышло (' + r.mic + ') — камера отдельно');
        if (withAudio && r.mic && !at.length) this.micError = r.mic;
        stream = new MediaStream(r.stream.getVideoTracks());
      }
    }
    if (!stream && withAudio) {
      const aec = new URLSearchParams(location.search).get('aec') !== '0';
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: { echoCancellation: aec, noiseSuppression: aec, autoGainControl: false, channelCount: 1 } });
        const at = stream.getAudioTracks();
        this.audioStream = at.length ? new MediaStream(at) : null;
        // в <video> — только видео (иначе звук микрофона в динамик и лишняя дорожка у плеера)
        stream = new MediaStream(stream.getVideoTracks());
      } catch (e) {
        this.debug('камера+микрофон одним запросом не вышло (' + (e as Error)?.name + ') — камера отдельно');
        this.micError = (e as Error)?.name ?? 'Error';
        stream = null;
      }
    }
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: false, video: vc });
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.srcObject = stream;
    });
    await video.play().catch(() => undefined);
    const track = stream.getVideoTracks()[0];
    if (track) track.onended = () => this.reviveCamera('ended');
  }

  /**
   * iOS иногда обрывает камеру (звонок, Siri, уведомление, смена аудиосессии) — фон становится чёрным, кот висит на нём.
   * Сторож: нет новых кадров дольше 1,5 с при видимой вкладке или дорожка завершилась → тихо переоткрываем камеру.
   */
  private camTimer = 0;
  private lastCt = -1;
  private staleRun = 0;
  private mutedRun = 0;
  private rvfcGen = 0;
  private reviving = false;
  private watchCamera() {
    clearInterval(this.camTimer);
    this.camTimer = window.setInterval(() => {
      const v = this.video;
      if (!v || !this.running || document.visibilityState !== 'visible') return;
      const s = v.srcObject as MediaStream | null;
      const t = s?.getVideoTracks()[0];
      // «кадры не идут»: requestVideoFrameCallback молчит > 1,5 с И время видео не движется — две проверки подряд.
      // (rVFC может пропускать вызовы при нагрузке/троттлинге, а ложное переоткрытие камеры на iPhone = чёрный кадр)
      const ct = v.currentTime;
      const frozen = ct === this.lastCt;
      this.lastCt = ct;
      const stale = this.rvfc && performance.now() - this.rvfcAt > 1500 && frozen;
      this.staleRun = stale ? this.staleRun + 1 : 0;
      // muted (iOS: звонок/Siri) обычно снимается сам — переоткрываем, только если держится 3 с
      this.mutedRun = t?.muted ? this.mutedRun + 1 : 0;
      if (!t || t.readyState === 'ended' || v.paused || this.staleRun >= 2 || this.mutedRun >= 3) void this.reviveCamera(this.staleRun >= 2 ? 'stale' : this.mutedRun >= 3 ? 'muted' : t?.readyState ?? 'no-track');
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.video?.paused) void this.video.play().catch(() => undefined);
    });
  }

  private async reviveCamera(why: string) {
    const v = this.video;
    if (!v || this.reviving || document.visibilityState !== 'visible') return;
    this.reviving = true;
    try {
      // сначала просто «пнуть» видео — часто этого хватает после паузы iOS
      if (v.paused) await v.play().catch(() => undefined);
      const t = (v.srcObject as MediaStream | null)?.getVideoTracks()[0];
      if (t && t.readyState === 'live' && !v.paused && why !== 'stale' && why !== 'muted') return;
      this.staleRun = this.mutedRun = 0;
      console.warn('[card] камера переоткрывается:', why);
      // только видео: микрофон (дорожка из общего запроса) живёт своей жизнью в MicInput
      (v.srcObject as MediaStream | null)?.getVideoTracks().forEach((x) => x.stop());
      await this.openCamera(v);
      this.rvfcAt = performance.now();
      this.watchFrames(v);
    } catch (e) {
      console.warn('[card] камеру не переоткрыть', e);
    } finally {
      this.reviving = false;
    }
  }

  /** ?rec — запись камеры для стенда (src/tracker/cardRecorder.ts) */
  private recorder: CardRecorder | null = null;
  /** когда в последний раз были углы карты (для размытия номера на записи) */
  private quadAt = 0;

  async start(): Promise<void> {
    const self = this;
    if (!this.video) await this.startVideo();
    this.hold.start();
    this.hold.onSample = (t, q) => {
      this.orient.push(t, q);
      this.recorder?.sample(t, q);
    };
    // ?rec (lab и /test): запись чистой камеры + гироскопа для стенда card:eval, номер карты размыт
    const recName = recRequested();
    if (recName && this.video && !this.recorder) {
      this.recorder = new CardRecorder(
        {
          video: this.video,
          container: this.container,
          get dw() {
            return self.dw;
          },
          get dh() {
            return self.dh;
          },
          quad: () => (this.prevQuad ? { q: this.prevQuad, at: this.quadAt } : null),
          focal: () => this.K.f,
          camLatMs: () => this.camLatMs,
          state: () => this.session.state,
        },
        recName,
      );
    }
    this.worker?.terminate();
    this.busy = false;
    this.worker = new Worker(new URL('./card/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<CardWorkerOut>) => this.onResult(e.data);
    this.worker.onerror = (e) => console.warn('[card] worker', e.message);
    this.running = true;
    this.rvfcAt = performance.now();
    this.setupFrame();
    this.resize(this.w, this.h);
    this.pump();
  }

  stop() {
    clearInterval(this.camTimer);
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
    // кадр, отправленный в убитый воркер, не вернётся: без сброса после «На карту» (дом → карта) новый воркер не получал
    // ни одного кадра — карта не находилась никогда, кот «Алё, а карта где?» (E2E 22.11, через раз)
    this.busy = false;
    const s = this.video?.srcObject as MediaStream | null;
    s?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    this.video = null;
    this.overlay.hide(true);
  }

  private lastVW = 0;
  private lastVH = 0;
  private onVideoSize() {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    if (v.videoWidth === this.lastVW && v.videoHeight === this.lastVH) return;
    this.lastVW = v.videoWidth;
    this.lastVH = v.videoHeight;
    this.setupFrame();
    this.resize(this.w, this.h);
    this.prevQuad = null;
    this.debug('размер кадра камеры: ' + v.videoWidth + '×' + v.videoHeight + ' — детектор сброшен');
    this.worker?.postMessage({ rgba: new ArrayBuffer(4), w: 1, h: 1, focal: 1, reset: true });
  }

  private setupFrame() {
    const v = this.video!;
    const vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
    const k = 320 / Math.max(vw, vh);
    this.dw = Math.round(vw * k);
    this.dh = Math.round(vh * k);
    this.canvas.width = this.dw;
    this.canvas.height = this.dh;
    // фокус: сохранённая калибровка этого телефона (доля от длинной стороны кадра) или типичный угол обзора
    let saved = NaN;
    try {
      saved = parseFloat(localStorage.getItem(FOCAL_KEY) ?? '');
    } catch {
      /* приватный режим */
    }
    // iPhone: основная камера 24–26 мм (экв.) — угол обзора по длинной стороне ≈ 67–73°, а не 63° (по записи 18.11:
    // фокус по набору углов карты ≈ 73°, прежняя самокалибровка — 70°; с 63° позы вблизи отбрасывались, кот терял карту)
    const fDef = focalFromFov(this.dw, this.dh, isIOS() ? IOS_HFOV : undefined);
    this.session.K = { f: saved > 0 ? saved * Math.max(this.dw, this.dh) : fDef, cx: this.dw / 2, cy: this.dh / 2 };
    this.session.w = this.dw;
    this.session.h = this.dh;
    this.session.resetFocalSamples();
  }

  /**
   * Производительность: в воркер идут только новые кадры камеры (requestVideoFrameCallback: камера даёт 30 к/с,
   * экран — 60; повтор того же кадра ничего не добавляет, а грел телефон вдвое). maxHz — потолок частоты
   * (энергобюджет/адаптивное качество, 0 — без потолка). Потолок действует только когда карта ведётся и телефон
   * неподвижен: при движении, поиске и потере трекер всегда на полной частоте (иначе кот отстаёт и теряет карту).
   */
  maxHz = 0;
  /** энергобюджет: полный поиск карты раз в N кадров трекера (0 — по умолчанию детектора) */
  detectEvery = 0;
  private fullUntil = 0;
  private frameSeq = 0;
  private sentSeq = -1;
  private rvfc = false;
  private rvfcAt = 0;
  private sentAt = 0;
  /** кадр в воркер как VideoFrame (Chrome/Android); Safari и отказ воркера — по-старому, ?grab=main|frame — вручную */
  private frameGrab = useFrameGrab();
  /**
   * Кадр уменьшает createImageBitmap, пиксели читает воркер (главный поток не делает drawImage/getImageData —
   * docs/qa/BUGS.md № 13). По умолчанию — вне iOS как запасной путь, если не вышел VideoFrame; на iPhone — только
   * ?grab=bitmap (не проверено на устройстве); ?grab=main — по-старому.
   */
  private bitmapGrab = useBitmapGrab();

  private watchFrames(v: HTMLVideoElement) {
    const vv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now?: number) => void) => number };
    if (typeof vv.requestVideoFrameCallback !== 'function') return;
    this.rvfc = true;
    const gen = ++this.rvfcGen;
    const cb = (now?: number) => {
      if (gen !== this.rvfcGen) return; // цепочка заменена (после переоткрытия камеры)
      this.frameSeq++;
      this.rvfcAt = performance.now();
      // момент показа кадра: время rVFC (≈ композиция кадра); съёмка — на camLat раньше
      this.shownAt = typeof now === 'number' && Math.abs(now - this.rvfcAt) < 200 ? now : this.rvfcAt;
      if (this.video === v) vv.requestVideoFrameCallback!(cb);
    };
    vv.requestVideoFrameCallback(cb);
  }

  /** следующий кадр — в воркер, как только он освободился */
  private pump = () => {
    if (!this.running) return;
    const v = this.video;
    if (!this.busy && v && v.readyState >= 2 && this.worker && this.frameDue()) {
      if (v.videoWidth !== this.lastVW || v.videoHeight !== this.lastVH) this.onVideoSize();
      this.sentSeq = this.frameSeq;
      const t0 = performance.now();
      this.sentAt = t0;
      this.busy = true;
      // ориентация телефона в момент съёмки этого кадра: он на экране с shownAt (rVFC), снят на camLat раньше
      // (раньше — «время отправки − 33 мс»: кадр мог висеть до отправки ещё до 33 мс, поворот на это время терялся)
      const shownAt = this.rvfc && t0 - this.shownAt < 100 ? this.shownAt : t0;
      const capQ = this.orient.at(shownAt - this.camLatMs);
      const id = ++this.sendId;
      this.sentCap = { id, q: capQ, shownAt };
      const req = this.session.request(t0, capQ);
      const frame = this.frameGrab ? grabFrame(v) : null;
      const crop = this.cropRect(v);
      const base = (rgba: ArrayBuffer): CardWorkerIn => {
        const msg: CardWorkerIn = { id, rgba, w: this.dw, h: this.dh, focal: this.K.f, lock: req.lock, hint: req.hint, hintRadius: req.hintRadius, rot: req.rot, verify: this.verify, lostMs: req.lostMs };
        if (this.detectEvery > 0) msg.detectEvery = this.detectEvery;
        return msg;
      };
      if (!frame && this.bitmapGrab) {
        // ?grab=bitmap: уменьшение кадра — createImageBitmap (вне главного потока), пиксели читает воркер
        const k = (v.videoWidth || this.dw) / this.dw;
        const w = this.worker;
        Promise.all([
          createImageBitmap(v, { resizeWidth: this.dw, resizeHeight: this.dh, resizeQuality: 'low' }),
          crop ? createImageBitmap(v, crop.x0 * k, crop.y0 * k, crop.w * k, crop.h * k, { resizeWidth: crop.cw, resizeHeight: crop.ch }) : Promise.resolve(null),
        ])
          .then(([b, cb]) => {
            const msg = base(new ArrayBuffer(0));
            msg.bitmap = b;
            const tr: Transferable[] = [b];
            if (cb && crop) {
              msg.cropBitmap = cb;
              msg.crop = crop;
              tr.push(cb);
            }
            w.postMessage(msg, tr);
          })
          .catch((e) => {
            this.debug('createImageBitmap не вышел (' + String(e) + ') — кадры читаем на главном потоке');
            this.bitmapGrab = false;
            this.busy = false;
          });
        perf.add('tracker.grab', performance.now() - t0);
        requestAnimationFrame(this.pump);
        return;
      }
      if (frame) {
        // кадр уходит в воркер без копирования: уменьшение и чтение пикселей там (на главном потоке ~0,1 мс вместо 4–17)
        const msg = base(new ArrayBuffer(0));
        msg.frame = frame;
        msg.crop = crop; // фрагмент вырежет воркер из того же кадра
        this.worker.postMessage(msg, [frame as unknown as Transferable]);
      } else {
        this.ctx.drawImage(v, 0, 0, this.dw, this.dh);
        const img = this.ctx.getImageData(0, 0, this.dw, this.dh);
        const msg = base(img.data.buffer as ArrayBuffer);
        const tr: Transferable[] = [msg.rgba];
        if (crop) {
          // тот же кадр видео (рисуем подряд в одном обработчике) — углы из кадра детектора ложатся на фрагмент
          const k = (v.videoWidth || this.dw) / this.dw;
          if (this.cropCanvas.width !== crop.cw || this.cropCanvas.height !== crop.ch) {
            this.cropCanvas.width = crop.cw;
            this.cropCanvas.height = crop.ch;
          }
          this.cropCtx.drawImage(v, crop.x0 * k, crop.y0 * k, crop.w * k, crop.h * k, 0, 0, crop.cw, crop.ch);
          crop.rgba = this.cropCtx.getImageData(0, 0, crop.cw, crop.ch).data.buffer as ArrayBuffer;
          tr.push(crop.rgba);
          msg.crop = crop;
        }
        this.worker.postMessage(msg, tr);
      }
      perf.add('tracker.grab', performance.now() - t0);
    }
    requestAnimationFrame(this.pump);
  };

  /**
   * Фрагмент кадра вокруг карты (по прошлому положению) в разрешении камеры: карта в нём ≈ 280 px шириной —
   * чип и знак Сбера видны лучше, чем на 320-px кадре детектора. До посадки — к каждому кадру (не чаще 12 Гц),
   * после — раз в секунду (переверификация). Без карты в прошлом кадре — не нужен.
   */
  private cropRect(v: HTMLVideoElement): CardWorkerIn['crop'] {
    if (!this.verify) return null;
    const now = performance.now();
    const st = this.session.state;
    if (st === 'hold' || st === 'relocalize') {
      // кот сидит, карта потеряна: где она теперь — неизвестно (телефон сдвинули) — весь кадр в 1,9 раза крупнее
      // кадра детектора, раз в 200 мс (только пока карта потеряна): воркер узнаёт карту Сбера по знаку среди
      // кандидатов полного поиска (pipeline.ts relocalize)
      if (now - this.cropAt < 200) return null;
      const k = (v.videoWidth || this.dw) / this.dw;
      const s = Math.min(k, FULL_CROP_PX / Math.max(this.dw, this.dh));
      if (s < 1.3) return null;
      this.cropAt = now;
      return { x0: 0, y0: 0, w: this.dw, h: this.dh, cw: Math.round(this.dw * s), ch: Math.round(this.dh * s) };
    }
    if (!this.prevQuad) return null;
    // до посадки знак проверяется только на кадрах полного поиска (через кадр) — фрагмент нужен именно им: раньше
    // фрагмент шёл раз в 80 мс «как получится» и при 20–25 Гц воркера часто доставался кадру потока, а проверка
    // полного поиска шла по 320-px кадру (карта 60 px — знак почти не виден)
    if (!this.isLocked && !this.nextDetect && now - this.cropAt < 300) return null;
    if (now - this.cropAt < (this.isLocked ? 1000 : 40)) return null;
    const vw = v.videoWidth || this.dw;
    const k = vw / this.dw; // px видео на px детектора
    if (k < 1.3) return null; // камера не больше кадра детектора — фрагмент ничего не даст
    const q = this.prevQuad;
    let x0 = Math.min(...q.map((p) => p.x)), x1 = Math.max(...q.map((p) => p.x));
    let y0 = Math.min(...q.map((p) => p.y)), y1 = Math.max(...q.map((p) => p.y));
    const mx = (x1 - x0) * 0.25 + 4, my = (y1 - y0) * 0.25 + 4;
    x0 = Math.max(0, Math.floor(x0 - mx));
    y0 = Math.max(0, Math.floor(y0 - my));
    x1 = Math.min(this.dw, Math.ceil(x1 + mx));
    y1 = Math.min(this.dh, Math.ceil(y1 + my));
    const w = x1 - x0, h = y1 - y0;
    if (w < 8 || h < 8) return null;
    const long = Math.max(quadSide(q, 0), quadSide(q, 1));
    let s = Math.min(k, Math.max(1, 280 / Math.max(1, long)));
    s = Math.min(s, 420 / Math.max(w, h)); // не больше 420 px по стороне: чтение пикселей ~1 мс
    if (s < 1.3) return null;
    this.cropAt = now;
    return { x0, y0, w, h, cw: Math.round(w * s), ch: Math.round(h * s) };
  }

  /** пора ли слать кадр: новый кадр камеры и не чаще потолка (потолок — только при спокойном ведении) */
  private frameDue() {
    const now = performance.now();
    const w = this.hold.angularSpeed;
    // телефон поворачивается (> ~20°/с) или карта едет по экрану — полная частота ещё 1 с
    if (w > 0.35 || this.session.quadSpeed > 0.4 || this.session.state !== 'locked') this.fullUntil = now + 1000;
    const hz = now >= this.fullUntil ? this.maxHz : 0;
    if (hz > 0 && now - this.sentAt < 1000 / hz - 4) return false;
    if (!this.rvfc) return true;
    if (now - this.rvfcAt > 400) {
      // requestVideoFrameCallback так и не заработал — по кадрам экрана, как раньше
      if (this.frameSeq === 0) this.rvfc = false;
      // браузер временно перестал его звать (скрытое/свёрнутое видео) — не реже 20 раз в секунду
      return now - this.sentAt > 50;
    }
    return this.frameSeq !== this.sentSeq;
  }

  private onResult(r: CardWorkerOut) {
    this.busy = false;
    if (r.mode === 'no-frame') {
      // воркер не смог прочитать кадр: VideoFrame → пробуем ImageBitmap, ImageBitmap → главный поток
      if (this.frameGrab) this.frameGrab = false;
      else this.bitmapGrab = false;
      this.debug(`воркер не читает кадр — дальше ${this.bitmapGrab ? 'createImageBitmap' : 'главный поток'}`);
      return;
    }
    const now = performance.now();
    perf.add('tracker.worker', r.ms);
    if (r.stages) {
      // этапы воркера: в ?perf видно, что ест бюджет на телефоне
      perf.add('tracker.pre', r.stages.pre);
      if (r.stages.key) perf.add('tracker.key', r.stages.key);
      if (r.stages.flow) perf.add('tracker.flow', r.stages.flow);
      if (r.stages.detect) perf.add('tracker.detect', r.stages.detect);
      if (r.stages.verify) perf.add('tracker.verify', r.stages.verify);
    }
    perf.count('tracker');
    if (r.luma !== undefined) (trackerLuma.value = r.luma), (trackerLuma.at = now);
    this.stats.ms = r.ms;
    this.stats.score = r.score;
    this.stats.mode = r.mode;
    this.stats.key = r.key ? `z${r.key.zncc.toFixed(2)} i${r.key.inl.toFixed(2)}` : r.why ?? '';
    if (r.ver) {
      this.stats.ver = r.ver.state;
      this.stats.verLine = r.ver.line;
    } else if (!this.verify) this.stats.ver = 'sber';
    this.frames++;
    if (now - this.fpsT > 1000) {
      this.stats.fps = (this.frames * 1000) / (now - this.fpsT || 1);
      this.frames = 0;
      this.fpsT = now;
    }
    const cap = this.sentCap && this.sentCap.id === r.id ? this.sentCap : null;
    const logN = this.session.log.length;
    const st = this.session.onResult(r, cap?.q ?? null, now, this.hold.angularSpeed, cap?.shownAt);
    if (st.reset) {
      // посадили «по форме», а под котом не карта — ищем заново (детектор и проверку — с нуля)
      this.worker?.postMessage({ rgba: new ArrayBuffer(4), w: 1, h: 1, focal: 1, reset: true, lock: false });
      this.overlay.forgetRecent();
      this.catPlaced = false;
    }
    this.prevQuad = st.quad ?? (this.session.fsm.anchored ? this.prevQuad : null);
    if (st.quad) this.quadAt = now;
    this.nextDetect = r.detNext ?? true;
    const state = this.session.state;
    if (st.quad && st.pose) {
      const pose = st.pose;
      const view: CardView = { quad: st.quad.map((p) => this.toScreen(p)) as Quad, pose, project: (x, y) => this.projectModel(pose, x, y) };
      if (state === 'candidate' && !this.catPlaced) this.overlay.candidate(view.quad, st.kind ?? 'checking');
      if (state === 'locked') {
        this.view = view;
        this.overlay.track(view, this.catPlaced);
      }
    } else if (state !== 'locked') this.view = null;
    this.overlay.catPlaced = this.catPlaced;
    this.overlay.quietHints = this.everPlaced;
    this.applyEvents(st, now);
    if (this.verDebug && this.session.log.length !== logN) for (const l of this.session.log.slice(logN)) console.info('[card]', l);
  }

  private applyEvents(st: { found?: boolean; lost?: boolean }, now: number) {
    const state = this.session.state;
    const tracking = state === 'locked';
    if (tracking !== this.isTracking) {
      this.isTracking = tracking;
      if (!tracking) this.overlay.lost();
    }
    if (st.found) {
      this.reanchorAt = -1;
      this.catPlaced = true;
      this.everPlaced = true;
      this.emitFound();
    }
    if (st.lost) {
      this.view = null;
      this.overlay.lost();
      this.emitLost();
    }
    void now;
  }

  /** карта в кадре и проверяется (кандидат) или её видели только что — см. Tracker.cardInView */
  cardInView(): boolean {
    const f = this.session.fsm;
    return f.state === 'candidate' || performance.now() - f.seenAt < CARD_SEEN_MS;
  }

  get isLocked() {
    return this.session.fsm.anchored;
  }

  get anchorValid() {
    return this.session.fsm.anchored;
  }

  /** «Пересадить кота»: забыть карту и посадить заново на ту, что сейчас в кадре */
  reanchor() {
    const now = performance.now();
    this.session.reanchor(now);
    this.prevQuad = null;
    this.reanchorAt = now;
    this.catPlaced = false;
    if (this.isTracking) this.isTracking = false;
    this.overlay.lost();
    this.overlay.forgetRecent();
    this.debug('пересадка по кнопке');
    this.worker?.postMessage({ rgba: new ArrayBuffer(4), w: 1, h: 1, focal: 1, reset: true, lock: false });
  }

  /** px кадра детектора → px экрана (видео растянуто object-fit: cover и отцентровано) */
  private toScreen(p: Pt): Pt {
    return { x: (p.x / this.dw) * this.vw - (this.vw - this.w) / 2, y: (p.y / this.dh) * this.vh - (this.vh - this.h) / 2 };
  }

  private projectModel(pose: Pose, X: number, Y: number): Pt | null {
    const R = pose.R, t = pose.t;
    const x = R[0] * X + R[1] * Y + t[0];
    const y = R[3] * X + R[4] * Y + t[1];
    const z = R[6] * X + R[7] * Y + t[2];
    if (z > -1e-6) return null;
    // камера three: смотрит в −Z, +Y вверх; пиксели детектора: +y вниз
    return this.toScreen({ x: this.K.cx + (this.K.f * x) / -z, y: this.K.cy - (this.K.f * y) / -z });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.overlay.resize(w, h);
    const v = this.video;
    const vidW = v?.videoWidth || 1280, vidH = v?.videoHeight || 720;
    const ratio = vidW / vidH;
    if (ratio > w / h) {
      this.vh = h;
      this.vw = h * ratio;
    } else {
      this.vw = w;
      this.vh = w / ratio;
    }
    // вертикальный угол обзора экрана: фокус детектора в px экрана = f * (vh / dh)
    const fScreen = this.K.f * (this.vh / this.dh);
    this.camera.fov = (2 * Math.atan(h / 2 / fScreen) * 180) / Math.PI;
    this.camera.near = 0.01;
    this.camera.far = 1000;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setSmoothing() {
    // сглаживание карты — в мире гироскопа (session.ts), внешние параметры не нужны
  }

  update(dt: number, _t: number) {
    const now = performance.now();
    const st = this.session.tick(now);
    if (st.lost) this.debug(this.session.log.at(-1) ?? 'lost');
    this.applyEvents(st, now);
    if (this.reanchorAt > 0 && now - this.reanchorAt > REANCHOR_LOST_MS && this.session.state !== 'locked') {
      // пересадили, а карты Сбера так и нет — кот спросит, где карта. Но не когда карта в кадре и её проверяют
      // (кандидат, видели меньше 2,5 с назад): «Ой, карточка пропала» звучало через 6 с после «На карту», пока
      // проверка знака ещё шла, а карта лежала в кадре (запись 20.11, 12:37:25)
      if (this.cardInView()) this.reanchorAt = now - REANCHOR_LOST_MS + CARD_SEEN_MS;
      else {
        this.reanchorAt = -1;
        this.emitLost();
      }
    }
    // кот — в позе на момент съёмки кадра, который сейчас на экране (session.ts DISPLAY_AT_FRAME)
    const m = this.session.display(dt, this.rvfc && now - this.shownAt < 100 ? this.shownAt : now, this.hold.quaternion);
    if (m) {
      this.anchor.matrix.copy(m);
      this.anchor.matrixWorldNeedsUpdate = true;
    }
    this.nearCheck(m, dt, now);
    // прогресс посадки и подсказка (с гистерезисом в fsm.ts)
    const f = this.session.fsm;
    const k = f.animate(dt);
    this.overlay.guide(f.state, k, f.hint);
    this.stats.state = f.state;
    this.stats.hint = f.hint ?? '';
    this.stats.progress = k;
    if (this.verDebug) {
      const g = this.session.gyroSamples ? ` · гиро ${this.session.gyroOk ? 'ок' : 'ВЫКЛ'} ${this.session.gyroScore.toFixed(2)}` : this.hold.available ? '' : ' · гиро нет';
      this.overlay.debugLine = `${f.state} ${(k * 100).toFixed(0)}% ${f.hint ?? ''} · ${this.stats.mode} ${this.stats.key} ${this.stats.fps.toFixed(0)}Гц ${this.stats.ms.toFixed(0)}мс${g} · ${this.stats.verLine} · ${this.session.log.at(-1) ?? ''}`;
    }
    this.overlay.update(dt);
  }

  /**
   * Телефон вплотную к карте (5–10 см): кот ростом 1,1 ширины карты на таком расстоянии больше экрана — обрезан и
   * «огромный» (запись 20.11, 12:35:30). Рост кота ограничиваем так, чтобы он занимал не больше NEAR_FRAC высоты
   * экрана (кот уменьшается на месте, на карте; раскраска карты — нет), и тихо просим отодвинуть телефон
   * (не чаще раза в 20 с). Ближняя плоскость камеры (1 мм) тут ни при чём — кот просто больше кадра.
   */
  private nearCheck(m: THREE.Matrix4 | null, dt: number, now: number) {
    let want = 1;
    const tanH = Math.tan(((this.camera.fov || 60) * Math.PI) / 360);
    const dMin = CAT_HEIGHT_W / (NEAR_FRAC * 2 * tanH);
    let d = Infinity;
    if (m) {
      const e = m.elements;
      d = Math.hypot(e[12], e[13], e[14]);
      want = Math.max(0.3, Math.min(1, d / dMin));
    }
    this.catScale += (want - this.catScale) * (1 - Math.exp(-Math.max(0, dt) / 0.15));
    if (Math.abs(this.catScale - want) < 0.002) this.catScale = want;
    this.anchor.userData.catScale = this.catScale;
    const near = !!m && this.session.state === 'locked' && d < dMin * 0.8;
    if (!near) this.nearSince = -1;
    else if (this.nearSince < 0) this.nearSince = now;
    else if (now - this.nearSince > 900 && now - this.nearHintAt > 20000) {
      this.nearHintAt = now;
      this.overlay.nearHint();
    }
  }

  private debug(s: string) {
    if (this.verDebug) console.info('[card]', s);
  }
}

function numParam(name: string, def: number): number {
  const v = typeof location !== 'undefined' ? parseFloat(new URLSearchParams(location.search).get(name) ?? '') : NaN;
  return Number.isFinite(v) ? v : def;
}

function hasParam(name: string): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has(name);
}

/** длина стороны i → i+1 четырёхугольника */
function quadSide(q: Quad, i: number) {
  const a = q[i], b = q[(i + 1) % 4];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function useFrameGrab(): boolean {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('grab') : null;
  if (q === 'main' || q === 'bitmap') return false;
  if (typeof VideoFrame === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  if (q === 'frame') return true;
  // WebKit (iPhone): поворот кадра камеры в VideoFrame не проверен на устройствах — оставляем проверенный путь
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return !/AppleWebKit/.test(ua) || /Chrome\/|Android/.test(ua);
}

function useBitmapGrab(): boolean {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return false;
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('grab') : null;
  if (q === 'bitmap') return true;
  if (q === 'main' || q === 'frame') return false;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const iosLike = /AppleWebKit/.test(ua) && !/Chrome\/|Android/.test(ua);
  return !iosLike;
}

function grabFrame(v: HTMLVideoElement): VideoFrame | null {
  try {
    return new VideoFrame(v);
  } catch {
    return null;
  }
}

const FOCAL_KEY = 'ar.focal.v1';
/** угол обзора камеры iPhone по длинной стороне, градусы (без сохранённой калибровки) */
export const IOS_HFOV = 70;
function isIOS() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
}
/** оценка задержки камеры этого телефона, мс (session.ts LatencyEstimator) */
const LAT_KEY = 'ar.camlat.v1';
/** фрагмент «весь кадр» при потере карты: длинная сторона, px */
const FULL_CROP_PX = 600;
/** после «Пересадить»/«На карту» без карты столько — кот спрашивает, где карта, мс (было 6 с) */
const REANCHOR_LOST_MS = 8000;
/** карту видели так недавно (мс) — она «в кадре», хоть кандидат и мигнул */
const CARD_SEEN_MS = 2500;
/** рост кота в ширинах карты (config.ts stage.height) и наибольшая доля высоты экрана, которую он занимает на карте */
const CAT_HEIGHT_W = 1.1;
const NEAR_FRAC = 0.62;

/** поза (R — столбцы осей карты в системе камеры, t — центр, единица = ширина карты) → матрица якоря */
export function poseMatrix(p: Pose): THREE.Matrix4 {
  const R = p.R, t = p.t;
  return new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
}
