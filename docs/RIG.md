# Скелет кота: хвост и уши

Tripo делает гуманоидный скелет Mixamo (65 костей) — без хвоста и ушей. Достраиваем в Blender (headless, `pip install bpy`, Python 3.11):

```
python3.11 -m venv bl && bl/bin/pip install bpy scipy numpy
# 1) вершины, рёбра, цвет текстуры, кости → /tmp/<n>.npz
bl/bin/python scripts/models/blender/dump.py -- models/<n>_rig.glb /tmp/<n>.npz
# 2) поиск хвоста (узкое позади спины, ниже корня — юбка, не берём) и ушей (вверх от макушки) → /tmp/<n>_parts.npz
python3 scripts/models/blender/find_parts.py <n>
python3 scripts/models/blender/viz_parts.py          # /tmp/parts.png — проверка глазами (красный хвост, синие уши)
# 3) кости Tail1..Tail4 (от mixamorig:Hips) и LeftEar1/RightEar1 (от mixamorig:Head), веса, экспорт
TA=12 bl/bin/python scripts/models/blender/rig_cat.py -- models/<n>_rig.glb /tmp/<n>_parts.npz /tmp/<n>_full.glb /tmp/rt_<n>
# 4) текстуры → JPEG ≤1536 px
python3 scripts/models/glb_textures.py /tmp/<n>_full.glb public/models/<n>_v1.glb
```

Веса хвоста: по геодезическому расстоянию от корня, линейная смесь соседних сегментов, у корня плавно в таз (12 % длины).
Уши: от основания к кончику, остальное — голова. Поза покоя костей Mixamo после Blender совпадает с исходной (проверено: 0 расхождений из 65) — библиотека движений `anims_v1.glb` играет как раньше.

## Движение хвоста и ушей — `src/character/tailRig.ts`

Клипы Mixamo хвост и уши не двигают, поэтому поверх любого клипа работает TailRig:

| режим | когда | что делает |
|---|---|---|
| idle | покой | медленно водит, блуждает, Хулиган щёлкает кончиком |
| wag | радость, смех, прыжки, `tail_wag` | машет, волна к кончику |
| puff | испуг, `tail_puff` | трубой вверх, дрожит, уши торчком |
| sad | грусть, плач, падение | опущен, уши вниз |
| angry | обида, раздражение | хлещет, уши прижаты |
| curious | слушает, думает | кончик крючком, уши поворачиваются |
| walk / run | ходьба, бег | качается в шаг, на бегу вытянут |
| dance | танцы, праздник, песня | широкий взмах в такт |
| sleep | сон | обёрнут, едва шевелится |
| purr | гладят | поднят, мелко дрожит |
| whip | ткнули в хвост, вздрогнул | резкий взмах вверх |

Характер задаёт манеру: Хулиган — ленивый со щелчками кончиком, Добряк — плавный и широкий, Блёстка — пружинит и машет чаще.
Каждый канал — пружина (кончик мягче — запаздывает), поворот и прыжок тела отбрасывают хвост по инерции.
Уши: уровень из пресета лица, сами подёргиваются раз в 2,5–7 с, `ear_twitch` / `ears_back`, покачиваются, пока кот говорит.

Просмотр: `npx vite` → `/tools/tail-preview.html?p=glitter&m=dance&yaw=200` (p: hooligan|kind|glitter, m: happy|sad|puff|angry|dance|walk|sleep).
