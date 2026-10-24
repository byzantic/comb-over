# Bloch (de-embedded) even/odd εeff of a finger-loaded pair from two lengths with identical ends (issue #41).
#   python fingerbloch.py A.s4p B.s4p CELLS_DIFF PITCH_MM FMIN FMAX  → JSON {f, ee, eo} over FMIN..FMAX
# Ports: 1/2 line 1 left/right, 3/4 line 2 left/right. With T the 4×4 wave transfer matrix (left waves from
# right), T_A·T_B⁻¹ = E·U^m·E⁻¹ (the ends E cancel), so its eigenvalues are exp(∓jβm·p) of the two modes.
import sys, json
import numpy as np
def rd(fn):
    rows, unit, fmt = [], 1e9, 'MA'
    for l in open(fn):
        l = l.split('!')[0].strip()
        if not l: continue
        if l.startswith('#'):
            t = l.split(); unit = {'HZ': 1, 'KHZ': 1e3, 'MHZ': 1e6, 'GHZ': 1e9}[t[1].upper()]; fmt = t[3].upper(); continue
        rows += [float(v) for v in l.split()]
    a = np.array(rows).reshape(-1, 33); d = a[:, 1:].reshape(-1, 16, 2)
    s = d[..., 0] + 1j * d[..., 1] if fmt == 'RI' else (d[..., 0] if fmt == 'MA' else 10 ** (d[..., 0] / 20)) * np.exp(1j * np.deg2rad(d[..., 1]))
    return a[:, 0] * unit, s.reshape(-1, 4, 4)
def T(S):
    L, R = [0, 2], [1, 3]
    SLL, SLR, SRL, SRR = S[np.ix_(L, L)], S[np.ix_(L, R)], S[np.ix_(R, L)], S[np.ix_(R, R)]
    Ri = np.linalg.inv(SRL)
    return np.block([[Ri, -Ri @ SRR], [SLL @ Ri, SLR - SLL @ Ri @ SRR]])
fa, A = rd(sys.argv[1]); fb, B = rd(sys.argv[2]); m, p = float(sys.argv[3]), float(sys.argv[4]) * 1e-3
lo, hi = float(sys.argv[5]), float(sys.argv[6]); C0 = 299792458
out = {'f': [], 'ee': [], 'eo': []}
for k in range(len(fa)):
    if not lo <= fa[k] <= hi: continue
    ev, V = np.linalg.eig(T(A[k]) @ np.linalg.inv(T(B[k])))
    e = {'e': [], 'o': []}
    for i in range(4):
        v = V[:, i]; x = v[0:2] if abs(v[0]) + abs(v[1]) > abs(v[2]) + abs(v[3]) else v[2:4]
        e['e' if abs(x[0] + x[1]) > abs(x[0] - x[1]) else 'o'].append((abs(np.angle(ev[i])) * C0 / (2 * np.pi * fa[k] * m * p)) ** 2)
    if len(e['e']) != 2 or len(e['o']) != 2: continue
    out['f'].append(fa[k]); out['ee'].append(float(np.mean(e['e']))); out['eo'].append(float(np.mean(e['o'])))
print(json.dumps(out))
