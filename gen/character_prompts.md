# Промпты для генерации образов и модели

Порядок: **база кота → три наряда → лист эмоций → 3D в Tripo → кости → Blender**. Генерируем в Google AI Studio (Gemini, картинки) с референсами СберКота из `refs/` (`sbercat_1_jacket.png`, `sbercat_2_rugby.png`, `sbercat_3_pajama_coin.png`, `sbercat_4_safe.png`). К каждому промпту прикладываем 2–3 референса и пишем «same character as reference».

## 1. База — паспорт (не меняется ни в одном образе)

```
BASE: 3D animated feature-film style young adult cat character, the identical twin of the cat in the reference images.
Same age (about 18 in human terms), same body and head: head ≈ 38–40% of total height and wider than the body,
fluffy cheeks, compact plush body, short fluffy tail, long white whiskers.
Fur: blue-grey with lavender tint, no stripes, no patterns. White muzzle, chin and chest. Pink nose and inner ears.
Eyes: GREEN with a thin black outline, pupil slightly larger than half of the eye. 4 fingers per paw, no visible claws.
Soft studio lighting, detailed fur, clean neutral light-grey background.
```

Запрещено (добавлять в конец каждого промпта):
```
NOT a kitten, NOT a baby, no stripes, no tabby pattern, no amber or yellow eyes, no human hair, no extra fingers,
no text, no watermark, no logo other than the round green Sber patch on the left chest.
```

## 2. Лист разворота для 3D (главное для Tripo)

Для каждого образа — отдельная генерация:
```
{BASE} {OUTFIT}. Character turnaround sheet for 3D modeling: front view, left side view, back view, 3/4 view,
full body, A-pose (arms 45° down, legs slightly apart), neutral relaxed face, mouth closed,
same scale on all views, orthographic look, evenly lit, no shadows on the floor, plain light-grey background.
```

### Наряды (OUTFIT)

**Хулиган:**
```
OUTFIT: black oversized hoodie with lime-green trim and a small round green Sber patch embroidered on the left chest
(viewer's right), lime cap worn backwards between the ears, turquoise headphones resting on the neck, black sneakers.
Pink bubble gum is a separate prop, not in this sheet.
```
**Добряк:**
```
OUTFIT: soft milky-cream hoodie with mint trim and a small round green Sber patch embroidered on the left chest,
chunky knitted peach scarf, cozy knitted sock-slippers. Calm gentle expression.
```
**Блёстка (сестра-близняшка, девочка того же возраста):**
```
OUTFIT: lavender hoodie with mint and gold accents and a small round green Sber patch embroidered on the left chest,
star-shaped bow between the ears, short tulle skirt over the hoodie, small star hair clips, subtle glitter on the tail tip.
Slightly longer eyelashes; same head, body and age as the brother.
```

Проверка картинки перед 3D: глаза зелёные, нет полос, голова шире тела, нашивка на левой груди кота, все виды — один и тот же персонаж и масштаб.

## 3. Лист эмоций (для блендшейпов и спрайтов)

```
{BASE} {OUTFIT}. Expression sheet, head and shoulders, 12 expressions in a 4×3 grid, same angle (front 3/4):
neutral, happy, big smile, smirk, wink, surprised, annoyed, shy with blush, sad, purring with half-closed eyes,
dizzy with spiral eyes, sleeping. Plain light-grey background, consistent lighting.
```
Плюс отдельный лист рта для липсинка:
```
{BASE}. Mouth shapes sheet for lip sync, front view head only, 6 panels: closed (M/B/P), slightly open (E),
wide open (A), round (O), small round (U), rest. Same head in every panel.
```

## 4. Позы для спрайтового режима (если 3D задерживается)

Одна генерация = одна поза, кадр 1024×1024, кот целиком, по центру, светло-серый фон (вырезаем rembg):
`idle`, `talk`, `laugh`, `knock_glass` (лапа к зрителю, костяшки вперёд), `press_glass` (нос и лапы прижаты к стеклу),
`wave`, `point_button` (лапа вниз), `listen` (ухо к зрителю), `jump` (в воздухе), `sit`, `sleep`, `shy`, `offended`,
плюс фирменные: Хулиган `gum_blow`, Добряк `kind_bubbles` и `breath_draw`, Блёстка `glitter_throw` и `idle_glitter_twirl`.

## 5. Tripo (картинка → 3D → кости)

- Вход: лист разворота (front + side + back как multi-view). Режим «Multi-view to 3D».
- Топология: Smart Mesh / low-poly, цель ≤ 20 000 треугольников на всё вместе с одеждой.
- Текстура: PBR, 2K, без запечённых теней.
- Кости: Auto-rig → Humanoid (биped). Проверить, что хвост и уши отделены — если нет, добиваем костями в Blender.
- Экспорт: GLB. Сначала базовый кот без одежды (или в Хулигане), одежда остальных — отдельными генерациями,
  потом в Blender садим на один скелет (см. `docs/CHARACTER_SPEC.md`).

## 6. Видео-клипы (Veo в AI Studio), если идём спрайтами

Для каждого клипа из `gen/animations.csv` с приоритетом P0:
```
{BASE} {OUTFIT}. {описание клипа из notes}. Full body, locked camera, centered, plain chroma-green background (#00FF00),
3–4 seconds, smooth loopable motion where loop=1, no camera movement, no other objects.
```
Дальше — `chroma.sh` из twins_pack: HEVC с альфой для Safari, VP9 для Chrome.
