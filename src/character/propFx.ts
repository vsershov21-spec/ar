/**
 * 3D-эффекты реквизита рядом с лапой (в системе кота, не на стекле): пар над кружкой какао и искра появления/ухода
 * предмета (какао, зеркальце, рыбка, доска скейта). Спрайты с процедурными текстурами (canvas), без загрузок.
 * Положение задаёт GlbCharacter каждый кадр: steamAt — край кружки, sparkAt — кулак; сила 0…1.
 */
import * as THREE from 'three';

let steamTex: THREE.Texture | null = null;
let starTex: THREE.Texture | null = null;
function tex(kind: 'steam' | 'star'): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  if (kind === 'steam' && steamTex) return steamTex;
  if (kind === 'star' && starTex) return starTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  if (kind === 'steam') {
    const r = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    r.addColorStop(0, 'rgba(255,255,255,0.9)');
    r.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  } else {
    // четырёхлучевая звёздочка с мягким ореолом
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    r.addColorStop(0, 'rgba(255,255,240,1)');
    r.addColorStop(0.25, 'rgba(255,236,150,0.55)');
    r.addColorStop(1, 'rgba(255,220,120,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#fffbe6';
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, rr = i % 2 ? 4 : 30;
      g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr);
    }
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (kind === 'steam') steamTex = t;
  else starTex = t;
  return t;
}

const STEAM_N = 5;
const STAR_N = 9;

export class PropFx {
  readonly group = new THREE.Group();
  private steam: THREE.Sprite[] = [];
  private stars: THREE.Sprite[] = [];
  private t = 0;
  /** сила пара/искры этого кадра (для стенда) */
  steamK = 0;
  sparkK = 0;

  constructor() {
    this.group.name = 'propFx';
    for (let i = 0; i < STEAM_N; i++) {
      const m = new THREE.SpriteMaterial({ map: tex('steam'), color: '#ffffff', transparent: true, depthWrite: false, opacity: 0 });
      const s = new THREE.Sprite(m);
      s.visible = false;
      s.renderOrder = 3;
      this.steam.push(s);
      this.group.add(s);
    }
    for (let i = 0; i < STAR_N; i++) {
      const m = new THREE.SpriteMaterial({ map: tex('star'), color: i % 3 ? '#fff3b0' : '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      const s = new THREE.Sprite(m);
      s.visible = false;
      s.renderOrder = 4;
      this.stars.push(s);
      this.group.add(s);
    }
  }

  /**
   * кадр: steamAt — край кружки (система group), steam 0…1, size — диаметр кружки; sparkAt — точка искры, spark 0…1
   * (прогресс вспышки; 0 — нет), sparkR — радиус разлёта
   */
  update(dt: number, o: { steamAt?: THREE.Vector3 | null; steam?: number; size?: number; sparkAt?: THREE.Vector3 | null; spark?: number; sparkR?: number }) {
    this.t += dt;
    const sk = o.steamAt ? Math.max(0, Math.min(1, o.steam ?? 0)) : 0;
    this.steamK = sk;
    const sz = o.size ?? 0.06;
    this.steam.forEach((s, i) => {
      if (sk < 0.01 || !o.steamAt) return void (s.visible = false);
      // струйка: каждый клуб поднимается за 1,3 с, растёт и тает, слегка виляет
      const ph = (this.t / 1.3 + i / STEAM_N) % 1;
      const wob = Math.sin((this.t + i) * 2.6) * sz * 0.18;
      s.position.set(o.steamAt.x + wob, o.steamAt.y + ph * sz * 1.6, o.steamAt.z + Math.cos((this.t + i) * 2.1) * sz * 0.1);
      s.scale.setScalar(sz * (0.45 + 0.9 * ph));
      (s.material as THREE.SpriteMaterial).opacity = sk * 0.8 * Math.sin(ph * Math.PI);
      s.visible = true;
    });
    const k = o.sparkAt ? o.spark ?? 0 : 0;
    this.sparkK = k > 0 && k < 1 ? Math.sin(k * Math.PI) : 0;
    const R = o.sparkR ?? 0.08;
    this.stars.forEach((s, i) => {
      if (!(k > 0 && k < 1) || !o.sparkAt) return void (s.visible = false);
      const a = (i / STAR_N) * Math.PI * 2 + k * 1.5;
      const el = ((i * 37) % 7) / 7 - 0.5;
      const r = R * (0.25 + 0.75 * Math.sqrt(k)) * (0.7 + 0.3 * ((i * 13) % 5) / 5);
      s.position.set(o.sparkAt.x + Math.cos(a) * r, o.sparkAt.y + el * r * 1.2 + Math.sin(a) * r * 0.5, o.sparkAt.z + Math.sin(a) * r * 0.6);
      s.scale.setScalar(R * 0.45 * Math.sin(k * Math.PI) * (i % 3 ? 0.7 : 1.1));
      (s.material as THREE.SpriteMaterial).opacity = Math.sin(k * Math.PI);
      s.material.rotation = k * 3 + i;
      s.visible = true;
    });
  }

  hide() {
    for (const s of [...this.steam, ...this.stars]) s.visible = false;
    this.steamK = this.sparkK = 0;
  }
}
