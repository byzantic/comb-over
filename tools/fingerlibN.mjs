// N finger-loaded coupled lines against openEMS (issue #41, stage 3): cases, Bloch de-embedding and the N×N C, L fit.
// Ports: line i (1 at the bottom) left = 2i−1, right = 2i. The line set is mirror-symmetric (line i ↔ N+1−i), so the
// lower half of the lines (and the centre line) is driven and the mirror gives the rest.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fingerArray } from '../js/fingers.js';
import { makeSubstrate } from '../js/substrates.js';
import { openemsExport } from '../js/openems.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';
import { solve as solve2d, microstrip, stripsFromWS } from '../solver/mtl2d.js';
import { nm } from './fingerlib.mjs';

const C0 = 299792458, r6 = (x) => +x.toFixed(6), m8 = (x) => x.toPrecision(8);

// mirror port map: port of line i, side s → line N+1−i, same side
export const mirrorPerm = (N) => Array.from({ length: 2 * N }, (_, k) => { const i = k >> 1, s = k & 1; return 2 * (N - 1 - i) + s + 1; });
const driven = (N) => Array.from({ length: 2 * Math.ceil(N / 2) }, (_, k) => k + 1);   // lines 1 … ⌈N/2⌉, both sides

// write case DIR/NAME: P = { W: [..], G: [..], wf, lf, p } (mm), n cells; opts { sub, bare, full, lossy, fine, fmin, fmax }
export function genCaseN(dir, name, P, n, opts = {}) {
  const N = P.W.length, subId = opts.sub ?? 'jlc-ro4350b-0.508', sub = makeSubstrate(subId), h = sub.dielectric.h * 1e3;
  const fmin = opts.fmin ?? 0.5e9, fmax = opts.fmax ?? 6e9, Lp = 3, Lf = r6(Lp + 3 * h + 1.5);
  const fa = fingerArray({ ...P, n }), len = fa.len, rect = (a, b, c, d) => [[a, b], [c, b], [c, d], [a, d]];
  const polys = opts.bare ? fa.ybands.map(([lo, hi]) => rect(0, lo, len, hi)) : fa.polys;
  const items = polys.map(pts => ({ type: 'poly', role: 'core', pts }));
  fa.ybands.forEach(([lo, hi], i) => {
    const y = (lo + hi) / 2, w = hi - lo;
    for (const [node, xe, xi] of [[`p${2 * i + 1}`, -Lf, 0], [`p${2 * i + 2}`, len + Lf, len]])
      items.push({ type: 'poly', role: 'feed', node, width: w, pts: rect(Math.min(xe, xi), y - w / 2, Math.max(xe, xi), y + w / 2), path: [[xe, y], [xi, y]] });
  });
  const ports = Array.from({ length: 2 * N }, (_, k) => `p${k + 1}`);
  const exportNet = ['.title finger lines', `.freq ${fmin} ${fmax} 201`, `.substrate ${subId}`, ...ports.map(q => `port ${q} 50`),
    ...ports.map((q, k) => `T${q}_f ${q} ${q}_k W=${P.W[k >> 1]}mm len=${Lf}mm`)].join('\n') + '\n';
  const lfs = [].concat(P.lf), feats = [P.wf, fa.gaps[0].side, ...fa.gaps.map(g => g.tip), ...fa.gaps.map(g => Math.max(Math.abs(g.overlap), P.wf)), ...P.G, ...P.W];
  const fine = opts.fine ?? Math.min(...feats) / 3;
  const sym = opts.full ? {} : { excite: driven(N).join(','), perm: mirrorPerm(N) };
  const g = openemsExport(exportNet, { layout: { items, parts: [], substrate: sub, netlist: exportNet, errors: [], title: `finger lines ${name}` }, lossless: !opts.lossy, fine, ...sym });
  const d = join(dir, name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'f.py'), g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'"));
  const c = { ...P, lf: lfs.length === 1 ? lfs[0] : lfs, N, n, len, bare: !!opts.bare, sub: subId, h, fmin, fmax, Lf, Lp: g.info.ports[0].Lp, cells: g.info.cells, gaps: fa.gaps, fine };
  writeFileSync(join(d, 'case.json'), JSON.stringify(c));
  return c;
}

export function runCaseN(d) {
  const c = JSON.parse(readFileSync(join(d, 'case.json'), 'utf8')), out = join(d, `f.s${2 * c.N}p`);
  if (existsSync(out)) return { ok: true, cached: true, s: 0 };
  const t0 = Date.now(), r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', ['f.py'], { cwd: d, encoding: 'utf8', maxBuffer: 1 << 28 });
  writeFileSync(join(d, 'run.log'), r.stdout + r.stderr);
  return { ok: r.status === 0 && !/-nan/.test(r.stdout) && existsSync(out), s: (Date.now() - t0) / 1000 };
}

export function loadCaseN(d) {
  const c = JSON.parse(readFileSync(join(d, 'case.json'), 'utf8')), np = 2 * c.N;
  const ds = readTouchstone(readFileSync(join(d, `f.s${np}p`), 'utf8'), { nPorts: np, name: 'f' });
  const F = Float64Array.from({ length: 12 }, (_, i) => c.fmin * 1.01 + (c.fmax * 0.99 - c.fmin * 1.01) * i / 11);
  return { c, F, em: onSweep(ds, F) };
}

const mat = (M) => `[${M.map(r => r.map(m8).join(' ')).join('; ')}]`;
const cl = (name, C, L, len, A, B) => [`cline ${name}`, `  C ${mat(C)}`, `  L ${mat(L)}`, `  len ${len}mm`, '  Q 1e30', `  A ${A.join(' ')}`, `  B ${B.join(' ')}`, 'end'];
// comb-over's model of a case: feeds (C, L of the bare lines) + the section (C, L)
export function modelN(c, C, L, feed) {
  const N = c.N, fl = r6(c.Lf - c.Lp), Lp = (s) => Array.from({ length: N }, (_, i) => `p${2 * i + s}`), A = (t) => Array.from({ length: N }, (_, i) => `${t}${i + 1}`);
  return ['.title finger lines model', `.freq ${c.fmin} ${c.fmax} 11`, `.substrate ${c.sub}`, ...Array.from({ length: 2 * N }, (_, k) => `port p${k + 1} 50`),
    ...cl('FA', feed.C, feed.L, fl, Lp(1), A('a')), ...cl('K', C, L, c.len, A('a'), A('b')), ...cl('FB', feed.C, feed.L, fl, A('b'), Lp(2))].join('\n') + '\n';
}
export function errN(A, C, L, feed) {
  const r = solve(parseNetlist(modelN(A.c, C, L, feed)), A.F), np = 2 * A.c.N; let e = 0;
  for (let i = 1; i <= np; i++) for (let j = 1; j <= np; j++) { const a = r.S(i, j), b = A.em.S(i, j); for (let k = 0; k < A.F.length; k++) e += (a.re[k] - b.re[k]) ** 2 + (a.im[k] - b.im[k]) ** 2; }
  return Math.sqrt(e / A.F.length / np / np);
}

// mirror-symmetric N×N C, L from a parameter vector (log magnitudes): the independent entries (i ≤ j, i + j ≤ N − 1 in
// 0-based terms, i.e. one of each mirror pair); C off-diagonals negative, L entries positive
export function symIndex(N) { const idx = []; for (let i = 0; i < N; i++) for (let j = i; j < N; j++) if (i + j <= N - 1) idx.push([i, j]); return idx; }
export function fromParams(N, x) {
  const idx = symIndex(N), C = Array.from({ length: N }, () => Array(N).fill(0)), L = Array.from({ length: N }, () => Array(N).fill(0));
  const set = (M, i, j, v) => { for (const [a, b] of [[i, j], [j, i], [N - 1 - i, N - 1 - j], [N - 1 - j, N - 1 - i]]) M[a][b] = v; };
  idx.forEach(([i, j], k) => { set(C, i, j, (i === j ? 1 : -1) * Math.exp(x[k])); set(L, i, j, Math.exp(x[idx.length + k])); });
  return { C, L };
}
export function toParams(C, L) {
  const N = C.length, idx = symIndex(N);
  return [...idx.map(([i, j]) => Math.log(Math.abs(C[i][j]) || 1e-15)), ...idx.map(([i, j]) => Math.log(Math.abs(L[i][j]) || 1e-12))];
}
// the bare lines' C, L from the 2-D solver (zero thickness), as a start
export function bareCLN(c) {
  const sub = makeSubstrate(c.sub);
  return solve2d(stripsFromWS(c.W.map(w => w * 1e-3), c.G.map(g => g * 1e-3), 0), microstrip({ h: sub.dielectric.h, er: sub.dielectric.er }));
}
// modal εeff of a C, L pair: eigenvalues of c²·L·C
export function modalEps(C, L) {
  const N = C.length, M = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => C0 * C0 * L[i].reduce((s, v, k) => s + v * C[k][j], 0)));
  return eigSym(M);
}
// eigenvalues of a small real matrix with real spectrum (unsymmetric QR iterations)
function eigSym(M) {
  let A = M.map(r => [...r]); const n = A.length;
  for (let it = 0; it < 500; it++) {
    const Q = A.map(r => r.map(() => 0)), R = A.map(r => r.map(() => 0)), V = A.map(r => [...r]);
    for (let j = 0; j < n; j++) {
      const v = V.map(r => r[j]);
      for (let k = 0; k < j; k++) { const d = Q.reduce((s, r, i) => s + r[k] * V[i][j], 0); R[k][j] = d; for (let i = 0; i < n; i++) v[i] -= d * Q[i][k]; }
      const nv = Math.hypot(...v); R[j][j] = nv; for (let i = 0; i < n; i++) Q[i][j] = v[i] / nv;
    }
    A = R.map((r, i) => Q[0].map((_, j) => r.reduce((s, v, k) => s + v * Q[k][j], 0)));
  }
  return A.map((r, i) => r[i]).sort((a, b) => a - b);
}

// fit the uniform bare lines: the whole case is one N-line (feeds and section alike)
export function fitBareN(d) {
  const A = loadCaseN(d), b = bareCLN(A.c), x0 = toParams(b.C, b.L), N = A.c.N;
  const err = (x) => { const q = fromParams(N, x); return errN(A, q.C, q.L, q); };
  let f = nm(err, x0, 1500, 0.05); f = nm(err, f.x, 1000, 0.01);
  const q = fromParams(N, f.x);
  return { ...q, rms: f.v, eps: modalEps(q.C, q.L) };
}
// fit the finger-loaded section to several cases (same geometry, different lengths) with the feeds' C, L given
export function fitN(dirs, feed, x0) {
  const cases = dirs.map(loadCaseN), N = cases[0].c.N, start = x0 ?? toParams(feed.C, feed.L);
  const err = (x) => { const q = fromParams(N, x); return Math.hypot(...cases.map(A => errN(A, q.C, q.L, feed))) / Math.sqrt(cases.length); };
  let f = nm(err, start, 2000, 0.1); f = nm(err, f.x, 1500, 0.02);
  const q = fromParams(N, f.x);
  return { ...q, rms: f.v, each: cases.map(A => errN(A, q.C, q.L, feed)), eps: modalEps(q.C, q.L) };
}
// Bloch: modal εeff de-embedded from two cases that differ only in cell count (tools/fingerbloch.py)
export function blochN(dA, dB, fmin = 1e9, fmax = 6e9) {
  const a = JSON.parse(readFileSync(join(dA, 'case.json'), 'utf8')), b = JSON.parse(readFileSync(join(dB, 'case.json'), 'utf8')), np = 2 * a.N;
  const r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', [new URL('./fingerbloch.py', import.meta.url).pathname, join(dA, `f.s${np}p`), join(dB, `f.s${np}p`), String(a.n - b.n), String(a.p), String(fmin), String(fmax)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fingerbloch: ${r.stderr}`);
  const o = JSON.parse(r.stdout), med = (v) => { const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
  if (!o.f.length) throw new Error('fingerbloch: no frequency gave a full set of modes');
  return { modes: o.modes[0].map((_, k) => [med(o.modes.map(ms => ms[k][0])), o.modes[0][k][1]]), f: o.f, all: o.modes };
}
