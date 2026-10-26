# Bloch (de-embedded) modal εeff of N finger-loaded lines from two lengths with identical ends (issue #41).
#   python fingerbloch.py A.sNp B.sNp CELLS_DIFF PITCH_MM FMIN FMAX  → JSON over FMIN..FMAX
# Ports: line i left = 2i−1, right = 2i (1-based). With T the 2N×2N wave transfer matrix (left waves from right),
# T_A·T_B⁻¹ = E·U^m·E⁻¹ (the ends E cancel), so its eigenvalues are exp(∓jβm·p) of the N modes.
# Each mode is labelled by the mirror symmetry of the line set (line i ↔ line N+1−i): 's' symmetric, 'a' antisymmetric.
# Output: {f, modes: [[[eps, 's'|'a'], …N] per f]}; for N = 2 also ee (symmetric = even) and eo (odd) per f.
import sys, json, re
import numpy as np


def rd(fn):
    n = int(re.search(r'\.s(\d+)p$', fn).group(1))
    rows, unit, fmt = [], 1e9, 'MA'
    for l in open(fn):
        l = l.split('!')[0].strip()
        if not l: continue
        if l.startswith('#'):
            t = l.split(); unit = {'HZ': 1, 'KHZ': 1e3, 'MHZ': 1e6, 'GHZ': 1e9}[t[1].upper()]; fmt = t[3].upper(); continue
        rows += [float(v) for v in l.split()]
    a = np.array(rows).reshape(-1, 1 + 2 * n * n); d = a[:, 1:].reshape(-1, n * n, 2)
    s = d[..., 0] + 1j * d[..., 1] if fmt == 'RI' else (d[..., 0] if fmt == 'MA' else 10 ** (d[..., 0] / 20)) * np.exp(1j * np.deg2rad(d[..., 1]))
    return a[:, 0] * unit, s.reshape(-1, n, n), n


def T(S, N):
    L, R = list(range(0, 2 * N, 2)), list(range(1, 2 * N, 2))
    SLL, SLR, SRL, SRR = S[np.ix_(L, L)], S[np.ix_(L, R)], S[np.ix_(R, L)], S[np.ix_(R, R)]
    Ri = np.linalg.inv(SRL)
    return np.block([[Ri, -Ri @ SRR], [SLL @ Ri, SLR - SLL @ Ri @ SRR]])


fa, A, nA = rd(sys.argv[1]); fb, B, nB = rd(sys.argv[2]); N = nA // 2
m, p = float(sys.argv[3]), float(sys.argv[4]) * 1e-3
lo, hi = float(sys.argv[5]), float(sys.argv[6]); C0 = 299792458
out = {'f': [], 'modes': []}
if N == 2: out['ee'], out['eo'] = [], []
for k in range(len(fa)):
    if not lo <= fa[k] <= hi: continue
    ev, V = np.linalg.eig(T(A[k], N) @ np.linalg.inv(T(B[k], N)))
    ms = []
    for i in range(2 * N):
        v = V[:, i]; x = v[0:N] if np.sum(np.abs(v[0:N])) > np.sum(np.abs(v[N:])) else v[N:]
        sym = np.sum(np.abs(x - x[::-1])) < np.sum(np.abs(x + x[::-1]))
        eps = (abs(np.angle(ev[i])) * C0 / (2 * np.pi * fa[k] * m * p)) ** 2
        ms.append((eps, 's' if sym else 'a'))
    # each mode appears twice (forward and backward): pair them within their symmetry class, by value
    modes = []
    for lab in ('s', 'a'):
        v = sorted(e for e, l in ms if l == lab)
        if len(v) % 2: break
        modes += [[float((v[j] + v[j + 1]) / 2), lab] for j in range(0, len(v), 2)]
    if len(modes) != N: continue
    out['f'].append(float(fa[k])); out['modes'].append(sorted(modes))
    if N == 2:
        out['ee'].append(next(e for e, l in modes if l == 's')); out['eo'].append(next(e for e, l in modes if l == 'a'))
print(json.dumps(out))
