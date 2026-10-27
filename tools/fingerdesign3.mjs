// Finger-loaded 3-line coupler design against openEMS (#41, stage 3): outer width Wo, centre width Wc, gap G and finger
// length lf (wf, pitch p fixed) for a centre-to-outer coupling C (dB) at f0, the centre input matched (--match centre,
// the default since #62: (Z11 + Z13)/Z22 = 1 and (Z11 + Z13)/2·Z22 − Z12² = Z0²/2, worked example 15 §1; --match diag:
// the diagonal of the characteristic impedance matrix at Z0, as #41 used), and the two mirror-symmetric modes at equal
// velocity. A centre-line signal is
// mirror-symmetric, so only those two modes carry the centre-to-outer response; the antisymmetric mode (outer lines in
// antiphase) only affects outer-to-outer isolation and the outer ports' match.
//   node tools/fingerdesign3.mjs DIR [--C 20 --Z0 50 --f0 5e9 --Wo 1 --Wc 1 --G 0.6 --lf 0.4 --lfo 0.5 --wf 0.13 --p 1 --n 6 --n2 10 --min 0.09 --iters 10 --match centre|diag]
// Variables Wo, Wc, G, lf and lfo (fingers on the outer lines' outer edges); four targets, so each step is the
// minimum-norm Newton step. The outer-edge fingers are needed (#62): the centre line carries fingers on both edges, the
// outer lines on one, and without lfo the centre is the slower line by about 11 % whatever Wo, Wc, G and lf are.
// --lfo 0 holds the outer edges bare (inner fingers only): four variables, a Newton step.
// Each evaluation: openEMS cases of n and n2 cells (tools/fingerlibN.mjs), the symmetric modes de-embedded from the pair
// (Bloch), and the section's 3×3 C, L fitted to both (feeds from the 2-D field solver).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { genCaseN, runCaseN, blochN, fitN, bareCLN, toParams } from './fingerlibN.mjs';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';

const [dir, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? +rest[i + 1] : d; };
if (!dir) { console.error('usage: node tools/fingerdesign3.mjs DIR [options]'); process.exit(2); }
const matchMode = (() => { const i = rest.indexOf('--match'); return i >= 0 ? rest[i + 1] : 'centre'; })();
if (!['centre', 'diag'].includes(matchMode)) { console.error('--match centre|diag'); process.exit(2); }
const lfoOff = opt('lfo', 0.5) === 0;
const Cdb = opt('C', 20), Z0 = opt('Z0', 50), f0 = opt('f0', 5e9), wf = opt('wf', 0.13), p = opt('p', 1), n = opt('n', 6), n2 = opt('n2', 10), mn = opt('min', 0.09);
const C0 = 299792458, r4 = (x) => +x.toFixed(4), m8 = (x) => x.toPrecision(8);
mkdirSync(dir, { recursive: true });
const logf = join(dir, 'design3.json'), hist = existsSync(logf) ? JSON.parse(readFileSync(logf, 'utf8')) : [];

// keep it buildable: tip gap ≥ mn, overlap ≥ 2 mesh cells (≈ 2·min(wf, tip)/3), widths ≥ mn
const ovMin = 2 * Math.min(wf, mn) / 3;
function project([Wo, Wc, G, lf, lfo]) {
  Wo = Math.max(Wo, mn); Wc = Math.max(Wc, mn); G = Math.max(G, 2 * mn + ovMin);
  lf = Math.min(Math.max(lf, (G + ovMin) / 2), G - mn); lfo = lfoOff ? 0 : Math.max(lfo, 0.05);
  return [r4(Wo), r4(Wc), r4(G), r4(lf), r4(lfo)];
}

// 3×3 helpers
const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
function inv(A) {
  const n = A.length, M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) { let pv = c; for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[pv][c])) pv = i; [M[c], M[pv]] = [M[pv], M[c]];
    const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let i = 0; i < n; i++) if (i !== c) { const f = M[i][c]; for (let j = 0; j < 2 * n; j++) M[i][j] -= f * M[c][j]; } }
  return M.map(r => r.slice(n));
}
function sqrtm(A) { let Y = A.map(r => [...r]), Z = A.map((r, i) => r.map((_, j) => (i === j ? 1 : 0)));
  for (let k = 0; k < 60; k++) { const Yi = inv(Y), Zi = inv(Z); Y = Y.map((r, i) => r.map((v, j) => (v + Zi[i][j]) / 2)); Z = Z.map((r, i) => r.map((v, j) => (v + Yi[i][j]) / 2)); }
  return Y; }
// the two mirror-symmetric modes of L·C: basis (1,0,1), (0,1,0); returns [{eps, pi}] (pi: centre opposed to the outer lines)
function symModes(C, L) {
  const M = mul(L, C).map(r => r.map(v => v * C0 * C0)), u = [1, 0, 1], w = [0, 1, 0];
  const Mu = M.map(r => r.reduce((s, v, k) => s + v * u[k], 0)), Mw = M.map(r => r.reduce((s, v, k) => s + v * w[k], 0));
  const a = Mu[0], b = Mw[0], c = Mu[1], d = Mw[1];   // [[a b],[c d]] in the basis (u, w)
  const tr = a + d, det = a * d - b * c, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  // which is "π": the mode with the larger share on the outer lines. Where the two modes are well mixed (the designed
  // coupler) that is the one with the centre opposed to the outer pair; where they barely mix (inner fingers only, #62:
  // an outer-line mode and a centre-line mode) the sign of the small component flips as the design moves, so a sign
  // test swaps the labels and the velocity residual jumps. Each eigenvector is taken from the better-conditioned row.
  const ms = [tr / 2 - disc, tr / 2 + disc].map(l => { const r1 = [b, l - a], r2 = [l - d, c], x = Math.hypot(...r1) >= Math.hypot(...r2) ? r1 : r2;
    return { eps: l, outer: Math.abs(x[0]) / (Math.abs(x[0]) + Math.abs(x[1])) }; });
  const iPi = ms[0].outer >= ms[1].outer ? 0 : 1;
  return ms.map((m, i) => ({ eps: m.eps, pi: i === iPi }));
}
// comb-over's centre-to-outer coupling of a λ/4 section (at the symmetric modes' mean velocity) between Z0 ports
function coupling(C, L, epsMean) {
  const len = C0 / Math.sqrt(epsMean) / f0 / 4 * 1e3, mat = (M) => `[${M.map(r => r.map(m8).join(' ')).join('; ')}]`;
  const net = ['.title c3', `.freq ${f0} ${f0} 1`, ...['o1', 'o1r', 'ci', 'ct', 'o3', 'o3r'].map(q => `port ${q} ${Z0}`),
    'cline K', `  C ${mat(C)}`, `  L ${mat(L)}`, `  len ${len}mm`, '  Q 1e30', '  A o1 ci o3', '  B o1r ct o3r', 'end'].join('\n') + '\n';
  const r = solve(parseNetlist(net), Float64Array.from([f0])), s = r.S(1, 3);
  return { db: 20 * Math.log10(Math.hypot(s.re[0], s.im[0])), len };
}

function evaluate(x) {
  const [Wo, Wc, G, lf, lfo] = x, name = `Wo${Wo}_Wc${Wc}_G${G}_lf${lf}_lfo${lfo}`;
  const hit = hist.find(h => h.name === name && (h.match ?? 'diag') === matchMode); if (hit) return hit;
  const P = { W: [Wo, Wc, Wo], G: [G, G], wf, lf, p, lfo }, dS = join(dir, `${name}_n${n}`), dL = join(dir, `${name}_n${n2}`);
  for (const [nn, dd] of [[n, dS], [n2, dL]]) if (!existsSync(join(dd, 'f.s6p'))) {
    genCaseN(dir, dd.split('/').pop(), P, nn);
    const r = runCaseN(dd); if (!r.ok) throw new Error(`openEMS failed for ${dd} (see run.log)`);
    console.log(`  ${dd.split('/').pop()}: openEMS ${r.s.toFixed(0)} s`);
  }
  const b = blochN(dL, dS), c = JSON.parse(readFileSync(join(dS, 'case.json'), 'utf8')), feed = bareCLN(c);
  const prev = hist.at(-1), f = fitN([dS, dL], { C: feed.C, L: feed.L }, prev ? toParams(prev.C, prev.L) : undefined);
  const sm = symModes(f.C, f.L), bs = b.modes.filter(m => m[1] === 's').map(m => m[0]);
  // Bloch values for the two symmetric modes, matched to the fit's by value (the fit tells which is the π mode)
  const near = (e) => bs.reduce((a, v) => (Math.abs(v - e) < Math.abs(a - e) ? v : a), bs[0]);
  const epsPi = near(sm.find(m => m.pi).eps), epsC = near(sm.find(m => !m.pi).eps);
  const Zc = sqrtm(mul(f.L, inv(f.C))), cp = coupling(f.C, f.L, (epsPi + epsC) / 2);
  // centre-input match (#62): the outer pair as one line in Z0/2, the centre in Z0 (worked example 15 §1)
  const Z11 = Zc[0][0], Z13 = (Zc[0][2] + Zc[2][0]) / 2, Z12 = (Zc[0][1] + Zc[1][0]) / 2, Z22 = Zc[1][1];
  const m = matchMode === 'centre' ? [Math.log((Z11 + Z13) / Z22), Math.log(((Z11 + Z13) / 2 * Z22 - Z12 * Z12) / (Z0 * Z0 / 2)) / 2]
    : [Math.log(Zc[0][0] / Z0), Math.log(Zc[1][1] / Z0)];
  const res = [...m, (cp.db + Cdb) / 20 * Math.LN10, Math.log(epsPi / epsC)];
  const h = { name, x, match: matchMode, Zo11: Zc[0][0], Zc22: Zc[1][1], Z13, Z12, coupling: cp.db, epsPi, epsC, epsA: b.modes.find(m => m[1] === 'a')?.[0], rms: f.rms, C: f.C, L: f.L, res };
  hist.push(h); writeFileSync(logf, JSON.stringify(hist, null, 1));
  console.log(`  ${name}: Zc11 ${Zc[0][0].toFixed(2)} Zc22 ${Zc[1][1].toFixed(2)} Z12 ${Z12.toFixed(2)} Z13 ${Z13.toFixed(2)} Ω, coupling ${cp.db.toFixed(2)} dB, ε π ${epsPi.toFixed(3)} c ${epsC.toFixed(3)} a ${h.epsA?.toFixed(3)}, fit rms ${f.rms.toFixed(4)} | residual ${res.map(v => (100 * v).toFixed(2) + ' %').join(' ')}`);
  return h;
}
const norm = (r) => Math.max(...r.map(Math.abs));
function lin(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) { let pv = c; for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[pv][c])) pv = i; [M[c], M[pv]] = [M[pv], M[c]];
    for (let i = c + 1; i < n; i++) { const f = M[i][c] / M[c][c]; for (let j = c; j <= n; j++) M[i][j] -= f * M[c][j]; } }
  const x = Array(n).fill(0); for (let i = n - 1; i >= 0; i--) x[i] = (M[i][n] - M[i].slice(i + 1, n).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / M[i][i];
  return x;
}

console.log(`target: centre-to-outer ${Cdb} dB at ${f0 / 1e9} GHz, ${matchMode === 'centre' ? 'centre input' : 'lines'} matched to ${Z0} Ω, symmetric modes at equal velocity; wf ${wf} mm, p ${p} mm, ${n}/${n2} cells${lfoOff ? ', inner fingers only' : ''}`);
let x = project([opt('Wo', 1), opt('Wc', 1), opt('G', 0.6), opt('lf', 0.4), opt('lfo', 0.5)]), h = evaluate(x);
const steps = [0.05, 0.05, 0.04, 0.03, 0.1], free = lfoOff ? [0, 1, 2, 3] : [0, 1, 2, 3, 4];
let J = [0, 1, 2, 3].map(() => steps.map(() => 0));
for (const j of free) {
  let xs = [...x]; xs[j] += steps[j]; let xp = project(xs);
  if (Math.abs(xp[j] - x[j]) < steps[j] / 2) { xs = [...x]; xs[j] -= steps[j]; xp = project(xs); }
  const dx = xp[j] - x[j]; if (Math.abs(dx) < 1e-4) throw new Error(`no room to step variable ${j} from ${x}`);
  const hj = evaluate(xp); for (let i = 0; i < 4; i++) J[i][j] = (hj.res[i] - h.res[i]) / dx;
}
// minimum-norm Newton step: dx = Jᵀ (J Jᵀ)⁻¹ (−r)
// (a held variable's column is zero, so it never moves)
const mnStep = (J, r) => { const JJ = J.map(a => J.map(b => a.reduce((s, v, k) => s + v * b[k], 0))), y = lin(JJ, r.map(v => -v)); return J[0].map((_, j) => J.reduce((s, row, i) => s + row[j] * y[i], 0)); };
for (let it = 0; it < opt('iters', 10) && norm(h.res) > 0.005; it++) {
  let dx = mnStep(J, h.res);
  const s = Math.min(1, 0.1 / Math.max(...dx.map(Math.abs))); dx = dx.map(v => v * s);
  const xn = project(x.map((v, j) => v + dx[j])), hn = evaluate(xn);
  const d = xn.map((v, j) => v - x[j]), dd = d.reduce((a, v) => a + v * v, 0);
  if (dd > 0) { const y = hn.res.map((v, i) => v - h.res[i]), Jd = J.map(r => r.reduce((a, v, j) => a + v * d[j], 0)); J = J.map((r, i) => r.map((v, j) => v + (y[i] - Jd[i]) * d[j] / dd)); }
  if (norm(hn.res) < norm(h.res) || it === 0) { x = xn; h = hn; } else if (dd === 0) break;
}
console.log(`\nbest: Wo ${x[0]} Wc ${x[1]} G ${x[2]} lf ${x[3]} lfo ${x[4]} mm (wf ${wf}, p ${p}): Zc11 ${h.Zo11.toFixed(2)} Zc22 ${h.Zc22.toFixed(2)} Ω, coupling ${h.coupling.toFixed(2)} dB, ε π ${h.epsPi.toFixed(3)} c ${h.epsC.toFixed(3)} a ${h.epsA?.toFixed(3)}; worst residual ${(100 * norm(h.res)).toFixed(2)} %`);
