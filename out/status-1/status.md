# Состояние swe · 2026-11-22T11:06:34.184Z

- ОС: Ubuntu 26.04 LTS · Linux 7.0.0-42-generic · up 1 week, 6 days, 21 hours, 19 minutes
- node v22.22.1 · npm 9.2.0 · git version 2.53.0 · caddy 2.6.2 · ar-auto 6fd4f653f5fa0aac55d0be5512fc86895bd169b6
- релиз: /srv/ar/releases/7b9e92f

## Сервисы

- caddy: **active**
- ar-progress: **active**
- ar-update: **inactive**
- ar-auto.timer: **active**

## Диски

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda2        69G   38G   29G  57% /
```

## Память

```
total        used        free      shared  buff/cache   available
Mem:            7936        5148         451          76        2717        2787
Swap:              0           0           0
```

## Манифесты

- Meshy: в манифесте 109, glb 109 (8892 КБ)
- Голос (/srv/ar-extra/voice-el): в манифесте 2102, mp3 2102
- Предметы: glb 8

## URL (curl -I)

- `/`: HTTP/2 200 · content-encoding: zstd · content-type: text/html; charset=utf-8 · etag: "towh4b160" · last-modified: Sun, 22 Nov 2026 10:57:47 GMT · content-length: 13
- `/mvp/`: HTTP/2 200 · cache-control: no-cache · content-encoding: zstd · content-type: text/html; charset=utf-8 · etag: "towh4dj7y" · last-modified: Sun, 22 Nov 2026 10:57:49 GMT · content-length: 13
- `/lab/`: HTTP/2 200 · cache-control: no-cache · content-encoding: zstd · content-type: text/html; charset=utf-8 · etag: "towh4cj7w" · last-modified: Sun, 22 Nov 2026 10:57:48 GMT · content-length: 13
- `/api/progress/health`: HTTP/2 200 · cache-control: no-store · content-type: application/json; charset=utf-8
- `/models/anims/meshy/manifest.json`: HTTP/2 200 · cache-control: public, max-age=31536000, immutable · content-encoding: zstd · content-type: application/json · etag: "towh4e1p3h" · last-modified: Sun, 22 Nov 2026 10:57:50 GMT · content-length: 13

## /srv/ar/update.log (хвост)

```
dist/mvp/assets/rolldown-runtime-XKyaHtl9.js         0.72 kB │ gzip:     0.42 kB
dist/mvp/assets/config-D8VZ3eRf.js                   0.92 kB │ gzip:     0.54 kB
dist/mvp/assets/noCardTracker-Dh0UW25Y.js            1.32 kB │ gzip:     0.70 kB
dist/mvp/assets/webxrTracker-9JxPH4WV.js             2.41 kB │ gzip:     1.14 kB
dist/mvp/assets/eighthWallTracker-BY4-mIzH.js        2.90 kB │ gzip:     1.36 kB
dist/mvp/assets/debugTab-DJhAUtOp.js                 2.95 kB │ gzip:     1.61 kB
dist/mvp/assets/face-wWMbcxTE.js                     3.97 kB │ gzip:     1.58 kB
dist/mvp/assets/base-HfGn7rJY.js                     4.62 kB │ gzip:     1.76 kB
dist/mvp/assets/BufferGeometryUtils-nY6kvbis.js      5.24 kB │ gzip:     1.46 kB
dist/mvp/assets/DRACOLoader-pWOiwNWe.js              7.40 kB │ gzip:     3.00 kB
dist/mvp/assets/meshyClips-CWHtmLAO.js               8.01 kB │ gzip:     3.55 kB
dist/mvp/assets/furShell-DGkFciGx.js                 8.62 kB │ gzip:     4.12 kB
dist/mvp/assets/edition-DwLnH0yl.js                 13.49 kB │ gzip:     5.78 kB
dist/mvp/assets/debugPanel-Dt92MBW5.js              18.62 kB │ gzip:     7.68 kB
dist/mvp/assets/deskPanel-CmjHLgGY.js               18.62 kB │ gzip:     7.26 kB
dist/mvp/assets/room-BP7xgwYZ.js                    24.69 kB │ gzip:     9.83 kB
dist/mvp/assets/events-Cj2bHodv.js                  36.98 kB │ gzip:     8.11 kB
dist/mvp/assets/face-CNCdv39J.js                    39.30 kB │ gzip:     9.32 kB
dist/mvp/assets/cardTracker-rQpLolGD.js             58.16 kB │ gzip:    21.07 kB
dist/mvp/assets/kind-BHAeV174.js                    74.25 kB │ gzip:    16.76 kB
dist/mvp/assets/glitter-DHzFQHel.js                 76.08 kB │ gzip:    17.06 kB
dist/mvp/assets/hooligan-B-BT9_gG.js                76.57 kB │ gzip:    17.66 kB
dist/mvp/assets/gltfLoad-BVLF-klC.js               131.80 kB │ gzip:    45.36 kB
dist/mvp/assets/glbCharacter-CPGGsHVa.js           165.80 kB │ gzip:    58.61 kB
dist/mvp/assets/three.core-DUnZEIUO.js             248.66 kB │ gzip:    66.09 kB
dist/mvp/assets/main-DL0PJ72s.js                 1,039.75 kB │ gzip:   312.04 kB
dist/mvp/assets/mindar-image.prod-DBKMfhLn.js    1,049.31 kB │ gzip:   277.77 kB
dist/mvp/assets/vosk-IoZQXIoN.js                 5,785.96 kB │ gzip: 2,384.46 kB

[33m[INEFFECTIVE_DYNAMIC_IMPORT] [0mcontent/intents.ru.json is dynamically imported by src/persona/content.ts but also statically imported by src/voice/intents.ts, dynamic import will not move module into another chunk.

[33m[INEFFECTIVE_DYNAMIC_IMPORT] [0mcontent/dialogs.json is dynamically imported by src/persona/content.ts but also statically imported by src/voice/intents.ts, dynamic import will not move module into another chunk.

[33m[INEFFECTIVE_DYNAMIC_IMPORT] [0mcontent/names.ru.txt?raw is dynamically imported by src/persona/content.ts but also statically imported by src/voice/intents.ts, dynamic import will not move module into another chunk.

✓ built in 903ms
editions: готово за 4.2 с (mvp 2.0 с, lab 1.2 с, pilot 1.0 с)
attach-extra: 3037 файлов, 81.1 МБ из /srv/ar-extra
rm: cannot remove '/srv/ar/releases/eeeb186/gift/nikita_2.mp3': Permission denied
rm: cannot remove '/srv/ar/releases/eeeb186/gift/nikita_1.mp3': Permission denied

```
