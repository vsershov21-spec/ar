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
  // кончик щетины: ось +Y (character/props.ts PropRig.tip / aim)
  g.add(tip(0, 0.99, 0, [0, 1, 0], [0, 0, 1]));
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
  // сопло: краска идёт по +Z колпачка
  g.add(tip(0, 0.92, 0.11, [0, 0, 1], [0, 1, 0]));
  return g;
}

/** метка сопла / кончика: dir — куда идёт краска, up — «верх» инструмента (для наведения) */
function tip(x: number, y: number, z: number, dir: [number, number, number], up: [number, number, number]) {
  const t = new THREE.Object3D();
  t.name = 'tip';
  t.position.set(x, y, z);
  t.userData.dir = dir;
  t.userData.up = up;
  return t;
}

/**
 * Банка краски (Добряк, Блёстка макают кисть): стоит на столе у дальнего края карты. Высота ≈ 0,09 ширины карты,
 * краска сверху — цвет выбранного кружка. Корень — дно, ось +Z — вверх (плоскость карты XY).
 */
export function makePaintPot(color: string, glitter = false): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'paint-pot';
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.08, 24, 1, true), mat(0xf4f6fa, { roughness: 0.35, metalness: 0.4, side: THREE.DoubleSide }));
  body.rotation.x = Math.PI / 2;
  body.position.z = 0.04;
  g.add(body);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0505, 0.0485, 0.03, 24, 1, true), mat(color, { roughness: 0.4 }));
  band.rotation.x = Math.PI / 2;
  band.position.z = 0.035;
  g.add(band);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.004, 8, 28), mat(0xc9ced6, { metalness: 0.7, roughness: 0.3 }));
  rim.position.z = 0.08;
  g.add(rim);
  const top = new THREE.Mesh(new THREE.CircleGeometry(0.048, 24), mat(color, { roughness: glitter ? 0.15 : 0.25, metalness: glitter ? 0.6 : 0, emissive: glitter ? color : 0x000000, emissiveIntensity: glitter ? 0.25 : 0 }));
  top.name = 'paint';
  top.position.z = 0.072;
  g.add(top);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.045, 24), mat(0xc9ced6));
  bottom.rotation.x = Math.PI;
  bottom.position.z = 0.001;
  g.add(bottom);
  return g;
}
