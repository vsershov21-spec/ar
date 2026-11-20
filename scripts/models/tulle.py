#!/usr/bin/env python3
"""Юбка-пачка Блёстки из фатина: вместо спаянной с телом непрозрачной юбки Tripo (рюши режут друг друга и бёдра) —
три слоя полупрозрачного фатина по форме исходной юбки.

  python3 scripts/models/tulle.py glitter in.glb out.glb [--puff 1.16] [--hem 0.03] [--bell 4] [--ruffle 0.004] [--shards]
  (p1 Блёстки, 20.11: --puff 1.0 --hem 0.03 --bell 4 --ruffle 0.004 --shards — короткая пачка до середины бедра, docs/models/README.md)

- Треугольники юбки (mesh_parts: метка «юбка») убираются из тела; под ними у Tripo есть поверхность бёдер.
- Слой k (0 — внутренний): от пояса вниз до подола, радиус по секторам: у пояса — тело + 3 мм, у подола —
  профиль исходной юбки (90-й перцентиль по сектору), каждый следующий слой на 5 мм дальше и на 9 мм короче;
  подол волнистый (по высоте), лёгкие радиальные складки < зазора между слоями — слои не пересекаются по построению.
- Скин и UV — от ближайшей вершины исходной юбки (тот же цвет и блёстки); морфов нет.
- Материал BD_Tulle_mat: BLEND, двусторонний, альфа в COLOR_0 (плотнее у пояса, прозрачнее к подолу).
"""
import sys
import numpy as np
from scipy.spatial import cKDTree
from glb_io import Glb
from mesh_parts import label_parts, SKIRT, BODY

NT, NS, LAYERS = 80, 13, 3


def fit(g):
    """после untangle: фатин, задетый телом, — наружу (все слои в этом секторе и ряду вместе: порядок слоёв цел)"""
    from penetration import tri_pairs_intersect
    j = g.j
    n = next(n for n in j['nodes'] if n.get('extras', {}).get('tulle'))
    pr = j['meshes'][n['mesh']]['primitives'][0]
    V = g.acc(pr['attributes']['POSITION']).astype(np.float64)
    F = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    bi, b = g.main_mesh()
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    Jb = g.acc(b['attributes']['JOINTS_0']).astype(np.int64); Wb = g.acc(b['attributes']['WEIGHTS_0']).astype(np.float64)
    Wb /= 255 if Wb.max() > 1.5 else 1
    jn = [j['nodes'][k]['name'] for k in j['skins'][0]['joints']]
    tail = (Wb * np.array([x.startswith('Tail') for x in jn])[Jb]).sum(1)
    Ib = I[~(tail[I] > 0.3).any(1)]
    c = np.array(n['extras']['c'])
    per = NS * NT
    tot = 0
    for it in range(30):
        pp = tri_pairs_intersect(V, F, P, Ib)
        if not len(pp):
            break
        hv = np.unique(F[pp[:, 0]].ravel()) % per
        tot += len(hv)
        for q in hv:
            si, k = divmod(q, NT)
            # весь столбец (все ряды и слои сектора) — одинаково: зазоры между слоями не меняются
            for dk in (-2, -1, 0, 1, 2):
                for s2 in range(NS):
                    w = 0.0015 * (1 - abs(dk) / 3)
                    for L in range(LAYERS):
                        v = L * per + s2 * NT + (k + dk) % NT
                        r = V[v, [0, 2]] - c[[0, 2]]
                        V[v, [0, 2]] += w * r / max(np.linalg.norm(r), 1e-6)
    g.set_acc(pr['attributes']['POSITION'], V.astype(np.float32))
    print(f'  фатин: подгонка к телу — {it} шагов, осталось {len(tri_pairs_intersect(V, F, P, Ib))}')


def main():
    cat, src, dst = sys.argv[1:4]
    g = Glb(src); j = g.j
    if '--fit' in sys.argv:
        fit(g); g.save(dst); return
    bi, b = g.main_mesh()
    A = lambda k: g.acc(b['attributes'][k])
    P = A('POSITION').astype(np.float64); UV = A('TEXCOORD_0').astype(np.float64)
    J = A('JOINTS_0'); Wt = A('WEIGHTS_0')
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    lab = label_parts(cat, g, b, P, I)
    skt = (lab[I] == SKIRT).all(1)
    if '--shards' in sys.argv:
        # --shards: осколки юбки Tripo у подола (рюши, мятные по цвету, часть размечена «телом») — тоже прочь: при
        # короткой и узкой пачке они торчат из-под подола
        bm0 = j['materials'][b['material']]
        im0 = np.asarray(g.image(j['textures'][bm0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB')).astype(np.float64)
        S0 = im0.shape[0]
        uvt = UV[I].mean(1)
        ct = im0[np.clip((uvt[:, 1] % 1) * S0, 0, S0 - 1).astype(int), np.clip((uvt[:, 0] % 1) * S0, 0, S0 - 1).astype(int)]
        Ct = P[I].mean(1)
        Xs = P[lab == SKIRT]
        # только низ — то, что видно у подола и под ним (выше осколки закрывают стык пояса с телом под фатином)
        hem0 = float(sys.argv[sys.argv.index('--hem') + 1]) if '--hem' in sys.argv else 0.0
        band = (Ct[:, 1] > np.percentile(Xs[:, 1], 1) - 0.01) & (Ct[:, 1] < np.percentile(Xs[:, 1], 2) + hem0 + 0.035)
        mint = (ct[:, 1] - ct[:, 0] > 25) & (ct[:, 2] - ct[:, 0] > 15)
        from mesh_parts import HOODIE
        sh_ = band & (((lab[I] == SKIRT).any(1)) | (mint & ~(lab[I] == HOODIE).any(1)))
        print(f'  осколки юбки Tripo: ещё {(sh_ & ~skt).sum()} треугольников')
        skt = skt | sh_
    sv = np.where(lab == SKIRT)[0]
    X = P[sv]
    c = np.array([np.median(X[:, 0]), 0, np.median(X[:, 2])])
    yt, yb = np.percentile(X[:, 1], 97), np.percentile(X[:, 1], 2)
    ang = lambda Q: np.arctan2(Q[:, 2] - c[2], Q[:, 0] - c[0])
    rad = lambda Q: np.hypot(Q[:, 0] - c[0], Q[:, 2] - c[2])
    th = np.linspace(-np.pi, np.pi, NT, endpoint=False)
    sec = ((ang(X) + np.pi) / (2 * np.pi) * NT).astype(int) % NT
    r_hem = np.zeros(NT)
    for k in range(NT):
        m = np.abs(((sec - k + NT // 2) % NT) - NT // 2) <= 2
        r_hem[k] = np.percentile(rad(X[m]), 90) if m.sum() > 3 else np.nan
    r_hem = np.where(np.isnan(r_hem), np.nanmedian(r_hem), r_hem)
    # пачка пышнее (рефы: фатин расходится колоколом); --puff K — свой множитель (p1 Блёстки: 1.32)
    puff = float(sys.argv[sys.argv.index('--puff') + 1]) if '--puff' in sys.argv else 1.16
    r_hem = r_hem * puff
    # --hem H: подол выше на H м (пачка короче; p1 Блёстки 20.11: 0.035 — до середины бедра)
    hem_up = float(sys.argv[sys.argv.index('--hem') + 1]) if '--hem' in sys.argv else 0.0
    yb = yb + hem_up
    # --bell K: профиль 1 − (1 − t)^K — пачка сразу от пояса пышная, к подолу почти вертикально (края мягко вниз,
    # не «абажур»; руки у бёдер — под фатином, а не сквозь него);
    # --ruffle A: волна-оборка по краю (радиальная, одна фаза у всех слоёв — зазоры целы) и фестоны подола
    bell = float(sys.argv[sys.argv.index('--bell') + 1]) if '--bell' in sys.argv else 0.0
    ruf = float(sys.argv[sys.argv.index('--ruffle') + 1]) if '--ruffle' in sys.argv else 0.0
    sprof = [float(x) for x in sys.argv[sys.argv.index('--sprof') + 1].split(',')] if '--sprof' in sys.argv else None
    tier = float(sys.argv[sys.argv.index('--tier') + 1]) if '--tier' in sys.argv else 0.0
    # тело (без юбки, без рук и хвоста) в поясе и ниже — максимальный радиус по сектору и высоте
    jn = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in j['skins'][0]['joints']]
    Wf = Wt.astype(np.float64) / (255.0 if Wt.max() > 1.5 else 1.0)
    armw = (Wf * np.array([('Arm' in n or 'Hand' in n or n.startswith('Tail')) for n in jn])[J.astype(np.int64)]).sum(1)
    Bv = np.where((lab != SKIRT) & (armw < 0.2) & (P[:, 1] > yb - 0.02) & (P[:, 1] < yt + 0.01) & (rad(P) < 0.25))[0]
    bs = ((ang(P[Bv]) + np.pi) / (2 * np.pi) * NT).astype(int) % NT
    YG = np.linspace(yt + 0.004, yb - 0.02, 40)
    rb = np.zeros((NT, len(YG)))
    for k in range(NT):
        m = np.abs(((bs - k + NT // 2) % NT) - NT // 2) <= 3
        for yi_, y in enumerate(YG):
            mm = m & (np.abs(P[Bv, 1] - y) < 0.01)
            rb[k, yi_] = rad(P[Bv[mm]]).max() if mm.any() else 0.0
    # базовый профиль r(θ, y): у пояса — тело + 3 мм, книзу — расклёш к подолу исходной юбки, не ближе 4 мм к телу,
    # не убывает книзу (поверхность вращения: слои с постоянным зазором не пересекаются)
    base_r = np.zeros_like(rb)
    for k in range(NT):
        r0 = max(rb[k, :3].max(), 0.05) + 0.003
        for yi_, y in enumerate(YG):
            t = np.clip((yt - y) / max(yt - yb, 1e-3), 0, 1)
            if sprof:  # S-профиль: у пояса прилегает (манжеты рукавов в позах — снаружи), ниже — расклёш, у подола вниз
                s_ = np.clip((t - sprof[0]) / (sprof[1] - sprof[0]), 0, 1)
                prof = s_ * s_ * (3 - 2 * s_)
            else:
                prof = 1 - (1 - t) ** bell if bell else t ** 0.75
            base_r[k, yi_] = max(r0 + (r_hem[k] - r0) * prof, rb[k, yi_] + 0.004)
        base_r[k] = np.maximum.accumulate(base_r[k])
    # по секторам — сгладить (без зубцов от тела)
    for _ in range(3):
        base_r = np.maximum(base_r, 0.5 * (np.roll(base_r, 1, 0) + np.roll(base_r, -1, 0)))
    from scipy.ndimage import gaussian_filter1d
    base_r = np.maximum.accumulate(gaussian_filter1d(base_r, 2.0, axis=1, mode='nearest') + 0.002, axis=1)
    def build(base_r):
        rfun = lambda k, y: np.interp(-y, -YG, base_r[k])
        V, Nn, U, JJ, WW, COL, F = [], [], [], [], [], [], []
        tree = cKDTree(X)
        for L in range(LAYERS):
            # --tier D: ярусы — внешние слои начинаются ниже пояса на D·L (у пояса один слой: рукав в позе режет один
            # слой, а не три; по рефу — пачка из 2–3 ярусов)
            y_top = yt - (tier if tier else 0.003) * L
            base = len(V)
            for si in range(NS):
                t = si / (NS - 1)
                for k in range(NT):
                    a = th[k]
                    y_hem = yb + 0.009 * L + 0.006 * np.sin(9 * a + 1.7 * L) * (1 if L else 0.5)
                    if ruf:
                        # фестоны: у каждого слоя свой шаг и фаза (слои видны ярусами), край мягко вниз
                        y_hem += ruf * 1.2 * (0.5 + 0.5 * np.sin((10 + 2 * L) * a + 1.3 * L)) ** 2 * (1 if L else 0.6)
                    y = y_top + (y_hem - y_top) * t
                    r = rfun(k, y) + 0.005 * L + 0.0018 * np.sin(18 * a + 2.1 * L) * t
                    if ruf:
                        r += ruf * np.sin(10 * a) * t ** 2
                    p = np.array([c[0] + r * np.cos(a), y, c[2] + r * np.sin(a)])
                    V.append(p)
                    n = np.array([np.cos(a), 0.35 * t + 0.1, np.sin(a)]); Nn.append(n / np.linalg.norm(n))
                    _, q = tree.query(p)
                    vi = sv[q]
                    U.append(UV[vi]); JJ.append(J[vi]); WW.append(Wt[vi])
                    # v2b: альфа ровнее и мягче (v2: 0.86→0.5 × 0.9/0.72 — плотный у пояса, «шум» из текстуры),
                    # цвет — ровный тон юбки, к подолу чуть светлее
                    COL.append([0.93 + 0.07 * t, 0.93 + 0.07 * t, 0.93 + 0.07 * t, (0.74 - 0.18 * t) * (0.9 if L == LAYERS - 1 else 0.72)])
            for si in range(NS - 1):
                for k in range(NT):
                    a0 = base + si * NT + k; a1 = base + si * NT + (k + 1) % NT
                    b0, b1 = a0 + NT, a1 + NT
                    F += [[a0, b0, b1], [a0, b1, a1]]

        return V, Nn, U, JJ, WW, COL, F
    from penetration import tri_pairs_intersect
    from scipy.ndimage import gaussian_filter1d
    tailw = (Wf * np.array([n.startswith('Tail') for n in jn])[J.astype(np.int64)]).sum(1)
    keepT = ~skt
    It = I[keepT]
    tail_t = (tailw[It] > 0.3).any(1)
    Ib, Itail = It[~tail_t], It[tail_t]
    for it in range(25):
        V, Nn, U, JJ, WW, COL, F = build(base_r)
        Va = np.array(V); Fa = np.array(F)
        pp = tri_pairs_intersect(Va, Fa, P, Ib)
        if not len(pp):
            break
        hv = np.unique(Fa[pp[:, 0]].ravel())
        L_ = hv // (NS * NT); rem = hv % (NS * NT); k_ = rem % NT
        yv = Va[hv, 1]
        yi_ = np.clip(np.searchsorted(-YG, -yv), 0, len(YG) - 1)
        for kk, yy in zip(k_, yi_):
            for dk in (-1, 0, 1):
                base_r[(kk + dk) % NT, max(0, yy - 2):yy + 3] += 0.0015
        base_r = gaussian_filter1d(gaussian_filter1d(base_r, 1.5, axis=1, mode='nearest'), 1.0, axis=0, mode='wrap')
        base_r = np.maximum.accumulate(base_r, axis=1)
    print(f'  фатин: {it} шагов расширения, пересечений с телом осталось {len(pp)}')
    # хвост проходит сквозь пачку — в фатине прорезь (треугольники, которые режет хвост, убраны)
    Va = np.array(V); Fa = np.array(F)
    cut = np.zeros(len(Fa), bool)
    if len(Itail):
        for _ in range(2):
            pt = tri_pairs_intersect(Va, Fa[~cut], P, Itail)
            idx = np.where(~cut)[0][pt[:, 0]]
            if not len(idx):
                break
            # с соседями: прорезь без бахромы
            vv = np.unique(Fa[idx].ravel())
            cut |= np.isin(Fa, vv).any(1)
    print(f'  фатин: прорезь для хвоста — {cut.sum()} треугольников')
    F = Fa[~cut].tolist()
    V = np.array(V, np.float32); F = np.array(F, np.uint16)
    print(f'{cat}: юбка Tripo — {skt.sum()} треугольников убрано; фатин {LAYERS} слоя, {len(V)} вершин, пояс y={yt:.3f}, подол y={yb:.3f}, '
          f'радиус подола {r_hem.min():.3f}…{r_hem.max():.3f}')
    # тело без юбки
    g.set_acc  # noqa
    ai = b['indices']
    if not skt.any():
        print('  юбка уже убрана — перестраиваю фатин по текущему телу')
    newI = I[~skt].ravel().astype(np.uint16 if len(P) < 65535 else np.uint32)
    ni = g.add_acc(newI, 5123 if newI.dtype == np.uint16 else 5125, 'SCALAR', 34963)
    j['accessors'][ai] = j['accessors'][ni]; j['accessors'].pop()
    WWa = np.array(WW, np.float64)
    if WWa.max() > 1.5:
        WWa /= 255
    WWa /= WWa.sum(1, keepdims=True)
    # скин фатина: у всех слоёв столбца — одинаковые веса (внутреннего слоя), сглаженные по соседним секторам и рядам:
    # в позах слои двигаются вместе и не прорезают друг друга
    JJa0 = np.array(JJ, np.int64)
    nj = len(j['skins'][0]['joints'])
    full = np.zeros((NS * NT, nj))
    for q in range(NS * NT):
        np.add.at(full[q], JJa0[q], WWa[q])
    full = full.reshape(NS, NT, nj)
    from scipy.ndimage import uniform_filter1d
    full = uniform_filter1d(uniform_filter1d(full, 5, axis=1, mode='wrap'), 3, axis=0, mode='nearest')
    full = full.reshape(NS * NT, nj)
    top = np.argsort(-full, axis=1)[:, :4]
    tw = np.take_along_axis(full, top, 1); tw /= tw.sum(1, keepdims=True)
    JJ = [top[q % (NS * NT)] for q in range(len(V))]
    WWa = np.array([tw[q % (NS * NT)] for q in range(len(V))])
    q8 = np.round(WWa * 255).astype(np.int64); q8[np.arange(len(q8)), q8.argmax(1)] += 255 - q8.sum(1)
    wq = g.add_acc(q8.astype(np.uint8), 5121, 'VEC4', 34962); j['accessors'][wq]['normalized'] = True
    JJa = np.array(JJ)
    attrs = {'POSITION': g.add_acc(V, 5126, 'VEC3', 34962), 'NORMAL': g.add_acc(np.array(Nn, np.float32), 5126, 'VEC3', 34962),
             'TEXCOORD_0': g.add_acc(np.array(U, np.float32), 5126, 'VEC2', 34962),
             'COLOR_0': g.add_acc(np.round(np.clip(np.array(COL), 0, 1) * 255).astype(np.uint8), 5121, 'VEC4', 34962),
             'JOINTS_0': g.add_acc(JJa.astype(np.uint8 if JJa.max() < 256 else np.uint16), 5121 if JJa.max() < 256 else 5123, 'VEC4', 34962),
             'WEIGHTS_0': wq}
    j['accessors'][attrs['COLOR_0']]['normalized'] = True
    bm = j['materials'][b['material']]
    # v2b: без текстуры — UV «от ближайшей вершины» юбки Tripo на трёх прозрачных слоях давали серую рябь (рюши и тени
    # запечены в альбедо); фатин — ровный цвет юбки (медиана текселей юбки, чуть светлее), градиент и альфа — в COLOR_0
    from glb_io import raster_uv as _ruv
    ti_ = j['textures'][bm['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    im_ = np.asarray(g.image(ti_).convert('RGB')).astype(np.float64)
    S_ = im_.shape[0]
    tc = im_[np.clip((UV[sv, 1] % 1) * S_, 0, S_ - 1).astype(int), np.clip((UV[sv, 0] % 1) * S_, 0, S_ - 1).astype(int)]
    lum_ = tc @ np.array([0.299, 0.587, 0.114])
    base_c = np.median(tc[lum_ > np.percentile(lum_, 40)], axis=0) / 255
    lin = lambda c: np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    # насыщеннее к мятному тону рефа (медиана текселей серее: в тени рюш) — иначе в приложении фатин читается серым мешком
    g_ = base_c.mean()
    base_c = np.clip(g_ + (base_c - g_) * 2.2, 0, 1) * 0.6 + np.array([0.62, 0.86, 0.8]) * 0.4
    bcf = np.clip(lin(np.clip(base_c * 1.04 + 0.02, 0, 1)), 0, 1)
    print(f'  фатин: цвет юбки {np.round(base_c * 255).astype(int)} → baseColorFactor {np.round(bcf, 3)}')
    mat = {'name': 'BD_Tulle_mat', 'alphaMode': 'BLEND', 'doubleSided': True,
           'pbrMetallicRoughness': {'baseColorFactor': [float(bcf[0]), float(bcf[1]), float(bcf[2]), 1], 'metallicFactor': 0, 'roughnessFactor': 0.7},
           'emissiveFactor': [float(x) * 0.12 for x in bcf]}
    prim = {'attributes': attrs, 'indices': g.add_acc(F.ravel(), 5123, 'SCALAR', 34963)}
    old = next((n for n in j['nodes'] if n.get('extras', {}).get('tulle')), None)
    if old is not None:  # повторный прогон (после untangle): тот же меш и материал, старые данные — пустые
        mi = old['mesh']
        op = j['meshes'][mi]['primitives'][0]
        for a_ in list(op['attributes'].values()) + [op['indices']]:
            g.extra[j['accessors'][a_]['bufferView']] = b''
        prim['material'] = op['material']; j['materials'][op['material']] = mat
        j['meshes'][mi]['primitives'] = [prim]
    else:
        j['materials'].append(mat); prim['material'] = len(j['materials']) - 1
        j['meshes'].append({'name': 'Skirt_Glitter', 'primitives': [prim]})
        bnode = next(i for i, n in enumerate(j['nodes']) if n.get('mesh') == bi)
        j['nodes'].append({'name': 'Skirt_Glitter', 'mesh': len(j['meshes']) - 1, 'skin': j['nodes'][bnode]['skin'], 'extras': {'tulle': 1, 'c': c.tolist()}})
        parent = next((n for n in j['nodes'] if bnode in n.get('children', [])), None)
        (parent['children'] if parent is not None else j['scenes'][0]['nodes']).append(len(j['nodes']) - 1)
    g.save(dst)


if __name__ == '__main__':
    main()
