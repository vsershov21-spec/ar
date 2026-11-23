/**
 * Опорные лапы не едут по карте (без IK): у клипов Mixamo/T2M горизонталь таза зафиксирована (место кота держит сцена),
 * поэтому перенос веса и переступание в клипе двигают стопы под неподвижным тазом — лапы «скользят» (аудит реакций:
 * до 25 мм за тычок). Здесь — коррекция корня: пока стопа стоит (низко над опорой и почти не движется по высоте),
 * её точку запоминаем, а всё тело сдвигаем по горизонтали так, чтобы стопа осталась на месте; тело при этом покачивается
 * над лапами, как при живом переносе веса. Когда опоры нет (шаг, прыжок) — сдвиг плавно уходит к нулю; при долгой
 * опоре — медленно (≤ 1 мм/с: быстрее — это и было «скольжение» на стенде) возвращается к центру, чтобы кот не уползал со своего места.
 * Единицы — система кота (рост 1, лапы в 0). Чистая логика без three.js — tests/footPin.test.ts.
 */
export interface FootPinConfig {
  /** стопа ниже этой высоты (доли роста) — кандидат в опору */
  plantY: number;
  /** и вертикальная скорость меньше этой (роста/с) */
  plantVy: number;
  /** предел сдвига тела (доли роста) */
  maxOff: number;
  /** время схода сдвига к нулю без опоры, с */
  releaseS: number;
  /** скорость возврата к центру при опоре, роста/с */
  creep: number;
}

export const FOOT_PIN: FootPinConfig = { plantY: 0.035, plantVy: 0.3, maxOff: 0.14, releaseS: 0.3, creep: 0.01 };
/**
 * смена опоры (одна лапа поднялась / встала): цель сдвига тела догоняем за столько секунд. Было 50 мс (k = dt/0,05 —
 * за кадр 2/3 пути): тело с лапами прыгало до 260 мм/с на стенде («Дай лапу» Добряка, 23.11, «ноги как желе»)
 */
export const CATCH_S = 0.08;

interface FootState {
  /** точка, где стопа стоит (в системе кота, уже со сдвигом) */
  ax: number;
  az: number;
  planted: boolean;
  py: number;
}

export class FootPin {
  /** текущий сдвиг тела по горизонтали (система кота) */
  x = 0;
  z = 0;
  private feet: FootState[] = [];
  constructor(private cfg: FootPinConfig = FOOT_PIN) {}

  /** точка опоры стопы i (система кота, со сдвигом тела), если стопа стоит; иначе null — IK стоп (GlbCharacter.pinFeet) */
  anchor(i: number): { x: number; z: number } | null {
    const f = this.feet[i];
    return f?.planted ? { x: f.ax, z: f.az } : null;
  }

  reset() {
    this.feet = [];
    this.x = this.z = 0;
  }

  /**
   * feet — положения стоп этого кадра БЕЗ сдвига (как их поставил клип), [x, y, z] в системе кота; enabled — можно
   * ли сейчас держать лапы (не ходьба, не акробатика, не лёжа). Возвращает сдвиг тела.
   */
  update(dt: number, feet: [number, number, number][], enabled: boolean): { x: number; z: number } {
    const c = this.cfg;
    if (!(dt > 0)) return this;
    let tx = 0, tz = 0, n = 0;
    feet.forEach(([x, y, z], i) => {
      const f = (this.feet[i] ??= { ax: x + this.x, az: z + this.z, planted: false, py: y });
      const vy = Math.abs(y - f.py) / dt;
      f.py = y;
      const planted = enabled && y < c.plantY && vy < c.plantVy;
      if (planted && !f.planted) {
        // встала: запоминаем, где она сейчас видна (с текущим сдвигом)
        f.ax = x + this.x;
        f.az = z + this.z;
      }
      f.planted = planted;
      if (!planted) return;
      // медленный возврат к центру: точка опоры ползёт к положению стопы без сдвига
      const ex = x - f.ax, ez = z - f.az;
      const el = Math.hypot(ex, ez);
      if (el > 1e-6) {
        const k = Math.min(1, (c.creep * dt) / el);
        f.ax += ex * k;
        f.az += ez * k;
      }
      tx += f.ax - x;
      tz += f.az - z;
      n++;
    });
    if (n) {
      tx /= n;
      tz /= n;
      // смена опоры (одна лапа поднялась) — цель сдвигается: догоняем плавно (CATCH_S), без рывка тела
      const k = 1 - Math.exp(-dt / CATCH_S);
      this.x += (tx - this.x) * k;
      this.z += (tz - this.z) * k;
    } else {
      const k = Math.exp(-dt / c.releaseS);
      this.x *= k;
      this.z *= k;
    }
    const l = Math.hypot(this.x, this.z);
    if (l > c.maxOff) {
      this.x *= c.maxOff / l;
      this.z *= c.maxOff / l;
    }
    return this;
  }
}
