#!/usr/bin/env python3
"""Одежда — отдельными мешами (последняя стадия, после fur_volume): кепка, худи, шарф, бант, обувь из спаянной сетки Tripo.

  python3 scripts/models/split_parts.py <cat> in.glb out.glb

Треугольники размечаются по частям (mesh_parts.label_parts + tri_label), каждая часть — свой меш и узел
(Cap_Hooligan, Hoodie_Hooligan, Shoes_Hooligan, Hoodie_Kind, Scarf_Kind, Boots_Kind, Hoodie_Glitter, Bow_Glitter) со своими
компактными буферами (только свои вершины; позиции на шве совпадают — щелей нет; ключи — sparse-подмножества).
Тот же материал, те же ключи (рот/щёки двигают и край капюшона, если задевают). Имена — как в content/src/<cat>.meta.json
(outfit.meshes / glb.show) и BodyCollider (Cap_*, Scarf_*, Bow_*): прокси работают, пока меш виден.
Наушники (headphones.py) и фатин (tulle.py) — уже отдельные меши.
"""
import sys
import numpy as np
from glb_io import Glb
from mesh_parts import label_parts, tri_label, BODY, CAP, HOODIE, PHONES, SCARF, BOW, SKIRT, SHOES

NAMES = {
    'hooligan': {CAP: 'Cap_Hooligan', HOODIE: 'Hoodie_Hooligan', SHOES: 'Shoes_Hooligan', PHONES: 'Hoodie_Hooligan'},
    'kind': {HOODIE: 'Hoodie_Kind', SCARF: 'Scarf_Kind', SHOES: 'Boots_Kind'},
    'glitter': {HOODIE: 'Hoodie_Glitter', BOW: 'Bow_Glitter', SKIRT: 'Hoodie_Glitter'},
}


def main():
    cat, src, dst = sys.argv[1:4]
    g = Glb(src); j = g.j
    bi, b = g.main_mesh()
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    lab = label_parts(cat, g, b, P, I)
    lt = tri_label(lab, I)
    bnode = next(i for i, n in enumerate(j['nodes']) if n.get('mesh') == bi)
    parent = next((n for n in j['nodes'] if bnode in n.get('children', [])), None)
    groups = {}
    for part, name in NAMES[cat].items():
        groups.setdefault(name, []).append(part)
    taken = np.zeros(len(I), bool)
    sel = {}
    for name, parts in groups.items():
        m = np.isin(lt, parts)
        if m.sum() >= 20:
            sel[name] = m; taken |= m
    # у каждой части — свои компактные буферы (только свои вершины): рантайм (BodyCollider, прокси одежды из меша)
    # перебирает все вершины буфера меша — общий буфер дал бы кепке вершины всего тела
    si = next(i for i, m_ in enumerate(j['meshes']) if m_['name'] == 'BD_FurShell')
    sh = j['meshes'][si]['primitives'][0]
    Ish = g.acc(sh['indices']).reshape(-1, 3).astype(np.int64)
    attrs = b['attributes']
    tg = b.get('targets', [])
    A = {k: g.acc(v) for k, v in attrs.items()}
    T = [g.acc(t['POSITION']).astype(np.float32) for t in tg]
    furlen = g.acc(sh['attributes']['_FURLEN']).astype(np.float32)

    def subset(vs):
        out = {}
        for k, arr in A.items():
            acc = j['accessors'][attrs[k]]
            ai = g.add_acc(arr[vs], acc['componentType'], acc['type'], 34962)
            if acc.get('normalized'):
                j['accessors'][ai]['normalized'] = True
            out[k] = ai
        tl = []
        for D in T:
            D = D[vs]
            nz = np.where(np.abs(D).max(1) > 1e-7)[0]
            acc = {'componentType': 5126, 'count': int(len(vs)), 'type': 'VEC3', 'min': D.min(0).tolist(), 'max': D.max(0).tolist()}
            if len(nz):
                ii = g.add_acc(nz.astype(np.uint32), 5125, 'SCALAR'); vv = g.add_acc(D[nz], 5126, 'VEC3')
                acc['sparse'] = {'count': int(len(nz)), 'indices': {'bufferView': j['accessors'][ii]['bufferView'], 'componentType': 5125},
                                 'values': {'bufferView': j['accessors'][vv]['bufferView']}}
                j['accessors'].pop(); j['accessors'].pop()
            j['accessors'].append(acc)
            tl.append({'POSITION': len(j['accessors']) - 1})
        return out, tl

    def remap(vs, tris):
        r = -np.ones(len(P), np.int64); r[vs] = np.arange(len(vs))
        return r[tris]
    src_mesh = j['meshes'][bi]
    for name, m in sel.items():
        vs = np.unique(I[m].ravel())
        at, tl = subset(vs)
        ct, ctype = (np.uint16, 5123) if len(vs) < 65535 else (np.uint32, 5125)
        prim = {'attributes': at, 'indices': g.add_acc(remap(vs, I[m]).ravel().astype(ct), ctype, 'SCALAR', 34963), 'material': b['material']}
        if tl:
            prim['targets'] = tl
        mesh = {'name': name, 'primitives': [prim]}
        if src_mesh.get('extras'):
            mesh['extras'] = dict(src_mesh['extras'])
        if src_mesh.get('weights'):
            mesh['weights'] = list(src_mesh['weights'])
        j['meshes'].append(mesh)
        j['nodes'].append({'name': name, 'mesh': len(j['meshes']) - 1, 'skin': j['nodes'][bnode]['skin'], 'extras': {'part': name}})
        (parent['children'] if parent is not None else j['scenes'][0]['nodes']).append(len(j['nodes']) - 1)
        print(f'{cat}: {name} — {m.sum()} треугольников, {len(vs)} вершин')
    # тело: свои вершины + вершины мех-оболочек (оболочки делят буферы с телом)
    Ib = I[~taken]
    vs = np.unique(np.r_[Ib.ravel(), Ish.ravel()])
    at, tl = subset(vs)
    ct, ctype = (np.uint16, 5123) if len(vs) < 65535 else (np.uint32, 5125)
    b['attributes'] = at
    b['indices'] = g.add_acc(remap(vs, Ib).ravel().astype(ct), ctype, 'SCALAR', 34963)
    if tl:
        b['targets'] = tl
    sh['attributes'] = dict(at)
    sh['attributes']['_FURLEN'] = g.add_acc(furlen[vs], 5126, 'SCALAR', 34962)
    sh['indices'] = g.add_acc(remap(vs, Ish).ravel().astype(ct), ctype, 'SCALAR', 34963)
    if tl:
        sh['targets'] = [{'POSITION': t['POSITION']} for t in tl]
    print(f'{cat}: тело — {len(Ib)} треугольников, {len(vs)} вершин (из {len(P)})')
    g.save(dst)


if __name__ == '__main__':
    main()
