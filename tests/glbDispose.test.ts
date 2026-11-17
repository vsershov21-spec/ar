import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { disposeObject } from '../src/character/glbCharacter';

describe('смена кота освобождает GPU-ресурсы', () => {
  it('disposeObject: геометрия, материалы (и перекраски), текстуры — по одному разу', () => {
    const tex = new THREE.Texture();
    const mat = new THREE.MeshStandardMaterial({ map: tex, normalMap: tex });
    const tint = mat.clone();
    const geo = new THREE.BufferGeometry();
    const a = new THREE.Mesh(geo, tint);
    a.userData.origMat = mat;
    a.userData.tintMat = tint;
    const b = new THREE.Mesh(geo, mat); // общая геометрия и материал у двух мешей
    const root = new THREE.Group();
    root.add(a, b);
    const n = { tex: 0, mat: 0, tint: 0, geo: 0 };
    tex.addEventListener('dispose', () => n.tex++);
    mat.addEventListener('dispose', () => n.mat++);
    tint.addEventListener('dispose', () => n.tint++);
    geo.addEventListener('dispose', () => n.geo++);
    disposeObject(root);
    expect(n).toEqual({ tex: 1, mat: 1, tint: 1, geo: 1 });
  });
});
