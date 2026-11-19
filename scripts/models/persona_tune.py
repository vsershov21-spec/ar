#!/usr/bin/env python3
"""Глаза по рефам персонажей (design/cut/<кот>/turn, face): широко открытые, круглые, с тёмной подводкой.

  python3 scripts/models/persona_tune.py <cat> in.glb out.glb

Только Хулиган и Добряк (Блёстка — без изменений). Геометрию, кости, текстуры не трогает (байт-в-байт), меняет:
  • extras.restUp узлов Eye_L/R — верхнее веко в покое (Добряк — глаз открыт до радужки, Хулиган — чуть ниже: дерзкий,
    но не сонный);
  • COLOR_0 век (face_detail.lid_mesh: 11 рядов по nu вершин, ряд 0 — кромка): подводка верхнего века шире и чернее,
    у нижнего — тонкая линия (рефы: тёмный контур по всему верхнему краю глаза).
Повторный запуск идемпотентен: цвет ряда считается от цвета меха в дальнем ряду (он не меняется).

  --clean (для основы v1): без просвечиваний в покое — после правки глаз сетка проходит untangle.py (одежда не режет
  тело и себя, сдвиг ≤ 3 мм), затем пучки прядей v1 (BD_FurCards), режущие одежду в покое, убираются целиком
  (связные куски сетки прядей). Проверка — penetration.py.
"""
import os
import subprocess
import tempfile
import sys
import numpy as np
from glb_io import Glb

ROWS = 11
LASH = np.array([0.008, 0.008, 0.014])
# доля подводки по рядам от кромки
TUNE = {
    'kind': {'restUp': 0.1, 'up': [1.0, 1.0, 1.0, 0.9, 0.35], 'lo': [0.75, 0.5, 0.15]},
    'hooligan': {'restUp': 0.22, 'up': [1.0, 1.0, 1.0, 0.7, 0.15], 'lo': [0.7, 0.42, 0.1]},
}


def main():
    cat, src, dst = sys.argv[1:4]
    if cat not in TUNE:
        print(f'{cat}: без изменений'); return
    t = TUNE[cat]
    g = Glb(src); j = g.j
    for n in j['nodes']:
        if n.get('name') in ('Eye_L', 'Eye_R') and 'restUp' in n.get('extras', {}):
            print(f"{cat}: {n['name']} restUp {n['extras']['restUp']} → {t['restUp']}")
            n['extras']['restUp'] = t['restUp']
    for n in j['nodes']:
        nm = n.get('name', '')
        if not (nm.startswith('LidUp_') or nm.startswith('LidLo_')) or 'mesh' not in n:
            continue
        pr = j['meshes'][n['mesh']]['primitives'][0]
        ai = pr['attributes']['COLOR_0']
        c = g.acc(ai).astype(np.float64)
        nv = len(c)
        if nv % ROWS:
            print(f'{cat}: {nm} — {nv} вершин не делится на {ROWS} рядов, пропуск'); continue
        nu = nv // ROWS
        fur = c[5 * nu:6 * nu, :3].copy()  # ряд 5 — чистый мех (подводка не доходит)
        ks = t['up'] if nm.startswith('LidUp_') else t['lo']
        for r in range(5):
            k = ks[r] if r < len(ks) else 0.0
            c[r * nu:(r + 1) * nu, :3] = LASH * k + fur * (1 - k) * (0.97 if nm.startswith('LidUp_') else 1.0)
        g.set_acc(ai, c.astype(np.float32))
        print(f'{cat}: {nm} подводка {ks}')
    g.save(dst)
    if '--clean' in sys.argv:
        here = os.path.dirname(os.path.abspath(__file__))
        tmp = tempfile.mktemp(suffix='.glb')
        subprocess.run([sys.executable, os.path.join(here, 'untangle.py'), cat, dst, tmp], check=True)
        prune_cards(cat, tmp, dst)
        os.remove(tmp)


def prune_cards(cat, src, dst):
    """пучки прядей (связные куски BD_FurCards), режущие одежду в покое, — прочь (только индексы, вершины остаются)"""
    from penetration import Model, tri_pairs_intersect
    from mesh_parts import tri_label
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    md = Model(cat, src)
    g = md.g; j = g.j
    cloth = np.where(tri_label(md.lab, md.I) > 0)[0]
    for n in j['nodes']:
        if 'mesh' not in n or j['meshes'][n['mesh']]['name'] != 'BD_FurCards':
            continue
        pr = j['meshes'][n['mesh']]['primitives'][0]
        P2 = g.acc(pr['attributes']['POSITION']).astype(float)
        I2 = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
        pp = tri_pairs_intersect(P2, I2, md.P, md.I[cloth])
        if not len(pp):
            print(f'{cat}: пряди не режут одежду'); continue
        nv = len(P2)
        e = np.concatenate([I2[:, [0, 1]], I2[:, [1, 2]]])
        _, comp = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(nv, nv)), directed=False)
        bad = np.unique(comp[I2[np.unique(pp[:, 0]), 0]])
        keep = ~np.isin(comp[I2[:, 0]], bad)
        ct = j['accessors'][pr['indices']]['componentType']
        pr['indices'] = g.add_acc(I2[keep].ravel(), ct, 'SCALAR', 34963)
        print(f'{cat}: пряди — убрано {len(bad)} пучков ({(~keep).sum()} треугольников), режущих одежду в покое')
    g.save(dst)


if __name__ == '__main__':
    main()
