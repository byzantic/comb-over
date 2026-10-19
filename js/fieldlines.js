// N coupled microstrip lines from their geometry, by the 2-D field solver (issue #12).
//
// fieldLines({ W: [..], S: [..], sub, f0 }) → { C, L, Q(v), epsEff, warnings, info }
//
//   C, L      quasi-static per-unit-length Maxwell matrices of zero-thickness strips (solver/mtl2d.js)
//   Q(v)      per-mode Q for a mode voltage vector v (Section's per-mode loss hook):
//               conductor  Wheeler's incremental inductance as a matrix: every conductor surface
//                          receded by δ/2 (widths −δ, gaps +δ, h +δ), R = Kr·ω·ΔL, and for the mode
//                          Qc = vᵀL⁻¹v / (Kr · vᵀL⁻¹ ΔL L⁻¹v)   (current i ∝ L⁻¹v)
//               dielectric the filling-factor formula with the mode's own εeff, as for single lines
//   epsEff    modal εeff (ascending)
//
// Results are cached by geometry and substrate: the optimiser re-evaluates the same section many times.
import { solve, microstrip } from '../solver/mtl2d.js';
import { mscoupled, msline } from './microstrip.js';

const C0 = 299792458, MU0 = 4e-7 * Math.PI;
const cache = new Map();
const CACHE_MAX = 400;

const skinDepth = (f, sigma) => 1 / Math.sqrt(Math.PI * f * MU0 * sigma);
const roughness = (rough, delta) => (rough > 0 ? 1 + 2 / Math.PI * Math.atan(1.4 * (rough / delta) ** 2) : 1);

function solveWS(W, S, h, er) {
  const strips = []; let x = 0;
  W.forEach((w, i) => { strips.push({ x: x + w / 2, w }); x += w + (S[i] ?? 0); });
  return solve(strips, microstrip({ h, er }));
}

function quad(v, A, u = v) { let s = 0; for (let i = 0; i < v.length; i++) for (let j = 0; j < v.length; j++) s += v[i] * A[i][j] * u[j]; return s; }
function matVec(A, v) { return A.map(r => r.reduce((s, x, j) => s + x * v[j], 0)); }
function inv(A) {
  const n = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    const d = M[k][k]; for (let j = 0; j < 2 * n; j++) M[k][j] /= d;
    for (let i = 0; i < n; i++) if (i !== k) { const f = M[i][k]; if (f) for (let j = 0; j < 2 * n; j++) M[i][j] -= f * M[k][j]; }
  }
  return M.map(r => r.slice(n));
}

/**
 * W: widths (N), S: gaps (N−1), sub: substrate object (js/substrates.js), f0: frequency for the loss.
 */
export function fieldLines({ W, S, sub, f0 }) {
  const N = W.length;
  if (N < 1) throw new Error('no strips');
  if (S.length !== N - 1) throw new Error(`${N} strips need ${N - 1} gaps, got ${S.length}`);
  if (W.some(w => !(w > 0))) throw new Error('every W must be > 0');
  if (S.some(s => !(s > 0))) throw new Error('every S must be > 0');
  const { h, er, tand = 0 } = sub.dielectric, { t = 0, sigma = 5.8e7, roughness: rough = 0 } = sub.copper;
  const key = JSON.stringify([W, S, h, er, tand, t, sigma, rough, f0]);
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }

  const r = solveWS(W, S, h, er);
  const warnings = [];
  // conductor loss: receded geometry, air (L only)
  let dL = null, Kr = 1;
  if (f0 > 0 && sigma > 0) {
    const d = skinDepth(f0, sigma); Kr = roughness(rough, d);
    if (W.every(w => w > 2 * d)) {
      const rec = solveWS(W.map(w => w - d), S.map(s => s + d), h + d, 1);
      dL = rec.L.map((row, i) => row.map((x, j) => x - r.L[i][j]));
    }
  }
  const Li = inv(r.L);
  const Q = (v) => {
    // mode εeff by the Rayleigh quotient vᵀCv / vᵀC0v (exact for an eigenvector)
    const eps = quad(v, r.C) / quad(v, r.C0);
    let invQ = 0;
    if (dL) { const i = matVec(Li, v); invQ += Kr * quad(i, dL) / quad(v, Li); }
    if (tand > 0 && er > 1) invQ += tand * er * (eps - 1) / (eps * (er - 1));
    return invQ > 0 ? 1 / invQ : Infinity;
  };
  // how much strip thickness would change things (closed forms; tightest pair, or the line itself):
  // the solver has t = 0
  if (t > 0) {
    try {
      let dz, where;
      if (N > 1) {
        const k = S.indexOf(Math.min(...S)), Wp = (W[k] + W[k + 1]) / 2;
        const a = mscoupled({ W: Wp, S: S[k], h, er, t: 0 }), b = mscoupled({ W: Wp, S: S[k], h, er, t });
        dz = Math.max(Math.abs(b.Ze / a.Ze - 1), Math.abs(b.Zo / a.Zo - 1)); where = ` (worst mode of the pair at the tightest gap, ${(S[k] * 1e3).toPrecision(3)} mm)`;
      } else {
        dz = Math.abs(msline({ W: W[0], h, er, t }).Z0 / msline({ W: W[0], h, er, t: 0 }).Z0 - 1); where = '';
      }
      if (dz > 0.01) warnings.push(`the field solver models zero-thickness strips; ${(t * 1e6).toPrecision(3)} µm copper would lower the impedances by about ${(dz * 100).toFixed(1)} %${where}, closed-form estimate`);
    } catch { /* outside the closed-form range: no estimate */ }
  }
  const out = { C: r.C, L: r.L, C0: r.C0, Q, epsEff: r.epsEff, warnings, info: { order: r.order, ms: r.ms } };
  cache.set(key, out);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

export function clearFieldCache() { cache.clear(); }
