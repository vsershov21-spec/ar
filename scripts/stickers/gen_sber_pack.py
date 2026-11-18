#!/usr/bin/env python3
"""
Пак наклеек «СберКот» (public/stickers/sber/*.svg + manifest.json).

Единый стиль: фирменная палитра Сбера (зелёный #21A038, градиент бирюза → зелёный → лайм #B5E36A),
мягкие формы, белая «вырубка» вокруг рисунка (как у настоящего стикера) с тонкой серой кромкой, блик.
Официальных логотипов сервисов и знака Сбера нет — только стилизация и цвета.
Слова переведены в контуры (Inter Display Black, OFL) — на телефоне не зависят от шрифтов системы.

Запуск: python3 scripts/stickers/gen_sber_pack.py
"""
import json
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'stickers', 'sber')
FONT = os.environ.get('STICKER_FONT', '/usr/share/fonts/opentype/inter/InterDisplay-Black.otf')

# ───────── палитра ─────────
G = '#21A038'      # фирменный зелёный
GD = '#107F35'     # тёмный зелёный (тени, контуры)
GDD = '#0B4F27'    # глаза, глубокие тени
T = '#1DB5C6'      # бирюза
L = '#B5E36A'      # лайм
LL = '#E4F7C9'     # светлый лайм
GOLD = '#FFD45A'
GOLD2 = '#F2A900'
PINK = '#FF8FB8'
GRAPH = '#22303A'
EDGE = '#D5E4DC'   # серая кромка вырубки

DEFS = f'''<linearGradient id="sb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{T}"/><stop offset=".55" stop-color="{G}"/><stop offset="1" stop-color="{L}"/></linearGradient>
<linearGradient id="sbv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{L}"/><stop offset=".5" stop-color="{G}"/><stop offset="1" stop-color="{T}"/></linearGradient>
<linearGradient id="lime" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D8F59E"/><stop offset="1" stop-color="{L}"/></linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE98F"/><stop offset="1" stop-color="{GOLD2}"/></linearGradient>
<linearGradient id="holo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C9B6F2"/><stop offset=".35" stop-color="#FF9FD0"/><stop offset=".7" stop-color="#FFE08A"/><stop offset="1" stop-color="#9FF0D6"/></linearGradient>
<linearGradient id="pink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC0DA"/><stop offset="1" stop-color="#FF6FA8"/></linearGradient>
<linearGradient id="peach" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD0A3"/><stop offset="1" stop-color="#F58A55"/></linearGradient>
<linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#DFFBF2"/><stop offset=".6" stop-color="#9FF0D6"/><stop offset="1" stop-color="#C9B6F2"/></linearGradient>
<radialGradient id="bub" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".55" stop-color="#D7F6EE"/><stop offset="1" stop-color="#8FDCCB"/></radialGradient>'''


def paw(cx, cy, k, fill):
    """отпечаток лапки: подушечка + 4 пальчика, k — масштаб (1 ≈ 60 px шириной)"""
    p = [f'<ellipse cx="{cx}" cy="{cy + 8 * k:.1f}" rx="{19 * k:.1f}" ry="{15.5 * k:.1f}" fill="{fill}"/>']
    for dx, dy, r in [(-22, -10, 8), (-8, -22, 8.6), (8, -22, 8.6), (22, -10, 8)]:
        p.append(f'<ellipse cx="{cx + dx * k:.1f}" cy="{cy + dy * k:.1f}" rx="{r * k:.1f}" ry="{r * 1.12 * k:.1f}" fill="{fill}"/>')
    return ''.join(p)


def star(cx, cy, r, inner=0.48, n=5, rot=-90):
    import math
    pts = []
    for i in range(n * 2):
        a = math.radians(rot + i * 180 / n)
        rr = r if i % 2 == 0 else r * inner
        pts.append(f'{cx + math.cos(a) * rr:.1f},{cy + math.sin(a) * rr:.1f}')
    return 'M' + ' L'.join(pts) + ' Z'


def sparkle(cx, cy, r, w=0.22):
    """четырёхлучевая искра с вогнутыми сторонами"""
    q = r * w
    return (f'M{cx},{cy - r} Q{cx + q},{cy - q} {cx + r},{cy} Q{cx + q},{cy + q} {cx},{cy + r} '
            f'Q{cx - q},{cy + q} {cx - r},{cy} Q{cx - q},{cy - q} {cx},{cy - r} Z')


# ───────── текст → контуры ─────────
_font = TTFont(FONT)
_gs = _font.getGlyphSet()
_cmap = _font.getBestCmap()
_upm = _font['head'].unitsPerEm


def text_path(text, cx, cy, max_w, size):
    """контур слова, по центру (cx, cy); кегль уменьшается, если не влезает в max_w"""
    names = [_cmap[ord(c)] for c in text]
    adv = sum(_gs[n].width for n in names) - 40 * (len(names) - 1)
    k = min(size / _upm * 1.36, max_w / adv)
    cap = 1490 * k  # высота прописных Inter ≈ 0,727 em
    pen = SVGPathPen(_gs)
    x = 0
    for n in names:
        tp = TransformPen(pen, (k, 0, 0, -k, cx - adv * k / 2 + x * k, cy + cap / 2))
        _gs[n].draw(tp)
        x += _gs[n].width - 40
    import re
    return re.sub(r'-?\d+\.\d+', lambda m: f'{float(m.group(0)):.1f}'.rstrip('0').rstrip('.'), pen.getCommands())


# ───────── сборка одной наклейки ─────────
def svg(sil, art, cut=16):
    """
    sil — силуэт (фигуры без заливки: им задаётся вырубка), art — рисунок.
    Вырубка: серая кромка + белая подложка шире силуэта на cut/2 с каждой стороны.
    """
    import re
    # силуэт — только геометрия: цвет, прозрачность и обводку задаёт слой вырубки
    sil = re.sub(r' (fill|stroke|opacity)="[^"]*"', '', sil)

    def widen(extra):
        return re.sub(r'stroke-width="([\d.]+)"', lambda m: f'stroke-width="{float(m.group(1)) + extra:g}"', sil)
    edge, white = widen(cut + 3), widen(cut)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
<defs>{DEFS}</defs>
<g fill="{EDGE}" stroke="{EDGE}" stroke-width="{cut + 3}" stroke-linejoin="round" stroke-linecap="round">{edge}</g>
<g fill="#FFFFFF" stroke="#FFFFFF" stroke-width="{cut}" stroke-linejoin="round" stroke-linecap="round">{white}</g>
{art}
</svg>
'''


def gloss(d, op=0.45):
    return f'<path d="{d}" fill="#FFFFFF" opacity="{op}"/>'


STICKERS = []


def add(id, title, theme, personas, sil, art, cut=16, deco=''):
    """deco — мелкие детали у края (искры, конфетти): входят и в рисунок, и в вырубку"""
    STICKERS.append(dict(id=id, title=title, theme=theme, personas=personas, svg=svg(sil + deco, art + deco, cut)))


# ═════════ 1. СберКот ═════════
paw_sil = ('<ellipse cx="120" cy="150" rx="56" ry="47"/><circle cx="62" cy="96" r="25"/><circle cx="98" cy="64" r="27"/>'
           '<circle cx="142" cy="64" r="27"/><circle cx="178" cy="96" r="25"/><path d="M62 96 L98 64 L142 64 L178 96 L160 130 L80 130 Z"/>')
add('cat_paw', 'Лапка СберКота', 'cat', [], paw_sil,
    '<g fill="url(#sb)"><ellipse cx="120" cy="150" rx="56" ry="47"/><circle cx="62" cy="96" r="25"/><circle cx="98" cy="64" r="27"/>'
    '<circle cx="142" cy="64" r="27"/><circle cx="178" cy="96" r="25"/></g>'
    f'<ellipse cx="120" cy="158" rx="30" ry="22" fill="{L}" opacity=".55"/>'
    + gloss('M86 128 Q100 112 124 112 Q104 120 94 136 Z', .55)
    + ''.join(f'<ellipse cx="{x}" cy="{y}" rx="7" ry="5" fill="#fff" opacity=".6" transform="rotate(-30 {x} {y})"/>' for x, y in [(54, 86), (90, 52), (134, 52), (170, 86)]),
    cut=30)

face_sil = '<path d="M34 138 C34 92 44 70 50 30 Q56 22 64 28 L102 62 Q120 56 138 62 L176 28 Q184 22 190 30 C196 70 206 92 206 138 C206 186 168 212 120 212 C72 212 34 186 34 138 Z"/>'
add('cat_face', 'Мордочка СберКота', 'cat', [], face_sil,
    f'<path d="M34 138 C34 92 44 70 50 30 Q56 22 64 28 L102 62 Q120 56 138 62 L176 28 Q184 22 190 30 C196 70 206 92 206 138 C206 186 168 212 120 212 C72 212 34 186 34 138 Z" fill="url(#sb)"/>'
    f'<path d="M58 44 L90 70 Q70 78 62 92 Z" fill="{LL}"/><path d="M182 44 L150 70 Q170 78 178 92 Z" fill="{LL}"/>'
    f'<ellipse cx="120" cy="166" rx="46" ry="30" fill="#fff"/>'
    f'<ellipse cx="86" cy="128" rx="13" ry="16" fill="{GDD}"/><ellipse cx="154" cy="128" rx="13" ry="16" fill="{GDD}"/>'
    '<circle cx="90" cy="122" r="5" fill="#fff"/><circle cx="158" cy="122" r="5" fill="#fff"/><circle cx="82" cy="134" r="2.4" fill="#fff"/><circle cx="150" cy="134" r="2.4" fill="#fff"/>'
    f'<path d="M110 150 Q120 145 130 150 Q127 160 120 162 Q113 160 110 150 Z" fill="{PINK}"/>'
    f'<path d="M102 170 Q111 180 120 168 Q129 180 138 170" fill="none" stroke="{GDD}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
    f'<circle cx="62" cy="160" r="12" fill="{PINK}" opacity=".45"/><circle cx="178" cy="160" r="12" fill="{PINK}" opacity=".45"/>'
    + gloss('M58 106 Q70 78 100 70 Q78 86 70 110 Z', .5))

heart = 'M120 210 C40 156 18 108 40 74 C62 40 104 44 120 78 C136 44 178 40 200 74 C222 108 200 156 120 210 Z'
add('paw_heart', 'Сердечко-лапка', 'cat', ['kind'], f'<path d="{heart}"/>',
    f'<path d="{heart}" fill="url(#sbv)"/>' + paw(120, 128, 1.45, '#fff')
    + gloss('M52 92 Q60 62 92 60 Q70 74 64 104 Z', .55))

# ═════════ 2. Детские темы Сбера ═════════
pig_body = 'M40 142 C40 98 76 74 120 74 C150 74 172 86 186 104 L206 110 Q216 112 216 124 L216 152 Q216 164 206 166 L190 170 C180 192 156 206 128 208 L128 216 Q128 222 120 222 L108 222 Q100 222 100 214 L100 206 Q84 202 72 194 L72 212 Q72 220 64 220 L52 220 Q44 220 44 212 L44 178 Q40 162 40 142 Z'
add('piggy', 'Копилка', 'sber', ['kind'],
    f'<path d="{pig_body}"/><circle cx="120" cy="44" r="24"/><path d="M146 84 L162 52 L178 96 Z"/>',
    f'<circle cx="120" cy="44" r="22" fill="url(#gold)"/><circle cx="120" cy="44" r="15" fill="none" stroke="{GOLD2}" stroke-width="3"/>'
    f'<path d="M114 36 L122 36 L122 54" fill="none" stroke="{GOLD2}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
    f'<path d="{pig_body}" fill="url(#sb)"/><path d="M146 84 L162 52 L178 96 Z" fill="{G}" stroke="{G}" stroke-width="6" stroke-linejoin="round"/>'
    f'<path d="M154 80 L162 64 L170 90 Z" fill="{L}"/>'
    f'<rect x="96" y="80" width="48" height="9" rx="4.5" fill="{GDD}"/>'
    f'<ellipse cx="204" cy="138" rx="14" ry="22" fill="{L}"/><ellipse cx="200" cy="130" rx="3.5" ry="5" fill="{GD}"/><ellipse cx="200" cy="146" rx="3.5" ry="5" fill="{GD}"/>'
    f'<circle cx="172" cy="120" r="7" fill="{GDD}"/><circle cx="174" cy="117" r="2.5" fill="#fff"/>'
    f'<circle cx="168" cy="150" r="10" fill="{PINK}" opacity=".45"/>'
    f'<path d="M40 130 Q22 126 26 112 Q30 102 38 110" fill="none" stroke="{G}" stroke-width="6" stroke-linecap="round"/>'
    + gloss('M60 120 Q72 92 106 86 Q80 104 72 128 Z', .5))

add('coin', 'Монетка', 'sber', [],
    '<circle cx="120" cy="126" r="84"/>',
    f'<circle cx="120" cy="134" r="80" fill="#D08E00"/><circle cx="120" cy="124" r="80" fill="url(#gold)"/>'
    f'<circle cx="120" cy="124" r="62" fill="none" stroke="{GOLD2}" stroke-width="6" stroke-dasharray="2 10" stroke-linecap="round"/>'
    f'<circle cx="120" cy="124" r="50" fill="#FFE27A"/>' + paw(120, 126, 1.25, '#E09A00')
    + gloss('M58 96 Q70 60 108 52 Q80 72 70 104 Z', .6),
    deco=f'<path d="{sparkle(186, 52, 18)}" fill="{GOLD}"/>')

card_sil = '<rect x="26" y="70" width="188" height="124" rx="22"/><path d="M40 76 L56 34 Q60 28 66 32 L100 72 Z"/><path d="M200 76 L184 34 Q180 28 174 32 L140 72 Z"/>'
add('card_cat', 'Карта-котик', 'sber', ['glitter'], card_sil,
    f'<g fill="url(#sb)"><path d="M40 76 L56 34 Q60 28 66 32 L100 72 Z"/><path d="M200 76 L184 34 Q180 28 174 32 L140 72 Z"/></g>'
    f'<path d="M56 64 L62 44 L80 66 Z" fill="{LL}"/><path d="M184 64 L178 44 L160 66 Z" fill="{LL}"/>'
    '<rect x="26" y="70" width="188" height="124" rx="22" fill="url(#sb)"/>'
    f'<rect x="46" y="98" width="38" height="30" rx="7" fill="url(#gold)"/><path d="M46 113 H84 M65 98 V128" stroke="{GOLD2}" stroke-width="2.5"/>'
    f'<ellipse cx="150" cy="112" rx="8" ry="10" fill="{GDD}"/><ellipse cx="184" cy="112" rx="8" ry="10" fill="{GDD}"/>'
    '<circle cx="152" cy="108" r="3" fill="#fff"/><circle cx="186" cy="108" r="3" fill="#fff"/>'
    f'<path d="M162 128 Q167 134 172 128" fill="none" stroke="{GDD}" stroke-width="4" stroke-linecap="round"/>'
    + ''.join(f'<circle cx="{50 + i * 13 + (i // 4) * 10}" cy="166" r="4.2" fill="#fff" opacity=".9"/>' for i in range(8))
    + gloss('M26 120 Q30 80 70 72 L118 72 Q60 84 40 132 Z', .3))

add('bonus_star', 'Звёздочка-бонус', 'sber', [],
    '<circle cx="120" cy="120" r="88"/>',
    f'<circle cx="120" cy="120" r="88" fill="url(#sb)"/><circle cx="120" cy="120" r="74" fill="none" stroke="{L}" stroke-width="5"/>'
    f'<path d="{star(120, 104, 46)}" fill="#fff" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>'
    f'<path d="{text_path("+10", 120, 172, 74, 34)}" fill="#fff"/>'
    + gloss('M44 100 Q54 54 100 40 Q66 64 58 108 Z', .4),
    deco=f'<path d="{sparkle(192, 48, 16)}" fill="{GOLD}"/>')

# ═════════ 3. Друзья кота (намёки на сервисы экосистемы, без логотипов) ═════════
add('music', 'Музыка в наушниках', 'friends', ['hooligan'],
    '<circle cx="120" cy="124" r="92"/>',
    f'<circle cx="120" cy="124" r="92" fill="{LL}"/>'
    f'<path d="M50 140 C50 82 82 56 120 56 C158 56 190 82 190 140" fill="none" stroke="{GRAPH}" stroke-width="16" stroke-linecap="round"/>'
    f'<rect x="32" y="118" width="44" height="72" rx="20" fill="url(#sbv)"/><rect x="164" y="118" width="44" height="72" rx="20" fill="url(#sbv)"/>'
    f'<rect x="64" y="126" width="16" height="56" rx="8" fill="{GRAPH}"/><rect x="160" y="126" width="16" height="56" rx="8" fill="{GRAPH}"/>'
    f'<path d="M112 92 L148 82 L148 150" fill="none" stroke="{G}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="M112 92 L112 162" stroke="{G}" stroke-width="9" stroke-linecap="round"/>'
    f'<ellipse cx="101" cy="164" rx="15" ry="12" fill="{G}" transform="rotate(-20 101 164)"/><ellipse cx="137" cy="152" rx="15" ry="12" fill="{G}" transform="rotate(-20 137 152)"/>'
    + gloss('M40 120 Q42 132 44 150 L38 150 Q34 132 40 120 Z', .6))

pin = 'M120 150 C94 120 70 100 70 74 A50 50 0 0 1 170 74 C170 100 146 120 120 150 Z'
add('map_pin', 'Пин на маршруте', 'friends', [],
    f'<path d="M30 132 L84 112 L148 132 L210 112 L210 200 L148 220 L84 200 L30 220 Z"/><path d="{pin}"/>',
    '<path d="M30 132 L84 112 L84 200 L30 220 Z" fill="#D6F2DD"/><path d="M84 112 L148 132 L148 220 L84 200 Z" fill="#EAF8D6"/><path d="M148 132 L210 112 L210 200 L148 220 Z" fill="#D6F2DD"/>'
    f'<path d="M46 196 Q76 166 104 182 T164 168 Q186 160 196 140" fill="none" stroke="{G}" stroke-width="6" stroke-dasharray="1 12" stroke-linecap="round"/>'
    f'<circle cx="46" cy="196" r="8" fill="{T}"/>'
    f'<ellipse cx="120" cy="156" rx="18" ry="6" fill="{GD}" opacity=".3"/>'
    f'<path d="{pin}" fill="url(#sb)"/><circle cx="120" cy="74" r="25" fill="#fff"/>' + paw(120, 76, 0.62, G)
    + gloss('M82 64 Q88 36 116 30 Q96 46 92 70 Z', .5))

box_sil = '<path d="M60 94 L120 70 L196 92 L196 182 L132 210 L60 186 Z"/><rect x="14" y="108" width="40" height="12" rx="6"/><rect x="24" y="138" width="30" height="12" rx="6"/><rect x="10" y="168" width="44" height="12" rx="6"/>'
add('parcel', 'Посылка уже мчится', 'friends', [], box_sil,
    f'<g fill="{L}"><rect x="14" y="108" width="40" height="12" rx="6"/><rect x="24" y="138" width="30" height="12" rx="6"/><rect x="10" y="168" width="44" height="12" rx="6"/></g>'
    '<path d="M60 94 L132 118 L132 210 L60 186 Z" fill="#F0B56A"/><path d="M132 118 L196 92 L196 182 L132 210 Z" fill="#D8924A"/><path d="M60 94 L120 70 L196 92 L132 118 Z" fill="#FBD39A"/>'
    f'<path d="M90 82 L162 106 L162 140 L148 146 L148 112 L76 88 Z" fill="url(#sb)"/>'
    f'<path d="M76 136 L116 150 L116 182 L76 168 Z" fill="#fff" opacity=".92"/>' + paw(96, 160, 0.42, G)
    + gloss('M66 104 L78 108 L78 150 L66 146 Z', .35))

add('tv', 'Мультик', 'friends', ['kind'],
    '<rect x="30" y="66" width="180" height="130" rx="34"/><path d="M98 70 L74 30 M142 70 L166 30" stroke="#000" stroke-width="10"/><circle cx="74" cy="30" r="10"/><circle cx="166" cy="30" r="10"/><rect x="62" y="186" width="30" height="24" rx="8"/><rect x="148" y="186" width="30" height="24" rx="8"/>',
    f'<path d="M98 70 L74 30 M142 70 L166 30" stroke="{GRAPH}" stroke-width="8" stroke-linecap="round"/><circle cx="74" cy="30" r="10" fill="{L}"/><circle cx="166" cy="30" r="10" fill="{L}"/>'
    f'<rect x="62" y="186" width="30" height="22" rx="8" fill="{GD}"/><rect x="148" y="186" width="30" height="22" rx="8" fill="{GD}"/>'
    '<rect x="30" y="66" width="180" height="130" rx="34" fill="url(#sb)"/>'
    f'<rect x="48" y="82" width="144" height="98" rx="22" fill="{GDD}"/>'
    f'<path d="M106 106 L146 131 L106 156 Z" fill="{L}" stroke="{L}" stroke-width="10" stroke-linejoin="round"/>'
    f'<path d="{sparkle(170, 100, 9)}" fill="#fff"/><circle cx="70" cy="160" r="4" fill="#fff" opacity=".7"/>'
    + gloss('M58 96 Q62 88 74 86 L120 86 Q76 94 62 134 Z', .22))

rocket = 'M120 22 C156 50 168 104 154 162 L86 162 C72 104 84 50 120 22 Z'
add('rocket', 'Ракета знаний', 'friends', [],
    f'<path d="{rocket}"/><path d="M86 120 L52 160 L56 190 L92 164 Z"/><path d="M154 120 L188 160 L184 190 L148 164 Z"/><path d="M96 162 L144 162 L132 210 Q120 226 108 210 Z"/>',
    f'<path d="M98 164 L142 164 L130 204 Q120 222 110 204 Z" fill="#FF9A3D"/><path d="M108 164 L132 164 L126 192 Q120 204 114 192 Z" fill="{GOLD}"/>'
    f'<path d="M86 120 L52 160 L56 190 L92 164 Z" fill="{L}"/><path d="M154 120 L188 160 L184 190 L148 164 Z" fill="{L}"/>'
    f'<path d="{rocket}" fill="url(#sbv)"/><circle cx="120" cy="92" r="24" fill="#fff"/><circle cx="120" cy="92" r="16" fill="{T}"/>'
    '<circle cx="114" cy="86" r="5" fill="#fff" opacity=".9"/>'
    f'<rect x="106" y="138" width="28" height="7" rx="3.5" fill="{GD}"/>'
    + gloss('M100 60 Q108 40 120 32 Q110 52 106 74 Z', .55),
    deco=f'<path d="{sparkle(60, 70, 14)}" fill="{GOLD}"/><path d="{star(184, 86, 12)}" fill="{GOLD}"/>')

pad = 'M54 92 L186 92 C214 92 226 122 222 158 C218 190 196 198 180 182 L162 164 L78 164 L60 182 C44 198 22 190 18 158 C14 122 26 92 54 92 Z'
add('gamepad', 'Джойстик', 'friends', ['hooligan'], f'<path d="{pad}"/>',
    f'<path d="{pad}" fill="url(#sb)"/>'
    '<path d="M60 114 h14 v14 h14 v14 h-14 v14 h-14 v-14 h-14 v-14 h14 Z" fill="#fff" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>'
    f'<circle cx="170" cy="112" r="10" fill="{GOLD}"/><circle cx="190" cy="132" r="10" fill="{PINK}"/><circle cx="150" cy="132" r="10" fill="{L}"/><circle cx="170" cy="152" r="10" fill="#fff"/>'
    f'<rect x="104" y="122" width="14" height="7" rx="3.5" fill="{GDD}"/><rect x="124" y="122" width="14" height="7" rx="3.5" fill="{GDD}"/>'
    + gloss('M40 112 Q46 98 62 98 L110 98 Q60 104 46 134 Z', .4))

# ═════════ 4. Добрые слова ═════════
def word(id, title, text, fill, back, deco, personas, rot=-6, size=78):
    d = text_path(text, 120, 124, 184, size)
    tr = f'transform="rotate({rot} 120 120)"'
    # буквы — один контур (#w), остальное — <use>: обводка-подложка, тень, заливка
    sil = f'<use href="#w" {tr} stroke-width="26"/>'
    art = (f'<defs><path id="w" d="{d}"/></defs>'
           f'<g {tr}><use href="#w" fill="{back}" stroke="{back}" stroke-width="26" stroke-linejoin="round"/>'
           f'<use href="#w" fill="{GDD}" transform="translate(0 6)" opacity=".35"/>'
           f'<use href="#w" fill="{fill}"/></g>')
    # силуэт вырубки = буквы + толстая обводка (26) → белая кромка снаружи
    add(id, title, 'words', personas, sil, art, cut=16, deco=deco)


word('w_kruto', '«Круто!»', 'Круто!', '#fff', 'url(#sb)', f'<path d="{sparkle(200, 82, 15)}" fill="{GOLD}"/>', ['hooligan'])
word('w_vau', '«Вау!»', 'Вау!', '#7B4FD8', 'url(#holo)', f'<path d="{sparkle(44, 78, 14)}" fill="{GOLD}"/>', ['glitter'], rot=5, size=92)
word('w_mur', '«Мур!»', 'Мур!', '#fff', 'url(#sbv)', f'<path d="{heart}" fill="{PINK}" transform="translate(172 52) scale(.2)"/>', ['kind'], rot=-4, size=92)
word('w_ura', '«Ура!»', 'Ура!', GDD, 'url(#gold)',
     ''.join(f'<rect x="{x}" y="{y}" width="10" height="16" rx="3" fill="{c}" transform="rotate({r} {x} {y})"/>' for x, y, c, r in [(34, 76, G, -20), (196, 70, PINK, 25), (194, 168, T, -15)]),
     [], rot=-8, size=92)

# ═════════ 5. Хулиган ═════════
deck = 'M40 96 L200 96 C222 96 230 110 230 122 C230 134 222 148 200 148 L40 148 C18 148 10 134 10 122 C10 110 18 96 40 96 Z'
add('h_skate', 'Скейт Хулигана', 'hooligan', ['hooligan'],
    f'<g transform="rotate(-22 120 128) translate(120 128) scale(.86) translate(-120 -128)"><path d="{deck}"/><circle cx="62" cy="168" r="17"/><circle cx="178" cy="168" r="17"/></g>',
    f'<g transform="rotate(-22 120 128) translate(120 128) scale(.86) translate(-120 -128)"><rect x="50" y="146" width="24" height="12" rx="4" fill="{GRAPH}"/><rect x="166" y="146" width="24" height="12" rx="4" fill="{GRAPH}"/>'
    f'<circle cx="62" cy="168" r="16" fill="#FF6FB5"/><circle cx="62" cy="168" r="6" fill="#fff"/><circle cx="178" cy="168" r="16" fill="#FF6FB5"/><circle cx="178" cy="168" r="6" fill="#fff"/>'
    f'<path d="{deck}" fill="#161616"/><path d="M28 122 L80 104 L100 136 L150 106 L170 136 L212 116" fill="none" stroke="#B6FF3B" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>'
    f'<path d="M40 104 L200 104" stroke="#fff" stroke-width="3" opacity=".25" stroke-linecap="round"/></g>',
    deco=f'<path d="{sparkle(186, 190, 14)}" fill="#B6FF3B"/>')

gstar = star(116, 106, 84, 0.5, rot=-80)
add('h_graffiti_star', 'Граффити-звёздочка', 'hooligan', ['hooligan'],
    f'<path d="{gstar}"/><rect x="88" y="140" width="14" height="72" rx="7"/><rect x="122" y="150" width="12" height="52" rx="6"/><rect x="146" y="136" width="12" height="64" rx="6"/>',
    f'<g fill="#FF6FB5"><rect x="88" y="140" width="14" height="72" rx="7"/><rect x="122" y="150" width="12" height="52" rx="6"/><rect x="146" y="136" width="12" height="64" rx="6"/><circle cx="95" cy="212" r="9"/><circle cx="152" cy="200" r="8"/></g>'
    f'<path d="{gstar}" fill="#B6FF3B" stroke="#111" stroke-width="9" stroke-linejoin="round"/>'
    f'<path d="{star(116, 108, 40, 0.5, rot=-80)}" fill="#FF6FB5" opacity=".9"/>'
    '<circle cx="104" cy="98" r="7" fill="#111"/><circle cx="132" cy="98" r="7" fill="#111"/><path d="M104 120 Q118 132 132 120" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round"/>'
    , deco=''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#1EE3CF"/>' for x, y, r in [(200, 52, 6), (212, 72, 4), (192, 34, 3.5)]))

# ═════════ 6. Добряк ═════════
add('k_bubbles', 'Пузыри Добряка', 'kind', ['kind'],
    '<circle cx="98" cy="136" r="66"/><circle cx="176" cy="78" r="38"/><circle cx="182" cy="172" r="26"/>',
    ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="url(#bub)" stroke="#8BC6A8" stroke-width="4"/>'
            f'<path d="M{x - r * .62:.0f} {y - r * .1:.0f} A{r * .64:.0f} {r * .64:.0f} 0 0 1 {x - r * .1:.0f} {y - r * .62:.0f}" fill="none" stroke="#fff" stroke-width="{max(4, r * .14):.0f}" stroke-linecap="round"/>'
            f'<circle cx="{x + r * .42:.0f}" cy="{y + r * .38:.0f}" r="{r * .1:.0f}" fill="#FFB3C1" opacity=".8"/>'
            for x, y, r in [(98, 136, 64), (176, 78, 36), (182, 172, 24)]))

add('k_cocoa', 'Какао с зефирками', 'kind', ['kind'],
    '<path d="M48 96 L172 96 L164 192 Q160 212 140 212 L80 212 Q60 212 56 192 Z"/><circle cx="182" cy="142" r="32"/><path d="M84 30 Q100 50 88 74 M120 24 Q136 46 124 72 M152 32 Q166 52 156 76" stroke="#000" stroke-width="14"/>',
    '<path d="M84 34 Q98 52 88 72 M120 28 Q134 48 124 70 M152 36 Q164 54 156 74" fill="none" stroke="#8BC6A8" stroke-width="7" stroke-linecap="round"/>'
    '<circle cx="182" cy="142" r="24" fill="none" stroke="#F58A55" stroke-width="13"/>'
    '<path d="M48 96 L172 96 L164 192 Q160 212 140 212 L80 212 Q60 212 56 192 Z" fill="url(#peach)"/>'
    '<ellipse cx="110" cy="98" rx="62" ry="13" fill="#8A4B2A"/>'
    '<rect x="70" y="80" width="24" height="20" rx="7" fill="#fff" transform="rotate(-14 82 90)"/><rect x="104" y="78" width="24" height="20" rx="7" fill="#FFC6D6" transform="rotate(10 116 88)"/><rect x="134" y="82" width="22" height="18" rx="7" fill="#fff" transform="rotate(-6 145 91)"/>'
    f'<path d="{heart}" fill="#fff" transform="translate(84 124) scale(.22)"/>'
    + gloss('M62 118 L72 118 L78 184 L68 184 Z', .35))

# ═════════ 7. Блёстка ═════════
add('g_sparkles', 'Блёстки', 'glitter', ['glitter'],
    f'<path d="{sparkle(112, 122, 92)}" stroke="#000" stroke-width="8"/><path d="{sparkle(190, 54, 30)}"/><path d="{sparkle(192, 186, 22)}"/>',
    f'<path d="{sparkle(112, 122, 92)}" fill="url(#holo)" stroke="url(#holo)" stroke-width="8" stroke-linejoin="round"/>'
    f'<path d="{sparkle(112, 122, 42)}" fill="#fff" opacity=".85"/>'
    f'<path d="{sparkle(190, 54, 30)}" fill="#FFD36B"/><path d="{sparkle(192, 186, 22)}" fill="#9FF0D6"/>'
    + ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff"/>' for x, y, r in [(60, 70, 4), (160, 104, 3), (78, 180, 3.5)]))

add('g_mirror', 'Зеркальце Блёстки', 'glitter', ['glitter'],
    '<circle cx="120" cy="96" r="76"/><rect x="104" y="160" width="32" height="68" rx="16"/><path d="' + heart + '" transform="translate(96 4) scale(.2)"/>',
    '<rect x="106" y="158" width="28" height="66" rx="14" fill="url(#pink)"/><circle cx="120" cy="214" r="6" fill="#FFD36B"/>'
    '<circle cx="120" cy="96" r="74" fill="url(#gold)"/><circle cx="120" cy="96" r="60" fill="url(#glass)"/>'
    '<path d="M76 100 L114 50 L132 50 L84 116 Z" fill="#fff" opacity=".7"/><path d="M98 132 L148 66 L156 74 L108 140 Z" fill="#fff" opacity=".5"/>'
    f'<path d="{heart}" fill="url(#pink)" transform="translate(96 4) scale(.2)"/>'
    f'<path d="{sparkle(166, 132, 12)}" fill="#fff"/>')

bow = ('M120 112 C96 70 40 50 34 86 C28 120 60 150 112 128 Z', 'M120 112 C144 70 200 50 206 86 C212 120 180 150 128 128 Z')
tails = ('M108 126 L74 198 L96 192 L106 214 L124 132 Z', 'M132 126 L166 198 L144 192 L134 214 L116 132 Z')
add('g_bow', 'Бантик', 'glitter', ['glitter'],
    ''.join(f'<path d="{d}"/>' for d in bow + tails) + '<rect x="100" y="98" width="40" height="40" rx="14"/>',
    ''.join(f'<path d="{d}" fill="#E86AA6"/>' for d in tails)
    + ''.join(f'<path d="{d}" fill="url(#pink)"/>' for d in bow)
    + '<path d="M56 86 Q62 70 82 74 Q66 80 64 96 Z" fill="#fff" opacity=".6"/><path d="M184 86 Q178 70 158 74 Q174 80 176 96 Z" fill="#fff" opacity=".35"/>'
    + ''.join(f'<circle cx="{x}" cy="{y}" r="5" fill="#fff" opacity=".85"/>' for x, y in [(70, 108), (90, 92), (166, 104), (186, 96), (150, 90)])
    + '<rect x="100" y="98" width="40" height="40" rx="14" fill="#C9B6F2"/><rect x="108" y="104" width="10" height="28" rx="5" fill="#fff" opacity=".5"/>',
    deco=f'<path d="{sparkle(196, 168, 14)}" fill="#FFD36B"/>')


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith('.svg'):
            os.remove(os.path.join(OUT, f))
    items = []
    for s in STICKERS:
        with open(os.path.join(OUT, s['id'] + '.svg'), 'w', encoding='utf-8') as fh:
            fh.write(s['svg'])
        items.append({k: s[k] for k in ('id', 'title', 'theme', 'personas')} | {'src': f'stickers/sber/{s["id"]}.svg'})
    manifest = {
        'pack': 'sber',
        'title': 'Наклейки СберКота',
        'note': 'Генерируется scripts/stickers/gen_sber_pack.py. Без логотипов сервисов и знака Сбера: только стилизация и цвета.',
        'themes': {'cat': 'СберКот', 'sber': 'Детские темы Сбера', 'friends': 'Друзья кота', 'words': 'Добрые слова',
                   'hooligan': 'Хулиган', 'kind': 'Добряк', 'glitter': 'Блёстка'},
        'stickers': items,
    }
    # public — для ассетов и внешних потребителей; копия в src — бандлится в код (без fetch до первой наклейки)
    for dst in (os.path.join(OUT, 'manifest.json'), os.path.join(ROOT, 'src', 'fx', 'stickerPack.manifest.json')):
        with open(dst, 'w', encoding='utf-8') as fh:
            json.dump(manifest, fh, ensure_ascii=False, indent=2)
            fh.write('\n')
    total = sum(len(s['svg'].encode()) for s in STICKERS)
    print(f'{len(STICKERS)} наклеек → {OUT} ({total / 1024:.1f} КБ)')


if __name__ == '__main__':
    main()
