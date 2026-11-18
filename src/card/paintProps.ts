/**
 * Реквизит раскраски карты — процедурный (модели Meshy/Tripo — позже): кисть (Добряк, Блёстка) и баллончик (Хулиган).
 * Ось +Y — от хвата к кончику, хват — низ модели (character/props.ts PropRig: высота нормируется по size).
 * Части с материалом 'paint' (щетина кисти, корпус баллончика) PropRig.hold перекрашивает в выбранный цвет.
 */
import * as THREE from 'three';

const mat = (color: number | string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...o });

function part(geo: THREE.BufferGeometry, m: THREE.Material, y: number) {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.y = y;
  return mesh;
}

/** кисть: деревянная ручка с белым кончиком, металлическая обойма, пухлая щетина цвета краски */
export function makeBrush(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'paint_brush';
  g.add(part(new THREE.CylinderGeometry(0.07, 0.085, 0.5, 14), mat(0xd9894a, { roughness: 0.45 }), 0.27));
  g.add(part(new THREE.SphereGeometry(0.085, 14, 8), mat(0xffffff), 0.02));
  g.add(part(new THREE.CylinderGeometry(0.11, 0.08, 0.13, 16), mat(0xd3d8e0, { metalness: 0.75, roughness: 0.25 }), 0.585));
  const bristle = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.105, 0),
      new THREE.Vector2(0.15, 0.07),
      new THREE.Vector2(0.155, 0.15),
      new THREE.Vector2(0.115, 0.24),
      new THREE.Vector2(0.05, 0.31),
      new THREE.Vector2(0.0, 0.34),
    ],
    16,
  );
  const paint = mat(0xff4fa8, { roughness: 0.3 });
  paint.name = 'paint';
  g.add(part(bristle, paint, 0.65));
  return g;
}

/** баллончик: корпус цвета краски с белой полосой, серые плечики, белый колпачок с соплом */
export function makeSpray(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'paint_spray';
  const paint = mat(0xa8f03a, { roughness: 0.35, metalness: 0.15 });
  paint.name = 'paint';
  const grey = mat(0xc9ced6, { metalness: 0.7, roughness: 0.3 });
  g.add(part(new THREE.CylinderGeometry(0.27, 0.27, 0.04, 24), grey, 0.02));
  g.add(part(new THREE.CylinderGeometry(0.27, 0.27, 0.6, 24), paint, 0.34));
  g.add(part(new THREE.CylinderGeometry(0.274, 0.274, 0.12, 24), mat(0xffffff, { roughness: 0.4 }), 0.36));
  const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.27, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), grey);
  shoulder.scale.y = 0.45;
  shoulder.position.y = 0.64;
  g.add(shoulder);
  g.add(part(new THREE.CylinderGeometry(0.09, 0.1, 0.1, 14), grey, 0.8));
  g.add(part(new THREE.BoxGeometry(0.16, 0.12, 0.16), mat(0xffffff, { roughness: 0.4 }), 0.9));
  const nozzle = part(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 8), mat(0x222222), 0.92);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.z = 0.08;
  g.add(nozzle);
  return g;
}
