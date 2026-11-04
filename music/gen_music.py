"""Original stadium-anthem generator (rock/brass chant style). Usage: python3 gen_music.py OUTDIR [team ...]
Needs numpy, scipy and ffmpeg. Every tune is composed procedurally from the seed below: no existing song is used."""
import json, numpy as np, random, subprocess, sys, wave, os
from scipy.signal import fftconvolve, lfilter
SR = 32000
OUT = sys.argv[1]
ONLY = set(sys.argv[2:])
# team: (file, bpm, tonic midi, minor?, seed)
TEAMS = [('Brothers', 140, 62, False, 11), ('Lions', 146, 60, False, 23), ('Monkeys', 138, 65, False, 35), ('Guardians', 144, 59, False, 47),
 ('Dragons', 150, 57, True, 59), ('Hawks', 148, 64, True, 71), ('Dodgers', 140, 60, False, 83), ('Yankees', 136, 58, False, 95),
 ('Chinese_Taipei', 144, 62, False, 107), ('Japan', 146, 63, False, 119), ('South_Korea', 150, 61, True, 131), ('Australia', 142, 64, False, 143),
 ('USA', 138, 57, False, 155), ('Dominican_Rep', 132, 60, False, 167), ('Puerto_Rico', 136, 59, False, 179), ('Mexico', 140, 62, True, 191), ('Italy', 142, 65, False, 203)]
PENT_MAJ = [0, 2, 4, 7, 9]; PENT_MIN = [0, 3, 5, 7, 10]
# rhythmic hooks, in 16th steps over 2 bars (32 steps): (start, length). Short punchy phrases with rests, like a stadium trumpet chant
HOOKS = [
 [(0, 2), (3, 1), (4, 2), (6, 2), (8, 4), (16, 2), (19, 1), (20, 2), (22, 2), (24, 6)],
 [(0, 1), (1, 1), (2, 2), (4, 4), (10, 2), (12, 4), (16, 1), (17, 1), (18, 2), (20, 4), (26, 2), (28, 4)],
 [(0, 3), (3, 3), (6, 2), (8, 2), (10, 2), (12, 4), (16, 3), (19, 3), (22, 2), (24, 8)],
 [(0, 2), (2, 2), (4, 2), (6, 2), (8, 2), (12, 4), (16, 2), (18, 2), (20, 2), (22, 2), (24, 2), (28, 4)],
]
def mtof(m): return 440 * 2 ** ((m - 69) / 12)
def adsr(n, a, d, s, r):
    e = np.full(n, s); na, nd, nr = max(1, int(a * SR)), int(d * SR), int(r * SR)
    e[:na] = np.linspace(0, 1, na)
    if nd and na + nd < n: e[na:na + nd] = np.linspace(1, s, nd)
    if 0 < nr < n: e[-nr:] *= np.linspace(1, 0, nr)
    return e
def lp(x, k):                                   # cheap one-pole low-pass, k in (0,1]
    return lfilter([k], [1, -(1 - k)], x)
def saw(f, n, ph=0.0):
    t = np.arange(n) / SR; return 2 * ((f * t + ph) % 1.0) - 1
def brass(f, dur, vel=1.0):
    n = int(dur * SR); y = sum(saw(f * (1 + d), n, p) for d, p in ((-0.003, 0.0), (0.0, 0.33), (0.003, 0.66)))
    t = np.arange(n) / SR; y = lp(y, 0.28) + 0.4 * lp(saw(f * 2, n), 0.2)
    swell = np.minimum(1, 0.55 + t / 0.06)
    return np.tanh(1.6 * y / 3) * adsr(n, 0.012, 0.09, 0.8, 0.05) * swell * vel * 0.55
def guitar(root, dur, vel=1.0):                  # distorted power chord: root + fifth + octave
    n = int(dur * SR); y = sum(saw(mtof(root + o), n, p) for o, p in ((0, 0.0), (7, 0.2), (12, 0.5)))
    y = np.tanh(5.0 * lp(y, 0.35) / 3); y = lp(y, 0.5)
    return y * adsr(n, 0.004, 0.06, 0.8, 0.03) * vel * 0.5
def bass(m, dur):
    n = int(dur * SR); t = np.arange(n) / SR; f = mtof(m)
    y = np.tanh(2 * lp(saw(f, n), 0.12)) + 0.5 * np.sin(2 * np.pi * f * t)
    return y * adsr(n, 0.004, 0.08, 0.7, 0.03) * 0.5
def kick():
    n = int(0.3 * SR); t = np.arange(n) / SR; ph = 2 * np.pi * np.cumsum(38 + 130 * np.exp(-t * 32)) / SR
    return (np.sin(ph) * np.exp(-t * 8) + 0.15 * np.random.default_rng(1).standard_normal(n) * np.exp(-t * 90)) * 1.1
RNG = np.random.default_rng(5)
def snare():
    n = int(0.28 * SR); t = np.arange(n) / SR
    return (np.diff(RNG.standard_normal(n), prepend=0) * np.exp(-t * 17) * 0.55 + np.sin(2 * np.pi * 200 * t) * np.exp(-t * 28) * 0.55)
def clap():
    n = int(0.2 * SR); t = np.arange(n) / SR; y = np.zeros(n)
    for o in (0, 0.011, 0.023, 0.034):
        k = int(o * SR); y[k:] += RNG.standard_normal(n - k) * np.exp(-t[:n - k] * 38)
    return np.diff(y, prepend=0) * 0.5
def hat(open_=False):
    n = int((0.22 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return np.diff(RNG.standard_normal(n), prepend=0) * np.exp(-t * (14 if open_ else 80)) * (0.2 if open_ else 0.26)
def crash():
    n = int(1.2 * SR); t = np.arange(n) / SR
    return np.diff(RNG.standard_normal(n), prepend=0) * np.exp(-t * 3.2) * 0.32
def tom(f):
    n = int(0.25 * SR); t = np.arange(n) / SR; return np.sin(2 * np.pi * np.cumsum(f * (1 + 0.8 * np.exp(-t * 20))) / SR) * np.exp(-t * 9) * 0.7
def put(buf, x, pos):
    i = int(pos * SR)
    if 0 <= i < len(buf): j = min(len(buf), i + len(x)); buf[i:j] += x[:j - i]
def reverb(x, wet=0.16):
    n = int(0.7 * SR); t = np.arange(n) / SR; ir = RNG.standard_normal(n) * np.exp(-t * 6); ir[0] = 0
    return x + wet * fftconvolve(x, ir / np.abs(ir).sum() * 6)[:len(x)]
def render(name, bpm, tonic, minor, seed):
    if ONLY and name not in ONLY: return
    rnd = random.Random(seed); pent = PENT_MIN if minor else PENT_MAJ
    beat = 60 / bpm; bar = 4 * beat; s16 = beat / 4; BARS = 16
    buf = np.zeros(int((BARS * bar + 2.0) * SR))
    # chord roots per bar (semitones above tonic): driving i-VI-VII-i / I-V-vi-IV
    roots = ([0, 8, 10, 0] if minor else [0, 7, 9, 5]) * 4
    def pitch(i): o, k = divmod(i, 5); return tonic + 12 * o + pent[k]
    def hook_phrase(sd):
        r = random.Random(sd); hk = HOOKS[r.randrange(len(HOOKS))]; deg = 5; out = []
        for k, (st, ln) in enumerate(hk):
            deg = {0: 5}.get(k, deg + r.choice([-2, -1, 0, 1, 2, 3, -3]))
            if k == len(hk) - 1: deg = 5 + (0 if r.random() < .5 else 2)          # land on a strong note
            deg = max(3, min(deg, 11)); out.append((st, ln, deg))
        return out
    P1 = hook_phrase(seed * 5 + 1); P2 = hook_phrase(seed * 5 + 2)
    # melody: 8 two-bar phrases  A A' | B A | A A' | B A+oct (last lifted for the big finish)
    plan = [(P1, 0, 0), (P1, 0, 0), (P2, 0, 0), (P1, 0, 0), (P1, 0, 0), (P1, 0, 0), (P2, 0, 0), (P1, 1, 0)]
    for pi, (ph, lift, _) in enumerate(plan):
        b0 = pi * 2
        for st, ln, d in ph:
            pos = b0 * bar + st * s16; dur = max(ln * s16 * 0.9, 0.08)
            m = pitch(d + 5 * lift) + (roots[b0 + (1 if st >= 16 else 0)] if roots[b0] else 0) * 0
            put(buf, brass(mtof(m), dur, 1.0 if st % 4 == 0 else 0.85), pos)
            if pi % 2 == 1 or pi >= 4: put(buf, brass(mtof(m - 12), dur, 0.55), pos)      # octave-doubled in the second half
    for bi in range(BARS):
        t0 = bi * bar; rt = tonic - 12 + roots[bi]
        # guitar: palm-muted 8ths, open chord on beat 1 and 3
        for e in range(8):
            put(buf, guitar(rt + 12, beat / 2 * (0.9 if e % 4 else 1.8), 0.7 if e % 2 else 1.0), t0 + e * beat / 2)
        # bass: pushing 8ths
        for e in range(8): put(buf, bass(rt - 12 + (12 if e % 4 == 3 else 0), beat / 2 * 0.85), t0 + e * beat / 2)
        # drums: rock beat with extra kicks, open hat on the "and" of 4
        for q in (0, 2): put(buf, kick(), t0 + q * beat)
        put(buf, kick(), t0 + 1.5 * beat if bi % 2 else t0 + 2.5 * beat)
        for q in (1, 3): put(buf, snare(), t0 + q * beat); put(buf, clap(), t0 + q * beat)
        for e in range(8): put(buf, hat(open_=(e == 7)), t0 + e * beat / 2)
        if bi % 8 == 0: put(buf, crash(), t0)
        if bi % 8 == 7:                                                          # tom fill into the next section
            for k, f in enumerate((190, 160, 130, 100)): put(buf, tom(f), t0 + 3 * beat + k * beat / 4)
    L = int(BARS * bar * SR)
    over = buf[L:].copy(); buf = buf[:L].copy(); buf[:len(over)] += over[:L]              # notes still ringing at the end carry on over the start: no cut at the loop point
    ext = np.concatenate([buf, buf, buf]); ext = reverb(ext); buf = ext[L:2 * L].copy()    # reverb on a tiled copy, so its tail wraps round instead of being cut
    buf = np.tanh(1.4 * buf / np.abs(buf).max()); buf *= 0.9 / np.abs(buf).max()
    wav = os.path.join(OUT, name + '.wav'); w = wave.open(wav, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((buf * 32767).astype(np.int16).tobytes()); w.close()
    mp3 = os.path.join(OUT, name + '.mp3'); tgt = 'loudnorm=I=-16:TP=-1.5:LRA=11'
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', wav, '-af', tgt + ':print_format=json', '-f', 'null', '-'], capture_output=True, text=True)
    m = json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}') + 1])                 # pass 1: measure
    flt = f"{tgt}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-af', flt, '-codec:a', 'libmp3lame', '-b:a', '128k', mp3], check=True); os.remove(wav)      # pass 2: one fixed gain for the whole loop (no fade-in at the start)
    print(name, round(BARS * bar, 1), 's')
for t in TEAMS: render(*t)
