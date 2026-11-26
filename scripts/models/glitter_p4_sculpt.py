"""Блёстка p4 v3, стадия 1б (без Blender, до ушей/хвоста rig_cat.py): форма головы по наложению на разворот продакта
(tools/glitter-p4-overlay.py). Продакт: «больше на зайца похожа, нежели на кота». По наложению с рефом у Tripo-модели
лицо крупно для головы и роста: межглазье 0.168 роста (реф 0.136), голова на уровне глаз 2.15 межглазья (реф 2.96),
у висков клином, нос ниже на ~0.08 межглазья, крупнее и выпуклее.

    python3 scripts/models/glitter_p4_sculpt.py /tmp/p4/joined.glb /tmp/p4/sculpt.glb

Поле смещений (позиции и нормали — через якобиан поля, J^-T n) только для частей головы (голова, уши, глаза, брови,
нос, морда, рот, бант и звёзды у висков):
  1. «лицо меньше, голова круглее»: сферические координаты вокруг центра головы O. Радиус ×S (по направлению: вниз к шее
     и назад к капюшону — меньше), угол от оси лица ×KF в зоне лица (глаза, нос, рот ближе друг к другу и меньше —
     межглазье к росту как у рефа), к бокам и затылку — плавно к ×1; макушка — ещё ×UP, виски — ×TEMPLE.
  3. Уши: ×EAR_K от основания и наружу на EAR_OUT. Щёки внизу по бокам — ещё ×JOWL (низ головы круглый, не клином),
     макушка между ушами — ×CROWN; уши наклонены наружу на EAR_ROT.
  2. Нос: выше на NOSE_UP, уже (×NOSE_KX) вокруг своей середины, выпуклость ×NOSE_Z — маленький нос как на рефе.
"""
import sys, os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from face_detail import G2  # noqa: E402

HEAD_PARTS = {0, 5, 6, 15, 16, 17, 19, 20, 21, 22, 24, 25, 26, 27, 28, 30, 31}
P = dict(S=1.04, KF=0.78, O=(0.0, 0.70, 0.03), TH0=48.0, TH1=100.0, BACK=0.55, NECK=(-0.9, -0.35),
         UP=1.06, NOSE_UP=0.011, NOSE_KX=0.86, NOSE_KY=1.06, NOSE_Z=0.75, NOSE_C=(0.0, 0.683, 0.19),
         EAR_K=1.1, EAR_OUT=0.0, EAR_ROT=0.0, JOWL=1.0, CROWN=1.05, TEMPLE=1.1)
P.update(json.loads(os.environ.get('P4_SCULPT', '{}')))


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def field_head(X):
    O = np.array(P['O']); S = P['S']
    d = X - O
    r = np.linalg.norm(d, axis=1) + 1e-12
    u = d / r[:, None]
    th = np.degrees(np.arccos(np.clip(u[:, 2], -1, 1)))  # угол от оси лица (+z)
    # радиус: к шее (вниз) и к затылку (назад, капюшон) растёт меньше
    a = smooth(P['NECK'][0], P['NECK'][1], u[:, 1]) * (P['BACK'] + (1 - P['BACK']) * smooth(-0.9, 0.1, u[:, 2]))
    s = (1 + (S - 1) * a) * (1 + (P['UP'] - 1) * smooth(0.3, 0.9, u[:, 1]))  # макушка — выше (реф)
    # щёки внизу по бокам — шире (у рефа низ головы круглый, у Tripo — клином к подбородку)
    s *= 1 + (P['JOWL'] - 1) * smooth(-0.85, -0.45, u[:, 1]) * (1 - smooth(-0.2, 0.15, u[:, 1])) * smooth(0.3, 0.8, np.abs(u[:, 0]))
    # макушка шире между ушами (у рефа — круглая, у Tripo — клином под бант)
    s *= 1 + (P['CROWN'] - 1) * smooth(0.2, 0.5, u[:, 1]) * (1 - smooth(0.75, 0.95, u[:, 1])) * smooth(0.2, 0.6, np.abs(u[:, 0]))
    # виски (на уровне глаз по бокам) шире
    s *= 1 + (P['TEMPLE'] - 1) * smooth(-0.35, -0.05, u[:, 1]) * (1 - smooth(0.35, 0.6, u[:, 1])) * smooth(0.4, 0.85, np.abs(u[:, 0]))
    # угол: в зоне лица ×KF (лицо меньше: межглазье к росту как у рефа), к бокам → ×1
    k = P['KF'] + (1 - P['KF']) * smooth(P['TH0'], P['TH1'], th)
    k = 1 + (k - 1) * a  # у шеи — без поворота
    th2 = np.radians(th * k)
    phi = np.arctan2(u[:, 1], u[:, 0])
    sn = np.sin(th2)
    u2 = np.stack([sn * np.cos(phi), sn * np.sin(phi), np.cos(th2)], 1)
    return O + u2 * (r * s)[:, None]


def field_nose(X, is_nose):
    """нос: подъём (плавно — и голова вокруг дыры носа) и уменьшение самой части носа"""
    C = np.array(P['NOSE_C'])
    d = X - C
    w = np.exp(-((d[:, 0] / 0.03) ** 2 + (d[:, 1] / 0.022) ** 2)) * smooth(0.10, 0.15, X[:, 2])
    Y = X.copy()
    Y[:, 1] += P['NOSE_UP'] * w
    if is_nose is not None:
        m = is_nose
        c = X[m].mean(0)
        q = X[m] - c
        q[:, 0] *= P['NOSE_KX']; q[:, 1] *= P['NOSE_KY']
        # выпуклость: вдоль z к основанию носа
        z0 = X[m][:, 2].min()
        q[:, 2] = (X[m][:, 2] - z0) * P['NOSE_Z'] + z0 - c[2] - 0.0015
        Y[m] = c + q + np.array([0, P['NOSE_UP'], 0])
    return Y


def apply(X, is_nose):
    Y = field_head(X)
    return field_nose(Y, is_nose)


def jac_normals(X, N, is_nose, h=1e-4):
    """нормали через якобиан поля: n' = J^-T n"""
    J = np.zeros((len(X), 3, 3))
    for k in range(3):
        e = np.zeros(3); e[k] = h
        J[:, :, k] = (apply(X + e, is_nose) - apply(X - e, is_nose)) / (2 * h)
    Jt = np.linalg.inv(J).transpose(0, 2, 1)
    n2 = np.einsum('nij,nj->ni', Jt, N)
    return n2 / (np.linalg.norm(n2, axis=1, keepdims=True) + 1e-12)


def main():
    src, dst = sys.argv[1:3]
    g = G2(src); j = g.j
    moved = 0
    for p in j['meshes'][0]['primitives']:
        name = j['materials'][p['material']]['name'].split('_material')[0]
        idx = int(name.split('_')[-1]) if name.startswith('tripo_part_') else -1
        if idx not in HEAD_PARTS:
            continue
        A = p['attributes']
        X = g.acc(A['POSITION']).astype(np.float64)
        N = g.acc(A['NORMAL']).astype(np.float64)
        isn = np.ones(len(X), bool) if idx == 28 else None
        if idx == 28:
            # нос — твёрдо: поле головы в центре носа (сдвиг), затем подъём/уменьшение
            c = X.mean(0)
            Y = X + (field_head(c[None])[0] - c)
            Y = field_nose(Y, isn)
            N2 = N.copy()
        else:
            Y = apply(X, None)
            N2 = jac_normals(X, N, None)
        if idx in (5, 6):
            # уши крупнее от основания и чуть наружу (реф: большие треугольные уши шире на макушке)
            b = Y[Y[:, 1] <= np.percentile(Y[:, 1], 15)].mean(0)
            a_ = np.radians(P['EAR_ROT']) * -np.sign(b[0])  # наклон наружу (вокруг оси вперёд)
            R = np.array([[np.cos(a_), -np.sin(a_), 0], [np.sin(a_), np.cos(a_), 0], [0, 0, 1]])
            Y = b + ((Y - b) * P['EAR_K']) @ R.T + np.array([np.sign(b[0]) * P['EAR_OUT'], 0, 0])
            N2 = N2 @ R.T
        g.set_acc(A['POSITION'], Y.astype(np.float32)); g.set_acc(A['NORMAL'], N2.astype(np.float32))
        moved += len(X)
        print(f'{name}: {len(X)} верш., сдвиг до {np.linalg.norm(Y - X, axis=1).max() * 1000:.1f} мм')
    j.setdefault('asset', {}).setdefault('extras', {})['glitterP4Sculpt'] = P
    total = g.save(dst)
    print(f'→ {dst} {total / 1e6:.2f} MB; вершин головы {moved}; параметры {json.dumps(P)}')


if __name__ == '__main__':
    main()
