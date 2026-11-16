# Лицо кота: настоящий рот, веки, румянец

Модели Tripo — с нарисованным лицом без геометрии. Риг строится скриптами Blender (headless, `bl/bin/python` — `pip install bpy`):

```
bl/bin/python scripts/models/blender/face_photo.py -- /tmp/<n>_full.glb facew/<n>.npz      # фронтальный «снимок» головы
python3 scripts/models/blender/face_detect.py facew/<n>.npz facew/<n>.json facew/<n>_viz.png  # нос, глаза, линия рта (проверить viz)
bl/bin/python scripts/models/blender/face_rig.py -- /tmp/<n>_full.glb facew/<n>.json facew/<n>_face.glb /tmp/fr_<n>  # риг + превью
python3 scripts/models/glb_textures.py facew/<n>_face.glb public/models/<n>_v1.glb
```
(`/tmp/<n>_full.glb` — модель с хвостом и ушами, docs/RIG.md.)

Что получается (все накладки повторяют поверхность головы и висят на кости Head):
- **Mouth** — полость рта: тёмная, язык снизу, полоска зубов. В покое сжата в нарисованную линию рта (не видна). Ключи: mouth_A/E/O/U/M (липсинк), tongue_out, smile, smirk. Полость прилегает к лицу *с уже опущенной челюстью* для своего ключа — не прячется под мордой.
- **Основной меш**: челюсть опускается вместе со ртом (mouth_*), уголки рта вверх (smile), щёки надуваются (cheeks_gum).
- **EyeLids** — веки цвета меха (цвет берётся с текстуры над глазом, sRGB → линейный) с линией ресниц: blink_L/R, wink_L/R, eyes_squint.
- **Blush** — румянец на щеках (blush).

Имена ключей — content/face.json morphTargets; пресеты эмоций, моргание и липсинк уже их двигают (glbCharacter). Нет: брови (на моделях их не нарисовано), eyes_wide, eyes_spiral.
Ограничения: у Блёстки длинные нарисованные ресницы выглядывают над закрытым веком; рот «О» узковат.
