#!/usr/bin/env python3
"""Объём меха: оболочки на голове + пряди-карточки по силуэту + тяжёлое веко.

Мех-оболочки на голове: расширяет BD_FurShell (стадия body_detail.py: руки, ноги, хвост) треугольниками меха головы
и картой длины шерсти, без Blender и без пересборки остальных стадий.

  python3 scripts/models/fur_head.py <hooligan|kind|glitter> in.glb out.glb [--debug out.png]

- Мех головы — по цвету альбедо у вершины (голубовато-серый, неяркий: как fur_shell в body_detail), голова — по весам
  костей Head/HeadTop_End/Neck. Кепка, бант, наушники, нос, внутренность ушей, глаза под маску не попадают (другой цвет).
- Длина (_FURLEN, ед. модели): макушка и затылок — база, щёки и бока головы — длиннее (пушистые «баки» как на рефах),
  лоб и морда — короткая, вокруг глаз, носа, рта и бровей → 0 (там 3D-глаза, накладка рта MouthD и брови), край
  меха (кепка, бант, воротник) плавно → 0. Точки лица — из extras.marks узла Brows (стадия face_detail).
- Морфы: оболочки получают ключи тела (те же accessors POSITION, только позиции) — рот, щёки и брови двигают мех вместе
  с мордой. Буферы общие с телом, память почти не растёт (новые только индексы и _FURLEN).
Идемпотентно: длина на голове всегда считается заново, на остальном теле берётся из входного _FURLEN.
"""
import sys
import numpy as np
from glb_io import Glb

HEAD_LEN = {'hooligan': 0.0115, 'kind': 0.0125, 'glitter': 0.011}
# верхнее веко в покое (eyeRig: доля закрытия) — тяжёлое веко рефов: Хулиган «с ленцой», Добряк мягче, Блёстка открытая
REST_UP = {'hooligan': 0.3, 'kind': 0.27, 'glitter': 0.17}
CHEEK_K = {'hooligan': 1.55, 'kind': 1.6, 'glitter': 1.45}


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def main():
    persona, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    dbg = sys.argv[sys.argv.index('--debug') + 1] if '--debug' in sys.argv else None
    g = Glb(src)
    j = g.j
    bi, body = g.main_mesh()
    si = next(i for i, m in enumerate(j['meshes']) if m['name'] == 'BD_FurShell')
    sh = j['meshes'][si]['primitives'][0]
    assert sh['attributes']['POSITION'] == body['attributes']['POSITION'], 'BD_FurShell должен делить буферы с телом'
    P = g.acc(body['attributes']['POSITION']).astype(np.float64)
    N = g.acc(body['attributes']['NORMAL']).astype(np.float64)
    UV = g.acc(body['attributes']['TEXCOORD_0']).astype(np.float64)
    I = g.acc(body['indices']).reshape(-1, 3).astype(np.int64)
    J = g.acc(body['attributes']['JOINTS_0']).astype(np.int64)
    Wt = g.acc(body['attributes']['WEIGHTS_0']).astype(np.float64)
    if Wt.max() > 1.5:
        Wt = Wt / 255.0
    node = next(n for n in j['nodes'] if n.get('mesh') == bi)
    names = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in j['skins'][node['skin']]['joints']]

    def wsum(pred):
        sel = np.array([pred(n) for n in names])
        return (Wt * sel[J]).sum(1)

    headw = wsum(lambda n: n.startswith('Head')) + 0.5 * wsum(lambda n: n == 'Neck')
    old = g.acc(sh['attributes']['_FURLEN']).astype(np.float64)

    # альбедо у вершины (среднее 3×3)
    mat = j['materials'][body['material']]
    tex = j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]
    img = np.asarray(g.image(tex['source']).convert('RGB')).astype(np.float64)
    H, W = img.shape[:2]
    px = np.clip((UV[:, 0] % 1) * W, 1, W - 2).astype(int)
    py = np.clip((UV[:, 1] % 1) * H, 1, H - 2).astype(int)
    c = sum(img[py + dy, px + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
    r, gg, b = c[:, 0], c[:, 1], c[:, 2]
    mx = c.max(1); mn = c.min(1); sat = (mx - mn) / np.maximum(mx, 1)
    furc = (b > r + 8) & (b > gg + 4) & (sat < 0.5) & (mx > 60)

    # сшитые вершины (швы UV) и рёбра
    key = np.round(P * 1e5).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    nW = weld.max() + 1
    E = weld[np.r_[I[:, [0, 1]], I[:, [1, 2]], I[:, [2, 0]]]]

    def to_w(v):
        a = np.zeros(nW); k = np.zeros(nW)
        np.add.at(a, weld, v); np.add.at(k, weld, 1)
        return a / np.maximum(k, 1)

    def smooth(x, it):
        for _ in range(it):
            s_ = np.zeros(nW); k = np.zeros(nW)
            np.add.at(s_, E[:, 0], x[E[:, 1]]); np.add.at(k, E[:, 0], 1)
            np.add.at(s_, E[:, 1], x[E[:, 0]]); np.add.at(k, E[:, 1], 1)
            x = 0.5 * x + 0.5 * s_ / np.maximum(k, 1)
        return x

    def erode(x, it):
        for _ in range(it):
            m = x.copy()
            np.minimum.at(m, E[:, 0], x[E[:, 1]]); np.minimum.at(m, E[:, 1], x[E[:, 0]])
            x = m
        return x

    head = to_w(headw) > 0.55
    fur = (smooth(to_w(furc.astype(np.float64)), 2) > 0.5) & head
    lo = smooth(erode(fur.astype(np.float64), 2), 3)

    # точки лица (стадия face_detail)
    marks = next((n.get('extras', {}).get('marks') for n in j['nodes'] if n.get('name') == 'Brows'), None)
    Pw = to_w(P[:, 0]), to_w(P[:, 1]), to_w(P[:, 2])
    Pw = np.stack(Pw, 1)
    Nw = np.stack([to_w(N[:, k]) for k in range(3)], 1)
    Nw /= np.maximum(np.linalg.norm(Nw, axis=1, keepdims=True), 1e-9)
    k = np.ones(nW)
    R = {'lat': np.zeros(nW), 'low': np.zeros(nW), 'front': np.zeros(nW), 'eye': np.ones(nW), 'ytop': None, 'eyeD': 0.27, 'nose': None}
    if marks:
        A = lambda n: np.array(marks[n], dtype=np.float64)
        eyeD = np.linalg.norm(A('eyeOuterL') - A('eyeOuterR'))
        for s in ('L', 'R'):
            o, i_, bt = A('eyeOuter' + s), A('eyeInner' + s), A('eyeBottom' + s)
            top = marks['eyeTop' + s]
            ctr = np.array([(o[0] + i_[0]) / 2, (bt[1] + top) / 2, (o[2] + i_[2]) / 2])
            rx = np.linalg.norm(o - i_) / 2 * 1.0
            ry = (top - bt[1]) / 2
            q = Pw - ctr
            # эллипс разреза; над глазом (брови) зона выше
            up = np.where(q[:, 1] > 0, 1.0 / 1.9, 1.0)
            d = np.sqrt((q[:, 0] / rx) ** 2 + (q[:, 1] * up / max(ry, 1e-4)) ** 2 + (q[:, 2] / (rx * 1.4)) ** 2)
            k *= smoothstep(1.2, 1.9, d)
            R['eye'] *= smoothstep(1.3, 2.6, d)
        nose = A('nose')
        ml, mr = A('mouthL'), A('mouthR')
        mc = (ml + mr) / 2
        mc[2] = max(mc[2], nose[2] - 0.04)
        dn = np.linalg.norm(Pw - nose, axis=1)
        k *= smoothstep(0.045 * eyeD / 0.27, 0.09 * eyeD / 0.27, dn)
        # рот: отрезок между уголками, чуть шире, и фильтрум до носа
        t = np.clip(((Pw - mr) @ (ml - mr)) / np.dot(ml - mr, ml - mr), -0.25, 1.25)
        dm = np.linalg.norm(Pw - (mr + t[:, None] * (ml - mr)), axis=1)
        k *= smoothstep(0.045 * eyeD / 0.27, 0.11 * eyeD / 0.27, dm)
        # морда и лоб спереди — короче; щёки и бока головы — длиннее
        fc = np.array([nose[0], (A('eyeBottomL')[1] + A('eyeBottomR')[1]) / 2, nose[2]])
        front = smoothstep(0.35, 0.8, Nw[:, 2]) * (1 - smoothstep(0.6 * eyeD, 1.1 * eyeD, np.linalg.norm((Pw - fc)[:, :2], axis=1)))
        k *= 1 - 0.8 * front
        lat = smoothstep(0.55 * eyeD, 0.9 * eyeD, np.abs(Pw[:, 0] - nose[0]))
        low = 1 - smoothstep(fc[1] - 0.05 * eyeD, fc[1] + 0.35 * eyeD, Pw[:, 1])
        k *= 1 + (CHEEK_K[persona] - 1) * lat * low * smoothstep(-0.3, 0.2, Nw[:, 2])
        # уши (выше макушки черепа) — короткий мех снаружи
        ytop = marks['eyeTopL'] + 0.55 * eyeD
        k *= 1 - 0.6 * smoothstep(ytop, ytop + 0.08 * eyeD, Pw[:, 1])
        # ниже подбородка (наушники, воротник) — не мех головы
        chinY = (ml[1] + mr[1]) / 2 - 0.5 * eyeD
        k *= smoothstep(chinY - 0.05 * eyeD, chinY + 0.05 * eyeD, Pw[:, 1])
        R.update(lo=lo, lat=lat, low=low, front=front, ytop=ytop, eyeD=eyeD, nose=nose, mouth=(ml + mr) / 2, k=k.copy())
    L = HEAD_LEN[persona] * lo * k
    Lv = L[weld]
    hv = to_w(headw)[weld]
    new = np.where(hv > 0.55, Lv, np.where(hv > 0.4, 0.0, old))
    new[new < 0.0008] = 0
    tri = np.where((new[I] > 0.0008).all(1))[0]
    print(f'{persona}: треугольников меха {len(tri)} (было {len(g.acc(sh["indices"])) // 3}), голова {int(((new[I] > 0).all(1) & (hv[I] > 0.55).all(1)).sum())}, длина головы ≤ {L.max():.4f}')

    def replace(ai_key, arr, ctype, target):
        old_ai = sh[ai_key] if ai_key == 'indices' else sh['attributes'][ai_key]
        old_bv = j['accessors'][old_ai]['bufferView']
        users = [a for a in j['accessors'] if a.get('bufferView') == old_bv]
        typ = 'SCALAR'
        ai = g.add_acc(arr, ctype, typ, target)
        # на место старого accessor (номер тот же — ссылки целы); старый bufferView опустошаем, если больше не нужен
        j['accessors'][old_ai] = j['accessors'][ai]
        j['accessors'].pop()
        if len(users) == 1:
            g.extra[old_bv] = b''

    nV = len(P)
    replace('indices', I[tri].ravel().astype(np.uint16 if nV < 65535 else np.uint32), 5123 if nV < 65535 else 5125, 34963)
    replace('_FURLEN', new.astype(np.float32), 5126, 34962)
    # морфы тела (только позиции) — мех едет с мордой
    if body.get('targets'):
        sh['targets'] = [{'POSITION': t['POSITION']} for t in body['targets']]
        names_t = (j['meshes'][bi].get('extras') or {}).get('targetNames')
        if names_t:
            j['meshes'][si].setdefault('extras', {})['targetNames'] = names_t
        if j['meshes'][bi].get('weights'):
            j['meshes'][si]['weights'] = [0.0] * len(body['targets'])
    for n in j['nodes']:
        if n.get('name') == 'BD_FurShell':
            ex = n.setdefault('extras', {})
            ex.setdefault('fur', {})['head'] = 1
    if marks:
        cards(g, persona, bi, body, si, P, N, UV, J, Wt, I, weld, nW, Pw, Nw, fur, head, R, wsum, furc, c, to_w, smooth, erode, E)
    for n in j['nodes']:
        if n.get('name') == 'Eye_L' or n.get('name') == 'Eye_R':
            n.setdefault('extras', {})['restUp'] = REST_UP[persona]
    g.save(dst)
    if dbg:
        from PIL import Image
        im = img.copy()
        lim = max(new.max(), 1e-6)
        for t_ in I[tri][::1]:
            for v in t_:
                im[py[v] - 1:py[v] + 2, px[v] - 1:px[v] + 2] = [255 * new[v] / lim, 0, 255 * (1 - new[v] / lim)]
        Image.fromarray(im.astype(np.uint8)).resize((W // 2, H // 2)).save(dbg)


def cards(g, persona, bi, body, si, P, N, UV, J, Wt, I, weld, nW, Pw, Nw, fur, head, R, wsum, furc, col, to_w, smooth, erode, E):
    """BD_FurCards — пряди-карточки для силуэта (щёки, макушка, затылок, подбородок, уши, хвост, лапы).
    Пучок = две изогнутые полоски крест-накрест (видно с любого угла), корень утоплен в поверхность.
    Скин и морфы — от вершины тела у корня. UV0 — тексель тела у корня (цвет меха), UV1 — по карточке (рантайм рисует
    пряди процедурной альфой, furShell.ts). Нормаль — нормаль тела у корня: освещение как у тела, без «наклеек»."""
    j = g.j
    rng = np.random.default_rng({'hooligan': 1, 'kind': 2, 'glitter': 3}[persona])
    eyeD = R['eyeD']; nose = R['nose']
    # вершина-представитель для каждой сшитой
    rep = np.zeros(nW, dtype=np.int64); rep[weld] = np.arange(len(weld))
    cand = []  # (welded idx, length, dir, width)
    up = np.array([0, 1.0, 0]); down = -up; back = np.array([0, 0, -1.0])
    headfur = fur & head & (R['eye'] > 0.6)
    sx = np.sign(Pw[:, 0] - nose[0])
    # 1) голова: силуэт — щёки (длинные, наружу-вниз), бока и затылок (по шерсти назад-вниз), макушка (вверх)
    lat, low, front = R['lat'], R['low'], R['front']
    cheek = lat * low * (Nw[:, 2] > -0.35) * (np.abs(Nw[:, 0]) > 0.35)
    crown = (Pw[:, 1] > R['ytop'] - 0.25 * eyeD) * (np.abs(Pw[:, 0] - nose[0]) < 0.28 * eyeD) * (Nw[:, 1] > 0.5)
    chin = (Pw[:, 1] < R['mouth'][1] - 0.32 * eyeD) * (Nw[:, 2] > 0.1) * (np.abs(Pw[:, 0] - nose[0]) < 0.55 * eyeD)
    base = {'hooligan': 0.024, 'kind': 0.026, 'glitter': 0.022}[persona]
    for w in np.where(headfur & (front < 0.25) & (R['k'] > 0.75) & (R['lo'] > 0.9))[0]:
        n = Nw[w]
        if cheek[w] > 0.3:
            L = base * (1.4 + 0.9 * cheek[w]); d = n * 0.8 + down * 0.45 + np.array([sx[w] * 0.5, 0, 0]); kind = 'cheek'
        elif crown[w]:
            L = base * 1.25; d = n + up * 0.6 + back * 0.15; kind = 'crown'
        elif chin[w]:
            L = base * 0.8; d = n * 0.8 + down * 0.5; kind = 'chin'
        elif Pw[w, 1] > R['ytop'] + 0.02 * eyeD:
            continue  # уши — отдельно
        else:
            L = base * (0.6 + 0.2 * (Nw[w, 2] < 0)); d = n * 0.75 + down * 0.35 + back * 0.35; kind = 'head'
        cand.append((w, L, d, kind))
    # 2) уши: светлые пучки из розовой внутренности (не мех по цвету, на голове, выше макушки, смотрит вперёд)
    rr, gg_, bb = to_w(col[:, 0]), to_w(col[:, 1]), to_w(col[:, 2])
    pink = (rr > gg_ + 25) & (rr > bb) & head & (Pw[:, 1] > R['ytop'] - 0.05 * eyeD) & (Nw[:, 2] > 0.2)
    for w in np.where(pink)[0]:
        cand.append((w, base * 0.75, Nw[w] * 0.5 + up * 0.8 + np.array([-sx[w] * 0.25, 0, 0.2]), 'ear'))
    # 3) хвост: кончик пушистее; кисти — пучки на тыльной стороне и запястье
    tw = to_w(wsum(lambda n: n.startswith('Tail')))
    tipw = to_w(wsum(lambda n: n.startswith('Tail') and n[-1:] in '34567' or n.startswith('TailEnd')))
    hw = to_w(wsum(lambda n: 'Hand' in n and 'Thumb' not in n and 'Index' not in n and 'Middle' not in n and 'Ring' not in n and 'Pinky' not in n))
    furw = smooth(to_w(furc.astype(np.float64)), 2) > 0.5
    for w in np.where((tw > 0.5) & (furw | (persona == 'glitter')))[0]:
        cand.append((w, base * (0.7 + 0.6 * min(1, tipw[w])), Nw[w] * 0.8 + down * 0.3, 'tail'))
    for w in np.where((hw > 0.6) & furw)[0]:
        cand.append((w, base * 0.45, Nw[w] * 0.8 + down * 0.3, 'paw'))
    # прореживание: не ближе spacing (по виду), случайный порядок
    SP = {'cheek': 0.42, 'crown': 0.5, 'chin': 0.5, 'head': 0.75, 'ear': 0.6, 'tail': 0.55, 'paw': 0.8}
    order = rng.permutation(len(cand))
    keep = []
    grid = {}
    for o in order:
        w, L, d, kd = cand[o]
        sp = SP[kd] * L
        cell = tuple((Pw[w] / 0.01).astype(int))
        ok = True
        for dx in (-2, -1, 0, 1, 2):
            for dy in (-2, -1, 0, 1, 2):
                for dz in (-2, -1, 0, 1, 2):
                    for (q, s2) in grid.get((cell[0] + dx, cell[1] + dy, cell[2] + dz), ()):
                        if np.linalg.norm(Pw[q] - Pw[w]) < max(sp, s2):
                            ok = False; break
                    if not ok: break
                if not ok: break
            if not ok: break
        if ok:
            keep.append(o); grid.setdefault(cell, []).append((w, sp))
    SEG = 2
    V, NN, U0, U1, JJ, WW, ROOT, F = [], [], [], [], [], [], [], []
    for o in keep:
        w, L, d, kd = cand[o]
        L *= 0.8 + 0.4 * rng.random()
        d = d / np.linalg.norm(d)
        n = Nw[w]
        v = rep[w]
        a1 = np.cross(d, np.array([0, 0, 1.0]) if abs(d[2]) < 0.9 else np.array([1.0, 0, 0])); a1 /= np.linalg.norm(a1)
        a2 = np.cross(d, a1); a2 /= np.linalg.norm(a2)
        rot = rng.random() * np.pi
        a1, a2 = a1 * np.cos(rot) + a2 * np.sin(rot), -a1 * np.sin(rot) + a2 * np.cos(rot)
        wid = L * (0.5 if kd in ('cheek', 'chin') else 0.42)
        root = Pw[w] - n * 0.0025
        for ax in (a1, a2):
            b0 = len(V)
            for s_ in range(SEG + 1):
                t = s_ / SEG
                c_ = root + d * L * t + down * L * 0.3 * t * t
                hw_ = wid * 0.5 * (1 - 0.35 * t)
                for side in (-1, 1):
                    V.append(c_ + ax * hw_ * side); NN.append(n); U0.append(UV[v]); U1.append([(side + 1) / 2, t])
                    JJ.append(J[v]); WW.append(Wt[v]); ROOT.append(v)
            for s_ in range(SEG):
                q = b0 + 2 * s_
                F += [[q, q + 1, q + 3], [q, q + 3, q + 2]]
    V = np.array(V, np.float32); NN = np.array(NN, np.float32); F = np.array(F, np.uint32 if len(V) > 65000 else np.uint16)
    ROOT = np.array(ROOT)
    kinds = {}
    for o in keep:
        kinds[cand[o][3]] = kinds.get(cand[o][3], 0) + 1
    print(f'  BD_FurCards: {len(keep)} пучков {kinds}, {len(V)} вершин')
    WWa = np.array(WW, np.float64); WWa /= WWa.sum(1, keepdims=True)
    q8 = np.round(WWa * 255).astype(np.int64); q8[np.arange(len(q8)), q8.argmax(1)] += 255 - q8.sum(1)
    wq = g.add_acc(q8.astype(np.uint8), 5121, 'VEC4', 34962)
    g.j['accessors'][wq]['normalized'] = True
    attrs = {
        'POSITION': g.add_acc(V, 5126, 'VEC3', 34962),
        'NORMAL': g.add_acc(NN, 5126, 'VEC3', 34962),
        'TEXCOORD_0': g.add_acc(np.array(U0, np.float32), 5126, 'VEC2', 34962),
        'TEXCOORD_1': g.add_acc(np.array(U1, np.float32), 5126, 'VEC2', 34962),
        'JOINTS_0': g.add_acc(np.array(JJ, np.uint8 if max(map(max, JJ)) < 256 else np.uint16), 5121 if max(map(max, JJ)) < 256 else 5123, 'VEC4', 34962),
        'WEIGHTS_0': wq,
    }
    prim = {'attributes': attrs, 'indices': g.add_acc(F.ravel(), 5125 if F.dtype == np.uint32 else 5123, 'SCALAR', 34963)}
    if body.get('targets'):
        tg = []
        for t in body['targets']:
            D = g.acc(t['POSITION']).astype(np.float32)[ROOT]
            nz = np.where(np.abs(D).max(1) > 1e-6)[0]
            # sparse: только пучки, которые этот ключ двигает (остальные — нули без байтов)
            acc = {'componentType': 5126, 'count': len(D), 'type': 'VEC3', 'min': D.min(0).tolist(), 'max': D.max(0).tolist()}
            if len(nz):
                ii = g.add_acc(nz.astype(np.uint32), 5125, 'SCALAR'); vv = g.add_acc(D[nz], 5126, 'VEC3')
                acc['sparse'] = {'count': int(len(nz)), 'indices': {'bufferView': g.j['accessors'][ii]['bufferView'], 'componentType': 5125},
                                 'values': {'bufferView': g.j['accessors'][vv]['bufferView']}}
            g.j['accessors'].append(acc)
            tg.append({'POSITION': len(g.j['accessors']) - 1})
        prim['targets'] = tg
    mat = {'name': 'BD_FurCards_mat', 'alphaMode': 'MASK', 'alphaCutoff': 0.5, 'doubleSided': True,
           'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 0], 'metallicFactor': 0}}
    mesh = {'name': 'BD_FurCards', 'primitives': [prim]}
    tn = (j['meshes'][bi].get('extras') or {}).get('targetNames')
    if tn and body.get('targets'):
        mesh['extras'] = {'targetNames': tn}
        mesh['weights'] = [0.0] * len(body['targets'])
    ex = next((n for n in j['nodes'] if n.get('name') == 'BD_FurCards'), None)
    if ex is not None:  # повторный прогон: тот же меш на месте, старые данные — пустые bufferViews
        mi = ex['mesh']
        for p_ in j['meshes'][mi]['primitives']:
            accs = list(p_['attributes'].values()) + [p_['indices']] + [a for t in p_.get('targets', []) for a in t.values()]
            for a in accs:
                A_ = j['accessors'][a]
                for bv in [A_.get('bufferView')] + ([A_['sparse']['indices']['bufferView'], A_['sparse']['values']['bufferView']] if 'sparse' in A_ else []):
                    if bv is not None:
                        g.extra[bv] = b''
        j['materials'][j['meshes'][mi]['primitives'][0]['material']] = mat
        prim['material'] = j['meshes'][mi]['primitives'][0]['material']
        j['meshes'][mi] = mesh
    else:
        j['materials'].append(mat); prim['material'] = len(j['materials']) - 1
        j['meshes'].append(mesh)
        bnode = next(i for i, n in enumerate(j['nodes']) if n.get('mesh') == bi)
        j['nodes'].append({'name': 'BD_FurCards', 'mesh': len(j['meshes']) - 1, 'skin': j['nodes'][bnode]['skin']})
        ni = len(j['nodes']) - 1
        parent = next((n for n in j['nodes'] if bnode in n.get('children', [])), None)
        if parent is not None:
            parent['children'].append(ni)
        else:
            j['scenes'][0]['nodes'].append(ni)


if __name__ == '__main__':
    main()
