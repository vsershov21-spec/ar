#!/usr/bin/env python3
"""Процедурные звуки-заглушки для прототипа.

Генерирует отдельные WAV в assets-src/audio/<имя>.wav и общий аудиоспрайт
public/sounds/sfx.{webm,mp3} + public/sounds/sfx.json (карта спрайта для Howler).
Чтобы заменить звук записанным: положите файл с тем же именем в assets-src/audio/
(WAV 44.1 кГц моно/стерео) и запустите `npm run gen-sounds -- --keep-existing` —
скрипт пересоберёт спрайт, не перезаписывая ваши файлы.
"""
import json, os, subprocess, sys, wave
import numpy as np

SR = 44100
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'sounds')
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets-src', 'audio')
rng = np.random.default_rng(7)


def t(d):
    return np.arange(int(SR * d)) / SR


def env(n, a=0.005, r=0.1, shape=1.0):
    e = np.ones(n)
    na = max(1, int(a * SR)); nr = max(1, int(r * SR))
    e[:na] = np.linspace(0, 1, na)
    if nr < n:
        e[-nr:] *= np.linspace(1, 0, nr) ** shape
    return e


def noise(d):
    return rng.uniform(-1, 1, int(SR * d))


def lp(x, k=8):
    return np.convolve(x, np.ones(k) / k, mode='same')


def hp(x, k=8):
    return x - lp(x, k)


def sweep(f0, f1, d, kind='sin'):
    tt = t(d)
    f = np.geomspace(f0, f1, len(tt))
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) if kind == 'sin' else np.sign(np.sin(ph))


def knock():
    tt = t(0.09)
    body = np.sin(2 * np.pi * 180 * tt) * np.exp(-tt * 60) + 0.5 * np.sin(2 * np.pi * 420 * tt) * np.exp(-tt * 90)
    click = hp(noise(0.09), 3) * np.exp(-t(0.09) * 300) * 0.6
    return body + click


def s_glass_knock():
    gap = np.zeros(int(SR * 0.12))
    return np.concatenate([knock(), gap, knock() * 0.9])


def s_gum_pop():
    tt = t(0.25)
    burst = noise(0.25) * np.exp(-tt * 40)
    thump = np.sin(2 * np.pi * 90 * tt) * np.exp(-tt * 25)
    return lp(burst, 4) * 0.9 + thump * 0.8


def s_gum_chew():
    out = []
    for i in range(3):
        d = 0.16
        x = lp(noise(d), 20) * env(int(SR * d), 0.02, 0.1) * 2.5
        x += 0.3 * np.sin(2 * np.pi * 140 * t(d)) * env(int(SR * d), 0.02, 0.1)
        out += [x, np.zeros(int(SR * 0.07))]
    return np.concatenate(out)


def s_gum_blow():
    d = 1.4
    x = lp(noise(d), 30) * np.linspace(0.2, 1, int(SR * d)) * 2
    x += 0.15 * sweep(120, 260, d)
    return x * env(int(SR * d), 0.1, 0.1)


def s_gum_splat():
    d = 0.35
    x = lp(noise(d), 12) * np.exp(-t(d) * 12) * 1.5
    return x + 0.4 * sweep(300, 60, d) * np.exp(-t(d) * 10)


def s_glass_squeak():
    d = 0.5
    f = 900 + 250 * np.sin(2 * np.pi * 7 * t(d))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) + 0.3 * np.sin(2 * ph)
    return x * env(int(SR * d), 0.03, 0.15) * 0.6


def s_claws():
    out = []
    for i in range(3):
        d = 0.18
        x = hp(noise(d), 2) * np.sin(np.linspace(0, np.pi, int(SR * d))) * 0.8
        x += 0.2 * sweep(2500, 1200, d)
        out += [x, np.zeros(int(SR * 0.03))]
    return np.concatenate(out)


def s_glitter():
    d = 0.9
    x = np.zeros(int(SR * d))
    for i in range(14):
        f = rng.uniform(2200, 5200); st = int(rng.uniform(0, d - 0.15) * SR)
        tt = t(0.15)
        x[st:st + len(tt)] += np.sin(2 * np.pi * f * tt) * np.exp(-tt * 35) * 0.35
    return x


def s_sparkle_trail():
    d = 0.5
    return sweep(1800, 4200, d) * env(int(SR * d), 0.02, 0.3) * 0.3 + s_glitter()[: int(SR * d)] * 0.5


def s_purr():
    d = 1.6
    tt = t(d)
    am = 0.5 + 0.5 * np.sin(2 * np.pi * 24 * tt)
    x = lp(noise(d), 40) * am * 3 + 0.2 * np.sin(2 * np.pi * 50 * tt) * am
    return x * env(len(tt), 0.2, 0.4)


def s_sticker_peel():
    d = 0.45
    x = hp(noise(d), 3) * (0.3 + 0.7 * (rng.uniform(0, 1, int(SR * d)) > 0.7)) * 0.7
    return x * np.linspace(0.3, 1, int(SR * d)) * env(int(SR * d), 0.01, 0.05)


def s_sticker_slap():
    d = 0.15
    return (lp(noise(d), 6) * 1.2 + 0.5 * np.sin(2 * np.pi * 220 * t(d))) * np.exp(-t(d) * 45)


def s_shake():
    out = []
    for i in range(4):
        d = 0.09
        out += [hp(noise(d), 4) * env(int(SR * d), 0.005, 0.07) * 0.8, np.zeros(int(SR * 0.05))]
    return np.concatenate(out)


def s_glitch():
    d = 0.6
    x = np.zeros(int(SR * d))
    pos = 0
    while pos < len(x):
        seg = int(rng.uniform(0.02, 0.07) * SR)
        f = rng.choice([110, 220, 440, 880, 1760])
        chunk = sweep(f, f * rng.uniform(0.5, 2), seg / SR, 'sq') * 0.35 * rng.uniform(0.3, 1)
        m = min(len(chunk), len(x) - pos)
        x[pos:pos + m] = chunk[:m]
        pos += seg
    return x


def s_bleep():
    return np.concatenate([np.sin(2 * np.pi * 880 * t(0.08)), np.sin(2 * np.pi * 1320 * t(0.1))]) * 0.4 * env(int(SR * 0.18), 0.005, 0.04)


def s_whoosh():
    d = 0.5
    x = noise(d)
    x = lp(x, 6) * np.sin(np.linspace(0, np.pi, int(SR * d))) ** 2
    return x * 1.2


def s_pop_appear():
    return sweep(300, 1400, 0.18) * env(int(SR * 0.18), 0.005, 0.08) * 0.6


def s_steam():
    d = 1.2
    return lp(noise(d), 4) * np.sin(np.linspace(0, np.pi, int(SR * d))) * 0.6


def s_chime():
    d = 1.0
    tt = t(d)
    x = sum(np.sin(2 * np.pi * f * tt) * np.exp(-tt * k) for f, k in [(1046, 4), (1318, 5), (1568, 6)])
    return x * 0.25


def s_fly_away():
    return sweep(500, 2000, 0.4) * env(int(SR * 0.4), 0.01, 0.2) * 0.3 + s_whoosh()[: int(SR * 0.4)] * 0.6


SOUNDS = {
    'gum_chew': s_gum_chew, 'gum_blow': s_gum_blow, 'gum_pop': s_gum_pop, 'gum_splat': s_gum_splat,
    'glass_knock': s_glass_knock, 'glass_squeak': s_glass_squeak, 'claws': s_claws,
    'glitter': s_glitter, 'sparkle_trail': s_sparkle_trail, 'purr': s_purr,
    'sticker_peel': s_sticker_peel, 'sticker_slap': s_sticker_slap, 'shake': s_shake,
    'glitch': s_glitch, 'bleep': s_bleep, 'whoosh': s_whoosh, 'pop_appear': s_pop_appear,
    'steam': s_steam, 'chime': s_chime, 'fly_away': s_fly_away,
}


def write_wav(path, x):
    x = np.asarray(x, dtype=np.float64)
    peak = np.max(np.abs(x)) or 1
    x = x / peak * 0.85
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())


def read_wav(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes(); ch = w.getnchannels(); sr = w.getframerate(); sw = w.getsampwidth()
        raw = np.frombuffer(w.readframes(n), dtype='<i2' if sw == 2 else np.uint8).astype(np.float64)
        if sw == 2: raw /= 32768
        if ch > 1: raw = raw.reshape(-1, ch).mean(axis=1)
        if sr != SR:
            raw = np.interp(np.linspace(0, len(raw), int(len(raw) * SR / sr), endpoint=False), np.arange(len(raw)), raw)
        return raw


# звуки с вариантами: <имя>_1.._N — рантайм выбирает случайный и меняет pitch ±5%
VARIANTS = {'glass_knock': 3, 'claws': 2, 'glitter': 3, 'sticker_slap': 3, 'gum_pop': 2, 'bleep': 2, 'shake': 2}


def stretch(x, k):
    n = int(len(x) / k)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)


def main():
    keep = '--keep-existing' in sys.argv
    os.makedirs(SRC, exist_ok=True)
    for name, fn in SOUNDS.items():
        n = VARIANTS.get(name, 1)
        for k in range(1, n + 1):
            p = os.path.join(SRC, (f'{name}_{k}' if n > 1 else name) + '.wav')
            if keep and os.path.exists(p):
                continue
            write_wav(p, stretch(fn(), 1 + 0.07 * (k - 1) * (-1) ** k))
        if n > 1 and os.path.exists(os.path.join(SRC, name + '.wav')) and not keep:
            os.remove(os.path.join(SRC, name + '.wav'))
    # спрайт: все wav из src (включая добавленные вручную) с паузой 0.25 с
    names = sorted(f[:-4] for f in os.listdir(SRC) if f.endswith('.wav'))
    pad = np.zeros(int(SR * 0.25))
    parts, sprite, pos = [], {}, 0.0
    for n in names:
        x = read_wav(os.path.join(SRC, n + '.wav'))
        sprite[n] = [round(pos * 1000), round(len(x) / SR * 1000)]
        parts += [x, pad]
        pos += (len(x) + len(pad)) / SR
    full = os.path.join(ROOT, 'sfx.wav')
    write_wav(full, np.concatenate(parts))
    for ext, codec in (('webm', ['-c:a', 'libopus', '-b:a', '64k']), ('mp3', ['-c:a', 'libmp3lame', '-b:a', '96k'])):
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', full, *codec, os.path.join(ROOT, 'sfx.' + ext)], check=True)
    os.remove(full)
    with open(os.path.join(ROOT, 'sfx.json'), 'w') as f:
        json.dump({'src': ['sfx.mp3', 'sfx.webm'], 'sprite': sprite}, f, ensure_ascii=False, indent=1)
    print('звуков:', len(names), '→', ', '.join(names))


if __name__ == '__main__':
    main()
