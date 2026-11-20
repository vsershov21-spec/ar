/**
 * Процедурный реквизит шаблона «держать предмет» (holdAction.ts): рыбка-угощение и пластинка жвачки.
 * Модели Tripo для них ещё нет (scripts/models/t2m_prompts_v2.json: treat_snack — «нужна»). Ось Y — длина предмета,
 * низ (y = 0) — то место, за которое берут (хвост рыбки, край пластинки); лицевая сторона — +Z.
 */
import * as THREE from 'three';

export function makeFish(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'fish';
  const body = new THREE.MeshStandardMaterial({ color: '#7fc4ff', roughness: 0.45, metalness: 0.1 });
  const fin = new THREE.MeshStandardMaterial({ color: '#ff9f6b', roughness: 0.6 });
  const eye = new THREE.MeshStandardMaterial({ color: '#16202a', roughness: 0.3 });
  // тело — вытянутая сфера вдоль Y, хвост внизу
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), body);
  b.scale.set(0.42, 1, 0.3);
  b.position.y = 1.15;
  g.add(b);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.55, 3), fin);
  tail.scale.set(1, 1, 0.35);
  tail.position.y = 0.32;
  g.add(tail);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), eye);
    e.position.set(s * 0.15, 1.42, 0.1);
    g.add(e);
  }
  return g;
}

export function makeGum(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'gum';
  const pink = new THREE.MeshStandardMaterial({ color: '#ff7eb6', roughness: 0.5 });
  const wrap = new THREE.MeshStandardMaterial({ color: '#B5E36A', roughness: 0.7 });
  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1, 0.08), pink);
  stick.position.y = 0.5;
  g.add(stick);
  const w = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.38, 0.1), wrap);
  w.position.y = 0.19;
  g.add(w);
  return g;
}
