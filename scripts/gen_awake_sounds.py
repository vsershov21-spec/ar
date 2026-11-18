#!/usr/bin/env python3
"""Звуки пробуждения кота из карты (src/awake): фанфары, «пуф/дзынь», подъём портала, хлопки салюта.

Всё синтезируется здесь же (numpy/scipy, без сэмплов и банков звуков) — лицензионно чисто: звук целиком наш.
Медь — аддитивный синтез (гармоники с огибающей яркости, «подъезд» высоты в атаке, вибрато с задержкой,
ансамбль из 3 голосов с расстройкой и панорамой); колокольчики/глокеншпиль — негармонические парциалы;
арфа — щипок с затуханием верхних гармоник; литавры, бочка, малый барабан, тарелка — шум и синусы;
всё — через стереоревербератор (свёртка с синтетическим откликом зала) и мягкий лимитер.

Выход: public/sounds/awake.{mp3,m4a} + public/sounds/awake.json (спрайт Howler) и WAV-исходники
в assets-src/audio/awake/. Запуск: python3 scripts/gen_awake_sounds.py  (нужен ffmpeg с libmp3lame и aac).

Позже — ElevenLabs Sound Effects (ключ у продакта): подсказки к каждому звуку — в PROMPTS ниже
(scripts/gen_awake_sounds.py --prompts печатает их); готовый файл кладётся в assets-src/audio/awake/<имя>.wav,
и `python3 scripts/gen_awake_sounds.py --keep-existing` пересоберёт спрайт, не перезаписывая его.
"""
import json, os, subprocess, sys, wave
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public', 'sounds')
SRC = os.path.join(HERE, '..', 'assets-src', 'audio', 'awake')
rng = np.random.default_rng(20261118)

PROMPTS = {
    'rise': 'magical portal opening, rising shimmering chimes and soft reverse cymbal swell, 1.6 seconds, kids cartoon',
    'pop_hooligan': 'spray can psst then cartoon pop and bright zing, playful street style, 0.6 seconds',
    'pop_kind': 'soft bubble bloop bloop and gentle bell ding, cute cartoon, 0.6 seconds',
    'pop_glitter': 'crystal sparkle ding with glittering high chimes, magical, 0.7 seconds',
    'fanfare_hooligan': 'short punchy brass fanfare with kick and snare, cheeky funky ending, 2.5 seconds, kids game',
    'fanfare_kind': 'warm gentle french horn fanfare with glockenspiel and harp, soft and cozy, 2.5 seconds',
    'fanfare_glitter': 'bright sparkling trumpet fanfare with harp glissando and bells, magical celebration, 2.5 seconds',
    'fanfare_short_*': 'tiny ta-dam brass sting, 1 second (per character timbre as above)',
    'boom_*': 'small distant firework pop with soft crackle tail, not loud, 0.9 seconds',
}


# ───────────── основа ─────────────
def tt(d):
    return np.arange(int(round(SR * d))) / SR


def silence(d):
    return np.zeros((int(round(SR * d)), 2))


def sos(kind, f, order=2):
    if isinstance(f, (list, tuple)):
        f = [min(x, SR / 2 * 0.95) for x in f]
    else:
        f = min(f, SR / 2 * 0.95)
    return butter(order, f, btype=kind, fs=SR, output='sos')


def filt(x, kind, f, order=2):
    return sosfilt(sos(kind, f, order), x, axis=0)


def noise(d):
    return rng.uniform(-1, 1, int(round(SR * d)))


def pan(mono, p=0.0):
    """p: -1 лево … 1 право (равная мощность)"""
    a = (p + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)], axis=1)


def adsr(n, a=0.01, d=0.05, s=0.8, r=0.1, hold=None):
    e = np.zeros(n)
    na, nd, nr = max(1, int(a * SR)), max(1, int(d * SR)), max(1, int(r * SR))
    nh = n - na - nd - nr if hold is None else int(hold * SR)
    nh = max(0, nh)
    seg = [np.linspace(0, 1, na, endpoint=False) ** 1.5, np.linspace(1, s, nd, endpoint=False), np.full(nh, s), np.linspace(s, 0, nr) ** 2 * 1.0]
    e2 = np.concatenate(seg)[:n]
    e[: len(e2)] = e2
    return e


class Mix:
    def __init__(self, dur):
        self.buf = np.zeros((int(round(SR * dur)) + SR * 2, 2))
        self.dur = dur

    def add(self, x, at, g=1.0, p=0.0):
        if x.ndim == 1:
            x = pan(x, p)
        i = int(round(at * SR))
        j = min(len(self.buf), i + len(x))
        self.buf[i:j] += x[: j - i] * g

    def render(self, wet=0.22, room=1.5, tail=0.6):
        dry = self.buf[: int(round(SR * (self.dur + tail)))]
        out = dry + reverb(dry, room) * wet
        return out


_IR = {}


def reverb(x, room=1.5):
    if room not in _IR:
        n = int(SR * room)
        t = np.arange(n) / SR
        ir = []
        for ch in range(2):
            nz = rng.standard_normal(n) * np.exp(-t / (room * 0.22))
            nz = filt(nz, 'low', 7000)
            # ранние отражения
            for k in range(8):
                d = int(SR * rng.uniform(0.007, 0.05))
                nz[d] += rng.uniform(0.2, 0.5) * (1 if ch else -1) ** k
            nz[: int(SR * 0.004)] = 0
            ir.append(nz / np.sqrt(np.sum(nz ** 2)))
        _IR[room] = ir
    ir = _IR[room]
    out = np.zeros_like(x)
    for ch in range(2):
        out[:, ch] = fftconvolve(x[:, ch], ir[ch])[: len(x)]
    return out


def master(x, peak_db=-1.0, drive=1.3):
    x = x - np.mean(x, axis=0)
    m = np.max(np.abs(x)) or 1
    x = np.tanh(x / m * drive) / np.tanh(drive)
    x = x * (10 ** (peak_db / 20)) / (np.max(np.abs(x)) or 1)
    # тишину в хвосте (ниже −55 дБ) — обрезать, последние 30 мс — в ноль
    lvl = np.max(np.abs(x), axis=1)
    loud = np.nonzero(lvl > 10 ** (-55 / 20))[0]
    if len(loud):
        x = x[: min(len(x), loud[-1] + int(SR * 0.05))]
    n = int(SR * 0.03)
    x[-n:] *= np.linspace(1, 0, n)[:, None]
    return x


# ───────────── инструменты ─────────────
def brass(f0, dur, bright=1.0, att=0.035, rel=0.12, vib=0.004, scoop=0.03, voices=3, spread=0.5, harm=18, doit=0.0):
    """медная группа: аддитивные гармоники, яркость растёт в атаке; doit — подъезд вверх в конце (в полутонах)"""
    n = int(round(SR * (dur + rel)))
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    env = adsr(n, a=att, d=0.08, s=0.82, r=rel, hold=max(0, dur - att - 0.08))
    # «вздох» атаки: чуть громче в начале
    env *= 1 + 0.25 * np.exp(-t / 0.06)
    b = bright * (0.35 + 0.65 * (1 - np.exp(-t / 0.04))) * (1 - 0.25 * (1 - np.exp(-t / 0.4)))
    for v in range(voices):
        det = 2 ** (((v - (voices - 1) / 2) * 7) / 1200)
        f = f0 * det * (1 - scoop * np.exp(-t / 0.025))
        f = f * (1 + vib * np.sin(2 * np.pi * (5.2 + v * 0.3) * t + v) * np.clip((t - 0.18) / 0.3, 0, 1))
        if doit:
            k = np.clip((t - (dur - 0.25)) / 0.3, 0, 1) ** 2
            f = f * 2 ** (doit * k / 12)
        ph = 2 * np.pi * np.cumsum(f) / SR + rng.uniform(0, 6.28)
        sig = np.zeros(n)
        for h in range(1, harm + 1):
            fh = f0 * h
            if fh > SR * 0.45:
                break
            # спад гармоник зависит от яркости; форманта меди ~1,2 кГц
            amp = h ** (-(2.4 - 1.35 * b)) * (1 + 1.4 * np.exp(-(((fh - 1250) / 800) ** 2)))
            sig += amp * np.sin(h * ph)
        sig *= env
        out += pan(sig, (v - (voices - 1) / 2) * spread / max(1, voices - 1) * 2)
    # дыхание в атаке
    br = filt(noise(n / SR), 'band', [f0 * 2, min(f0 * 8, 9000)]) * np.exp(-t / 0.04) * 0.05
    out += pan(br)
    return out / voices * 0.5


def bell(f0, dur=1.4, g=1.0, kind='glock'):
    t = tt(dur)
    if kind == 'glock':
        ratios, amps, dec = [1, 2.76, 5.40, 8.93], [1, 0.45, 0.22, 0.1], [0.9, 0.35, 0.16, 0.08]
    else:  # «хрусталь»: почти гармонический, долгий звон
        ratios, amps, dec = [1, 2.0, 3.01, 4.2], [1, 0.35, 0.18, 0.1], [1.3, 0.7, 0.4, 0.2]
    s = np.zeros(len(t))
    for r, a, d in zip(ratios, amps, dec):
        s += a * np.sin(2 * np.pi * f0 * r * t + rng.uniform(0, 6)) * np.exp(-t / (d * dur / 1.4))
    s += filt(noise(dur), 'high', 5000) * np.exp(-t / 0.004) * 0.3  # удар молоточка
    a = np.minimum(1, t / 0.002)
    return s * a * g * 0.35


def harp(f0, dur=1.2, g=1.0):
    t = tt(dur)
    s = np.zeros(len(t))
    for h in range(1, 12):
        if f0 * h > SR * 0.45:
            break
        s += (1 / h ** 1.3) * np.sin(2 * np.pi * f0 * h * t * (1 + 0.0004 * h)) * np.exp(-t * (1.6 + h * 1.4))
    s *= np.minimum(1, t / 0.003)
    return s * g * 0.4


def timpani(f0=98, dur=1.2, g=1.0):
    t = tt(dur)
    f = f0 * (1 + 0.08 * np.exp(-t / 0.05))
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t / 0.55) + 0.5 * np.sin(1.5 * ph) * np.exp(-t / 0.3) + 0.3 * np.sin(1.99 * ph) * np.exp(-t / 0.25)
    s += filt(noise(dur), 'low', 900) * np.exp(-t / 0.03) * 0.6
    return s * g * 0.6


def kick(g=1.0):
    t = tt(0.35)
    f = 45 + 110 * np.exp(-t / 0.03)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)
    s += filt(noise(0.35), 'high', 3000) * np.exp(-t / 0.004) * 0.3
    return s * g * 0.9


def snare(g=1.0, dur=0.22):
    t = tt(dur)
    s = filt(noise(dur), 'band', [1500, 7000]) * np.exp(-t / 0.06) * 0.8
    s += np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.04) * 0.6
    return s * g * 0.7


def cymbal(dur=1.6, g=1.0, swell=False):
    t = tt(dur)
    s = filt(noise(dur), 'high', 5500) + 0.4 * filt(noise(dur), 'band', [3000, 6000])
    if swell:  # «обратная» тарелка: нарастание и обрыв
        e = (t / dur) ** 3
        e[-int(SR * 0.01):] *= np.linspace(1, 0, int(SR * 0.01))
    else:
        e = np.exp(-t / (dur * 0.35)) * np.minimum(1, t / 0.002)
    return s * e * g * 0.25


def triangle(f0=2800, dur=1.0, g=1.0):
    t = tt(dur)
    s = sum(np.sin(2 * np.pi * f0 * r * t) * a for r, a in [(1, 1), (2.7, 0.4), (4.1, 0.25)]) * np.exp(-t / 0.5)
    return s * np.minimum(1, t / 0.001) * g * 0.12


def sweep(f0, f1, dur, g=1.0, shape='sin', decay=None):
    t = tt(dur)
    f = np.geomspace(f0, f1, len(t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) if shape == 'sin' else np.sign(np.sin(ph)) * 0.5
    e = np.exp(-t / decay) if decay else np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 0.7
    return s * e * g


def bass(f0, dur, g=1.0):
    t = tt(dur + 0.1)
    s = np.sin(2 * np.pi * f0 * t) + 0.35 * np.sin(4 * np.pi * f0 * t) + 0.12 * np.sin(6 * np.pi * f0 * t)
    return s * adsr(len(t), 0.01, 0.1, 0.7, 0.1) * g * 0.5


N = {}
for i, nm in enumerate(['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']):
    for o in range(1, 8):
        N[f'{nm}{o}'] = 440 * 2 ** ((i - 9 + (o - 4) * 12) / 12)


def chord(m, names, at, dur, g=0.5, **kw):
    for k, nm in enumerate(names):
        m.add(brass(N[nm], dur, **kw), at, g / len(names) ** 0.5, 0)


# ───────────── фанфары ─────────────
def fanfare_hooligan():
    m = Mix(2.6)
    # «па-па-ПАМ … па-па-ПААААМ (ву-у!)» — бодро, с бочкой и малым
    for at, nm in [(0.0, ['D4', 'F#4'.replace('F#', 'Gb'), 'A4']), (0.13, ['D4', 'Gb4', 'A4'])]:
        chord(m, nm, at, 0.08, 0.55, bright=1.15, att=0.012, rel=0.05)
    chord(m, ['D4', 'Gb4', 'A4', 'D5'], 0.27, 0.42, 0.7, bright=1.2, att=0.015)
    m.add(kick(), 0.27, 0.9)
    m.add(snare(), 0.27, 0.6, 0.15)
    for at in (0.86, 0.99):
        chord(m, ['E4', 'G4', 'B4'], at, 0.08, 0.55, bright=1.15, att=0.012, rel=0.05)
        m.add(snare(0.5, 0.12), at, 0.5, -0.2)
    chord(m, ['G4', 'B4', 'D5', 'G5'], 1.13, 1.05, 0.8, bright=1.25, att=0.015, doit=3)
    m.add(kick(), 1.13, 1.0)
    m.add(snare(), 1.13, 0.7, 0.1)
    m.add(cymbal(1.6), 1.13, 0.9, 0.3)
    for at, nm in [(0.27, 'D2'), (1.13, 'G2')]:
        m.add(bass(N[nm], 0.5 if at < 1 else 0.95), at, 0.9)
    # хвостик-«скретч»: короткий свип вверх
    m.add(sweep(300, 1400, 0.16, 0.25, 'sq'), 2.22, 0.5, 0.4)
    return master(m.render(0.18, 1.2))


def fanfare_kind():
    m = Mix(2.7)
    kw = dict(bright=0.7, att=0.06, rel=0.25, vib=0.003, scoop=0.015)
    # тёплые валторны: фа-ля-до … фа-мажорный аккорд, сверху глокеншпиль и арфа
    for at, nm in [(0.0, 'F4'), (0.2, 'A4'), (0.4, 'C5')]:
        m.add(brass(N[nm], 0.26, **kw), at, 0.45)
    chord(m, ['F3', 'C4', 'F4', 'A4', 'C5'], 0.62, 1.55, 0.75, **kw)
    m.add(timpani(N['F2'], 1.4, 0.7), 0.62, 0.8)
    for k, nm in enumerate(['F4', 'A4', 'C5', 'F5', 'A5', 'C6', 'F6']):
        m.add(harp(N[nm], 1.3), 0.62 + k * 0.055, 0.5, -0.4 + k * 0.12)
    for k, nm in enumerate(['C7', 'A6', 'F6', 'C6']):
        m.add(bell(N[nm], 1.2, 0.8), 1.15 + k * 0.17, 0.55, 0.5 - k * 0.3)
    m.add(bell(N['F6'], 1.6, 0.9), 2.0, 0.5, 0)
    return master(m.render(0.28, 1.8), drive=1.1)


def fanfare_glitter():
    m = Mix(2.7)
    kw = dict(bright=1.3, att=0.012, rel=0.15)
    for at, nm in [(0.0, 'C5'), (0.09, 'E5'), (0.18, 'G5')]:
        m.add(brass(N[nm], 0.08, **{**kw, 'rel': 0.05}), at, 0.5)
    m.add(cymbal(0.3, swell=True), 0.0, 0.7)
    chord(m, ['C4', 'E4', 'G4', 'C5', 'E5'], 0.3, 1.5, 0.75, **kw)
    m.add(timpani(N['C2'], 1.2, 0.6), 0.3, 0.6)
    m.add(cymbal(1.8), 0.3, 0.8, -0.3)
    # глиссандо арфы вверх по до-мажору
    sc = ['C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6', 'D6', 'E6', 'F6', 'G6', 'A6', 'B6', 'C7']
    for k, nm in enumerate(sc):
        m.add(harp(N[nm], 0.9, 0.8), 0.32 + k * 0.03, 0.42, -0.6 + k * 0.085)
    # звёздочки: пентатоника высоко, случайно по панораме
    pent = ['C7', 'D7', 'E7', 'G7', 'A7', 'C8' if 'C8' in N else 'A7']
    for k in range(10):
        nm = pent[rng.integers(0, 5)]
        m.add(bell(N[nm] * (1 + rng.uniform(-0.002, 0.002)), 0.9, 0.7, 'crystal'), 0.55 + k * 0.16 + rng.uniform(0, 0.05), 0.32, rng.uniform(-0.8, 0.8))
    m.add(triangle(), 0.3, 1.0, 0.6)
    m.add(triangle(), 1.4, 0.7, -0.6)
    return master(m.render(0.3, 1.8))


def fanfare_short(p):
    m = Mix(1.25)
    if p == 'hooligan':
        chord(m, ['D4', 'Gb4', 'A4'], 0.0, 0.07, 0.55, bright=1.15, att=0.01, rel=0.05)
        chord(m, ['G4', 'B4', 'D5', 'G5'], 0.12, 0.6, 0.75, bright=1.25, att=0.012, doit=2)
        m.add(kick(), 0.12, 0.9)
        m.add(snare(), 0.12, 0.6)
        m.add(cymbal(1.0), 0.12, 0.6, 0.3)
    elif p == 'kind':
        kw = dict(bright=0.7, att=0.05, rel=0.25, scoop=0.015)
        m.add(brass(N['C5'], 0.12, **kw), 0.0, 0.45)
        chord(m, ['F4', 'A4', 'C5'], 0.14, 0.6, 0.7, **kw)
        m.add(bell(N['F6'], 1.0), 0.16, 0.5, 0.3)
        m.add(bell(N['C7'], 0.9), 0.36, 0.4, -0.3)
    else:
        kw = dict(bright=1.3, att=0.012, rel=0.15)
        m.add(brass(N['G5'], 0.07, **{**kw, 'rel': 0.05}), 0.0, 0.5)
        chord(m, ['C5', 'E5', 'G5', 'C6'], 0.11, 0.55, 0.7, **kw)
        for k, nm in enumerate(['C7', 'E7', 'G7', 'C7']):
            m.add(bell(N[nm] * (2 if k == 3 else 1), 0.7, 0.8, 'crystal'), 0.14 + k * 0.07, 0.3, -0.5 + k * 0.33)
    return master(m.render(0.24, 1.2, tail=0.4))


# ───────────── пробуждение ─────────────
def rise():
    m = Mix(1.7)
    # обратная тарелка + низкое «у-у-ух» вверх + ускоряющееся арпеджио колокольчиков
    m.add(cymbal(1.55, swell=True), 0.0, 0.8)
    t = tt(1.55)
    f = 55 * 2 ** (t / 1.55 * 1.2)
    w = np.sin(2 * np.pi * np.cumsum(f) / SR) * (t / 1.55) ** 1.5 * 0.5
    w += filt(noise(1.55), 'band', [200, 900]) * (t / 1.55) ** 2 * 0.25
    m.add(w, 0.0, 0.9)
    pent = ['C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6', 'E6', 'G6', 'A6', 'C7', 'D7', 'E7']
    at = 0.1
    for k, nm in enumerate(pent):
        m.add(bell(N[nm], 0.8, 0.5 + 0.5 * k / len(pent), 'crystal'), at, 0.35, -0.7 + 1.4 * (k % 2))
        at += 0.16 * 0.84 ** k
    return master(m.render(0.3, 1.5, tail=0.3), peak_db=-3)


def puff():
    t = tt(0.25)
    return filt(noise(0.25), 'low', 1400) * np.exp(-t / 0.05) * np.minimum(1, t / 0.006)


def pop(p):
    m = Mix(0.75)
    m.add(puff(), 0.0, 0.8)
    if p == 'hooligan':
        t = tt(0.2)
        m.add(filt(noise(0.2), 'band', [3000, 11000]) * np.sin(np.pi * t / 0.2) ** 0.5, 0.0, 0.5, 0.3)  # «пшш» баллончика
        m.add(sweep(900, 180, 0.12, 0.8, decay=0.04), 0.12, 0.7)
        m.add(sweep(700, 2400, 0.22, 0.25, 'sq'), 0.16, 0.5, -0.3)  # «дзынь» с подъездом
        m.add(bell(N['A6'], 0.6), 0.2, 0.4, 0.2)
    elif p == 'kind':
        for k, (a, b) in enumerate([(260, 820), (340, 1100)]):
            m.add(sweep(a, b, 0.09, 0.8, decay=0.05), 0.05 + k * 0.11, 0.6, -0.3 + k * 0.6)  # «бульк» пузыря
        m.add(bell(N['E6'], 1.0), 0.18, 0.55)
    else:
        for k, nm in enumerate(['C7', 'E7', 'G7']):
            m.add(bell(N[nm] * (1 + 0.003 * k), 1.1, 0.9, 'crystal'), 0.06, 0.4, -0.5 + k * 0.5)
        for k in range(7):
            m.add(bell(N['C7'] * 2 ** (rng.integers(0, 12) / 12) * 2, 0.4, 0.6, 'crystal'), 0.12 + k * 0.045, 0.18, rng.uniform(-0.9, 0.9))
    return master(m.render(0.25, 1.0, tail=0.3), peak_db=-2)


def boom(k):
    m = Mix(1.0)
    t = tt(0.5)
    f = 40 + 60 * np.exp(-t / 0.05)
    th = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12)
    th += filt(noise(0.5), 'low', 700) * np.exp(-t / 0.05) * 0.8
    m.add(th, 0.0, 0.9, [-0.4, 0.3, 0.0][k])
    # треск искр
    for i in range(int(18 + 8 * k)):
        at = 0.08 + rng.exponential(0.18)
        if at > 0.9:
            continue
        c = filt(noise(0.012), 'band', [2500, 9000]) * np.exp(-tt(0.012) / 0.003)
        m.add(c, at, 0.35 * np.exp(-at / 0.5), rng.uniform(-0.9, 0.9))
    return master(m.render(0.3, 1.4, tail=0.3), peak_db=-6)


def build():
    os.makedirs(SRC, exist_ok=True)
    keep = '--keep-existing' in sys.argv
    sounds = {
        'rise': rise,
        'pop_hooligan': lambda: pop('hooligan'),
        'pop_kind': lambda: pop('kind'),
        'pop_glitter': lambda: pop('glitter'),
        'fanfare_hooligan': fanfare_hooligan,
        'fanfare_kind': fanfare_kind,
        'fanfare_glitter': fanfare_glitter,
        'fanfare_short_hooligan': lambda: fanfare_short('hooligan'),
        'fanfare_short_kind': lambda: fanfare_short('kind'),
        'fanfare_short_glitter': lambda: fanfare_short('glitter'),
        'boom_1': lambda: boom(0),
        'boom_2': lambda: boom(1),
        'boom_3': lambda: boom(2),
    }
    clips = {}
    for name, fn in sounds.items():
        path = os.path.join(SRC, name + '.wav')
        if keep and os.path.exists(path):
            clips[name] = read_wav(path)
        else:
            x = fn()
            write_wav(path, x)
            clips[name] = x
        print(f'  {name}: {len(clips[name]) / SR:.2f} с')
    # спрайт: подряд с паузой 250 мс
    gap = silence(0.25)
    parts, sprite, pos = [], {}, 0
    for name, x in clips.items():
        sprite[name] = [round(pos / SR * 1000), round(len(x) / SR * 1000)]
        parts += [x, gap]
        pos += len(x) + len(gap)
    allw = np.concatenate(parts)
    tmp = os.path.join(SRC, '_sprite.wav')
    write_wav(tmp, allw)
    os.makedirs(OUT, exist_ok=True)
    for ext, args in [('mp3', ['-c:a', 'libmp3lame', '-b:a', '96k']), ('m4a', ['-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'])]:
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, *args, os.path.join(OUT, f'awake.{ext}')], check=True)
    os.remove(tmp)
    with open(os.path.join(OUT, 'awake.json'), 'w') as f:
        json.dump({'src': ['awake.mp3', 'awake.m4a'], 'sprite': sprite}, f, ensure_ascii=False, indent=1)
    print('public/sounds/awake.{mp3,m4a,json}:', ', '.join(f'{os.path.getsize(os.path.join(OUT, "awake." + e)) // 1024} КБ' for e in ('mp3', 'm4a')))


def write_wav(path, x):
    x = np.clip(x, -1, 1)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())


def read_wav(path):
    with wave.open(path, 'rb') as w:
        n, ch = w.getnframes(), w.getnchannels()
        d = np.frombuffer(w.readframes(n), '<i2').astype(np.float64) / 32767
    d = d.reshape(-1, ch)
    return d if ch == 2 else np.repeat(d, 2, axis=1)


if __name__ == '__main__':
    if '--prompts' in sys.argv:
        for k, v in PROMPTS.items():
            print(f'{k}: {v}')
        sys.exit(0)
    build()
