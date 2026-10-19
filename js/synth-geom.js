// Geometry synthesis for comb-line and interdigital arrays in microstrip (issue #13).
//
// realise(r, opts): from a homogeneous coupled-resonator design (synth.js design()) to strip widths,
// gaps, line length, tap and loading capacitors on a real substrate, closing the loop that the
// homogeneous synthesis leaves open:
//
//   1. Map: widths W and gaps S (symmetric) such that the field-solved characteristic admittance
//      matrix Yc matches the design's Y0 = Cn/η on the diagonal and the adjacent couplings
//      (Newton in ln W, ln S; Jacobian from the zero-thickness solver, residuals with the substrate's
//      copper thickness). Fabrication limits clamp W and S, with a warning.
//   2. Refine on the physical model, i.e. the inhomogeneous multi-mode section with via inductance at
//      every shorted end and open-end fringing (Kirschning–Jansen–Koster Δl as a capacitance) at every
//      open end. With all other resonators shorted at their open ends (the coupled-resonator
//      definitions used by the homogeneous synthesis):
//        · synchronous tuning: comb — each resonator's capacitor puts it at f0; interdigital — the
//          common length puts the inner resonators' mean at f0;
//        · couplings: each gap is adjusted until the pair's split-mode k = (fo² − fe²)/(fo² + fe²)
//          equals the prototype's;
//      then the tap position (Qe) and the end capacitor (resonator-1 frequency with the tap load) from
//      the S11 group delay of the singly loaded first resonator, as in the homogeneous refinement.
//   3. Pre-distort: the realised centre (−3 dB geometric mean) and −3 dB bandwidth of the whole filter
//      are measured and the tuning frequency and couplings scaled to land on target.
//
// The reduced susceptance of the active open ends comes straight from the section's 2N×2N admittance
// matrix (lossless): B_red = B_OO − B_OS (B_SS − 1/(ωLv))⁻¹ B_SO + ω(C_oe + C_l).
//
// Not modelled: the tap T-junction and the feed lines to the connectors (issue #15).
import { geometry, assess, returnLossDb, rippleEdges, idealS21 } from './synth.js';
import { parseNetlist } from './netlist.js';
import { optimise, goalCost } from './optimize.js';
import { solve as solveNet } from './solver.js';
import { Section, C0 } from './section.js';
import { makeSubstrate } from './substrates.js';
import { fieldLines } from './fieldlines.js';
import { solve as fieldSolve, microstrip } from '../solver/mtl2d.js';
import { viaL, openEnd } from './discontinuities.js';
import { msline, synthMsline, synthMscoupled } from './microstrip.js';
import { jacobiEig, rSymFunc, rMul } from './linalg.js';

const ETA0 = 376.730313668;
const fmt = (x, d = 6) => +x.toPrecision(d);
const mmS = (x) => `${fmt(x * 1e3, 6)}mm`;
const pF = (x) => `${fmt(x * 1e12, 6)}p`;

// ---------------------------------------------------------------- small linear algebra
function gaussSolve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) { const f = M[i][k] / M[k][k]; for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}
function inv(A) { return A.map((_, j) => gaussSolve(A, A.map((__, i) => (i === j ? 1 : 0)))).reduce((M, col, j) => { col.forEach((v, i) => { M[i][j] = v; }); return M; }, A.map(r => r.map(() => 0))); }

// characteristic admittance matrix Yc = C^{1/2} P diag(v) Pᵀ C^{1/2}, P: eigenvectors of C^{1/2} L C^{1/2}
export function charY(C, L) {
  const Ch = rSymFunc(C, Math.sqrt), M = rMul(rMul(Ch, L), Ch);
  for (let i = 0; i < M.length; i++) for (let j = 0; j < i; j++) { const a = (M[i][j] + M[j][i]) / 2; M[i][j] = M[j][i] = a; }
  const { d, V } = jacobiEig(M), W = rMul(Ch, V);
  return W.map((_, i) => W.map((__, j) => W[i].reduce((s, x, k) => s + x * W[j][k] / Math.sqrt(d[k]), 0)));
}

// ---------------------------------------------------------------- geometry helpers
const fullW = (half, n) => Array.from({ length: n }, (_, i) => half[Math.min(i, n - 1 - i)]);
const fullS = (half, n) => Array.from({ length: n - 1 }, (_, i) => half[Math.min(i, n - 2 - i)]);
const stripsOf = (W, S, t) => { const out = []; let x = 0; W.forEach((w, i) => { out.push(t > 0 ? { x: x + w / 2, w, t } : { x: x + w / 2, w }); x += w + (S[i] ?? 0); }); return out; };

// ---------------------------------------------------------------- 1. map Y0 → W, S
export function mapGeometry(r, sub, warnings) {
  const n = r.spec.n, er_d = r.spec.er, eta = ETA0 / Math.sqrt(er_d);
  const Ya = r.Ya, Ym = r.Ym;
  const nh = Math.ceil(n / 2), mh = Math.ceil((n - 1) / 2);
  const { h, er } = sub.dielectric, t = sub.copper.t;
  const minW = sub.fab?.minTrace ?? 0, minS = sub.fab?.minSpace ?? 0;
  // initial guess: single line for Ya; pair-level even/odd for the gaps
  const w0 = synthMsline({ Z0: 1 / Ya, h, er, t }).W;
  const S0 = Array.from({ length: mh }, (_, i) => {
    try { return synthMscoupled({ Ze: 1 / (Ya - Ym[i]), Zo: 1 / (Ya + Ym[i]), h, er, t }).S; } catch { return 0.3 * h; }
  });
  let x = [...Array(nh).fill(Math.log(w0)), ...S0.map(s => Math.log(Number.isFinite(s) && s > 0 ? s : 0.3 * h))];
  const resid = (x, thick) => {
    const W = fullW(x.slice(0, nh).map(Math.exp), n), S = fullS(x.slice(nh).map(Math.exp), n);
    const fs = fieldSolve(stripsOf(W, S, thick ? t : 0), microstrip({ h, er }));
    const Y = charY(fs.C, fs.L);
    return [...Array.from({ length: nh }, (_, i) => Math.log(Y[i][i] / Ya)), ...Array.from({ length: mh }, (_, i) => Math.log(-Y[i][i + 1] / Ym[i]))];
  };
  const jac = (x) => {
    const f0 = resid(x, false), J = f0.map(() => new Array(x.length).fill(0));
    x.forEach((_, j) => { const xp = [...x]; xp[j] += 1e-3; const fp = resid(xp, false); fp.forEach((v, i) => { J[i][j] = (v - f0[i]) / 1e-3; }); });
    return { f0, J };
  };
  // Newton on the zero-thickness model
  let J;
  for (let it = 0; it < 20; it++) {
    const jj = jac(x); J = jj.J;
    const dx = gaussSolve(J, jj.f0.map(v => -v));
    const step = Math.max(...dx.map(Math.abs)); const damp = step > 0.5 ? 0.5 / step : 1;
    x = x.map((v, i) => v + damp * dx[i]);
    if (step < 1e-9) break;
  }
  // chord iterations with the copper thickness (Jacobian kept from the thin model)
  let fres = Infinity;
  for (let it = 0; it < 12; it++) {
    const f = resid(x, true); fres = Math.max(...f.map(Math.abs));
    if (fres < 1e-7) break;
    const dx = gaussSolve(J, f.map(v => -v));
    x = x.map((v, i) => v + dx[i]);
  }
  if (!(fres < 1e-3)) warnings.push(`the widths and gaps could not be matched to the design's admittance matrix (residual ${fmt(fres, 3)}): the couplings are probably too strong for edge-coupled microstrip; reduce the bandwidth`);
  let Wh = x.slice(0, nh).map(Math.exp), Sh = x.slice(nh).map(Math.exp);
  Wh.forEach((w, i) => { if (w < minW) { warnings.push(`line ${i + 1}: W = ${fmt(w * 1e3, 4)} mm is below the minimum trace ${minW * 1e3} mm; clamped (raise Zr's admittance level, i.e. lower Zr)`); Wh[i] = minW; } });
  Sh.forEach((s, i) => { if (s < minS) { warnings.push(`gap ${i + 1}–${i + 2}: S = ${fmt(s * 1e3, 4)} mm is below the minimum space ${minS * 1e3} mm; clamped (the bandwidth is too wide for edge coupling on this substrate)`); Sh[i] = minS; } });
  return { Wh, Sh };
}

// ---------------------------------------------------------------- 2. the physical model
// Context: line ends, via inductance, open-end capacitances, section factory.
export function physContext(r, sub, via) {
  const n = r.spec.n, structure = r.spec.structure, fRef = (r.spec.target ?? r.spec).f0;
  const { h, er } = sub.dielectric, t = sub.copper.t;
  const shortAtA = (i) => structure === 'comb' || i % 2 === 0;           // 0-based line index
  const Lv = via ? viaL({ d: via.d, h, n: via.n }).L : 0;
  const coeOf = (W) => W.map(w => { const oe = openEnd({ W: w, h, er, t }), l = msline({ W: w, h, er, t }); return oe.dl * Math.sqrt(l.epsEff) / (C0 * l.Z0); });
  const section = (W, S, thDeg, f) => {
    const fl = fieldLines({ W, S, sub, f0: fRef });          // same cache entry as the netlist's sections
    return new Section({ name: 'array', C: fl.C, L: fl.L, Q: Infinity, len: (s) => { const nbar = s.v.reduce((a, v) => a + C0 / v, 0) / s.v.length; return thDeg / 360 * C0 / nbar / f; } });
  };
  // reduced susceptance at the open ends of the active lines (others' open ends shorted)
  const Bred = (sec, f, active, shunt /* per line, F */) => {
    const N = n, Y = sec.admittance(f), B = (i, j) => Y.im[i * 2 * N + j];
    const open = (i) => (shortAtA(i) ? N + i : i), shrt = (i) => (shortAtA(i) ? i : N + i);
    const O = active.map(open), S = Array.from({ length: N }, (_, i) => shrt(i)), w = 2 * Math.PI * f;
    let R = O.map(a => O.map(b => B(a, b)));
    if (Lv > 0) {
      const M = S.map(a => S.map(b => B(a, b))); S.forEach((_, k) => { M[k][k] -= 1 / (w * Lv); });
      const Mi = inv(M);
      R = R.map((row, p) => row.map((v, q) => { let s = 0; for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) s += B(O[p], S[a]) * Mi[a][b] * B(S[b], O[q]); return v - s; }));
    }
    active.forEach((i, p) => { R[p][p] += w * shunt[i]; });
    return R;
  };
  return { n, structure, shortAtA, Lv, coeOf, section, Bred };
}

// resonance of one active line (susceptance increases through zero), searched around f
function root(g, f, rel = 0.3) {
  const N = 240; let fa = f * (1 - rel), ga = g(fa), best = null;
  for (let k = 1; k <= N; k++) {
    const fb = f * (1 - rel + 2 * rel * k / N), gb = g(fb);
    if (ga < 0 && gb >= 0) { let lo = fa, hi = fb; for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (g(m) < 0) lo = m; else hi = m; } const fr = (lo + hi) / 2; if (!best || Math.abs(fr - f) < Math.abs(best - f)) best = fr; }
    fa = fb; ga = gb;
  }
  return best;
}
const eig2 = (M) => { const tr = (M[0][0] + M[1][1]) / 2, d = Math.hypot((M[0][0] - M[1][1]) / 2, M[0][1]); return [tr - d, tr + d]; };

/** Split-mode coupling of resonators i, i+1 (others shorted at their open ends): k = (f2² − f1²)/(f2² + f1²). */
export function pairK(ctx, sec, i, shunt, f) {
  const ev = (lam) => (ff) => eig2(ctx.Bred(sec, ff, [i, i + 1], shunt))[lam];
  const f1 = root(ev(1), f), f2 = root(ev(0), f);                // the larger eigenvalue crosses zero first
  return (f2 * f2 - f1 * f1) / (f2 * f2 + f1 * f1);
}
/** Loading capacitance that tunes resonator i (others shorted at their open ends) to f. */
export function syncCap(ctx, sec, i, shunt, f) { return -ctx.Bred(sec, f, [i], shunt)[0][0] / (2 * Math.PI * f); }

// ---------------------------------------------------------------- netlist
function buildNetlist(r, st, sub, via, opts = {}) {
  const s = r.spec, n = s.n, T = s.target ?? s, structure = s.structure;
  const { tapsOn = [1, n], portsOn = [1, n], groundOthers = false, lossless = false, freq } = opts;
  const q = T.f0 / st.fTune;                                     // degrees at the tuning frequency → at .ref
  const th0 = st.thDeg * q, tt = st.ttDeg * q;
  const nh = Math.ceil(n / 2), mh = Math.ceil((n - 1) / 2);
  const symW = (i) => `w${Math.min(i, n + 1 - i)}`, symS = (i) => `s${Math.min(i, n - i)}${Math.min(i, n - i) + 1}`;
  const symC = (i) => `cl${Math.min(i, n + 1 - i)}`;
  const L = [];
  L.push(`.title ${structure === 'comb' ? 'Comb-line' : 'Interdigital'} ${s.type} n=${n}${s.type === 'chebyshev' ? ` ${s.ripple}dB` : ''}, f0 = ${fmt(T.f0 / 1e9, 6)} GHz, FBW = ${fmt(T.fbw * 100, 4)} % on ${sub.id} (synthesised geometry)`);
  (st.report || []).forEach(x => L.push(`# ${x}`));
  (st.warnings || []).forEach(w => L.push(`# WARNING: ${w}`));
  const [fa, fb] = rippleEdges(T.f0, T.fbw);
  const span = Math.max(4 * T.fbw, 0.2);
  const fstart = T.f0 * Math.max(0.05, 1 - span), fstop = T.f0 * (1 + span);
  L.push(freq ? `.freq ${freq}` : `.freq ${fmt(fstart / 1e9, 6)}G ${fmt(fstop / 1e9, 6)}G 801`);
  L.push(`.ref ${fmt(T.f0 / 1e9, 9)}G`);
  L.push(`.substrate ${sub.id}`);
  L.push(opts.fixLength ? `.param th0 = ${fmt(th0, 9)}` : `.param th0 = ${fmt(th0, 9)} tune ${fmt(th0 * 0.97, 6)} ${fmt(th0 * 1.03, 6)}`);
  L.push(`.param tt = ${fmt(tt, 7)} tune ${fmt(tt * 0.7, 4)} ${fmt(Math.min(tt * 1.3, th0 * 0.98), 4)}`);
  const wr = opts.wRange ?? [0.85, 1.15];
  for (let i = 1; i <= nh; i++) L.push(`.param w${i} = ${mmS(st.Wh[i - 1])} tune ${mmS(Math.max(st.Wh[i - 1] * wr[0], sub.fab?.minTrace ?? 0))} ${mmS(st.Wh[i - 1] * wr[1])}`);
  const sr = opts.gapRange ?? [0.8, 1.25];
  for (let i = 1; i <= mh; i++) L.push(`.param s${i}${i + 1} = ${mmS(st.Sh[i - 1])} tune ${mmS(Math.max(st.Sh[i - 1] * sr[0], sub.fab?.minSpace ?? 0))} ${mmS(st.Sh[i - 1] * sr[1])}`);
  if (structure === 'comb') for (let i = 1; i <= nh; i++) L.push(`.param cl${i} = ${pF(st.Cl[i - 1])} tune ${pF(st.Cl[i - 1] * 0.85)} ${pF(st.Cl[i - 1] * 1.15)}`);
  else if (st.Cl1 > 0) L.push(`.param cl1 = ${pF(st.Cl1)} tune ${pF(st.Cl1 * 0.3)} ${pF(st.Cl1 * 2 + 0.05e-12)}   # end-resonator trim (tap-loading compensation)`);
  L.push('');
  portsOn.forEach(i => L.push(`port t${i} ${s.R0}`));
  L.push('');
  const { secs } = geometry(structure, n, st.thDeg * Math.PI / 180, st.ttDeg * Math.PI / 180, { tapsOn, portsOn, groundOthers });
  const deg = (x) => x * 180 / Math.PI;
  const lenExpr = (x) => {
    const c = [['tt*1deg', st.ttDeg], ['(th0-tt)*1deg', st.thDeg - st.ttDeg], ['(th0-2*tt)*1deg', st.thDeg - 2 * st.ttDeg], ['(2*tt-th0)*1deg', 2 * st.ttDeg - st.thDeg], ['th0*1deg', st.thDeg]]
      .find(([, v]) => Math.abs(v - deg(x)) < 1e-7);
    return c ? c[0] : `${fmt(deg(x) * q, 9)}deg`;
  };
  // shorted ends → via nodes; zero-length guard: sections shorter than 1e-9° are dropped by geometry()
  const shortNode = (i) => (via ? `g${i}` : '0');
  const shortAtA = (i) => structure === 'comb' || i % 2 === 1;   // 1-based
  secs.forEach((sec, p) => {
    const mapEnd = (nodes, atA) => nodes.map((x, k) => {
      const i = k + 1;
      if (x !== '0') return x;
      // '0' at a shorted end is the via node; '0' at an open end (groundOthers) stays ground
      const isShortEnd = shortAtA(i) ? (atA && p === 0) : (!atA && p === secs.length - 1);
      return isShortEnd ? shortNode(i) : '0';
    });
    if (opts.linear) {
      // C and L linearised in the gap parameters around the last field solve (fast optimiser model)
      const { C0m, L0m, dC, dL, names, X0 } = opts.linear;
      const ex = (M0, dM, i, j) => `${M0[i][j]}${dM.map((D, g) => `${D[i][j] >= 0 ? '+' : ''}${D[i][j]}*(${names[g]}-${X0[g]})`).join('')}`;
      L.push(`cline S${p + 1}`);
      L.push(`  C [${C0m.map((row, i) => row.map((_, j) => ex(C0m, dC, i, j)).join(' ')).join('; ')}]`);
      L.push(`  L [${L0m.map((row, i) => row.map((_, j) => ex(L0m, dL, i, j)).join(' ')).join('; ')}]`);
    } else {
      L.push(`cline S${p + 1}`, '  geom msl');
      L.push(`  W [${Array.from({ length: n }, (_, k) => symW(k + 1)).join(' ')}]`);
      L.push(`  S [${Array.from({ length: n - 1 }, (_, k) => symS(k + 1)).join(' ')}]`);
    }
    L.push(`  len ${lenExpr(sec.len)}`);
    if (lossless) L.push('  Q 1e30');
    L.push(`  A ${mapEnd(sec.A, true).join(' ')}`, `  B ${mapEnd(sec.B, false).join(' ')}`, 'end');
  });
  if (via) for (let i = 1; i <= n; i++) L.push(`via V${i} g${i} d=${fmt(via.d * 1e3, 4)}mm n=${via.n}${lossless ? '' : ''}`);
  const W = fullW(st.Wh, n), coe = st.coe;
  for (let i = 1; i <= n; i++) {
    const node = `r${i}`;
    if (groundOthers && !portsOn.includes(i) && !(i === 1)) continue;
    if (structure === 'comb') L.push(`C${i} ${node} 0 ${symC(i)}`);
    else if (st.Cl1 > 0 && (i === 1 || i === n)) L.push(`C${i} ${node} 0 cl1`);
    L.push(`Coe${i} ${node} 0 ${pF(coe[i - 1])}   # open-end fringing (Δl of a ${fmt(W[i - 1] * 1e3, 4)} mm line)`);
  }
  if (!opts.bare) {
    L.push('');
    const ideal = s.type === 'chebyshev' ? `cheby(${n},${s.ripple},${fmt(T.f0, 9)},${fmt(T.fbw, 9)})` : `butter(${n},${fmt(T.f0, 9)},${fmt(T.fbw, 9)})`;
    if (s.type === 'chebyshev') L.push(`.goal db(S11) < ${fmt(-returnLossDb(s.ripple), 4)} ${fmt(fa + 0.02 * (fb - fa), 8)} ${fmt(fb - 0.02 * (fb - fa), 8)}`);
    // the bandwidth bounded from above (the return-loss goal bounds it from below); the skirts are left
    // to the physics, which makes them asymmetric in microstrip
    const [l3, h3] = idealEdges(r, T, 0.5), m3 = 0.015 * (h3 - l3);
    L.push(`.goal db(S21) < -3 ${fmt(fstart, 8)} ${fmt(l3 - m3, 8)}   # −3 dB band at most 3 % wider than ideal`);
    L.push(`.goal db(S21) < -3 ${fmt(h3 + m3, 8)} ${fmt(fstop, 8)}`);
    L.push(`.plot ylim=-70,0 db(S11) db(S21) db(${ideal})`, '.plot gd(S21)', '.smith S11');
  }
  return L.join('\n') + '\n';
}

// S11 group-delay peak of the singly loaded first resonator → f_res, Qe (as synth.js measureQe)
function measureQe(r, st, sub, via, Qe) {
  let fc = st.fTune, span = Math.min(6 * fc / Math.max(Qe, 1), 0.4 * fc), best = null;
  for (let pass = 0; pass < 3; pass++) {
    const f1 = Math.max(fc - span, fc * 0.05), f2 = fc + span;
    // the .ref of the generated netlist is the target f0; the single-resonator sweep is absolute
    const d = parseNetlist(buildNetlist(r, st, sub, via, { tapsOn: [1], portsOn: [1], groundOthers: true, lossless: true, bare: true, freq: `${f1} ${f2} 401` }));
    const res = solveNet(d), s = res.S(1, 1), F = res.freq;
    const ph = Array.from(F, (_, k) => Math.atan2(s.im[k], s.re[k]));
    for (let k = 1; k < ph.length; k++) { while (ph[k] - ph[k - 1] > Math.PI) ph[k] -= 2 * Math.PI; while (ph[k] - ph[k - 1] < -Math.PI) ph[k] += 2 * Math.PI; }
    const tau = (k) => -(ph[k + 1] - ph[k - 1]) / (2 * Math.PI * (F[k + 1] - F[k - 1]));
    let km = 1, tm = -Infinity;
    for (let k = 1; k < F.length - 1; k++) { const tk = tau(k); if (tk > tm) { tm = tk; km = k; } }
    let fr = F[km], tr = tm;
    if (km > 1 && km < F.length - 2) {
      const y0 = tau(km - 1), y1 = tau(km), y2 = tau(km + 1), den = y0 - 2 * y1 + y2;
      if (den < 0) { const dx = 0.5 * (y0 - y2) / den; fr = F[km] + dx * (F[1] - F[0]); tr = y1 - 0.25 * (y0 - y2) * dx; }
    }
    best = { fres: fr, Qe: 2 * Math.PI * fr * tr / 4 };
    fc = fr; span = Math.max(span / 8, 3 * fr / Math.max(best.Qe, 1) / 4);
  }
  return best;
}

// ---------------------------------------------------------------- the refinement
function refine(r, sub, via, geom, fTune, kScale, warnings, log) {
  const n = r.spec.n, structure = r.spec.structure;
  const ctx = physContext(r, sub, via);
  const nh = Math.ceil(n / 2), mh = Math.ceil((n - 1) / 2);
  const kT = r.k.map(k => k * kScale);
  let Wh = [...geom.Wh], Sh = [...geom.Sh];
  let thDeg = structure === 'comb' ? r.theta0 * 180 / Math.PI : 90;
  const w0 = 2 * Math.PI * fTune;
  const W = () => fullW(Wh, n), S = () => fullS(Sh, n);
  let Cl = new Array(n).fill(0), coe = ctx.coeOf(W());
  const tune = (sec) => {
    coe = ctx.coeOf(W());
    if (structure === 'comb') {
      Cl = Array.from({ length: n }, (_, i) => syncCap(ctx, sec, i, coe, fTune));
      Cl.forEach((c, i) => { if (!(c > 0)) throw new Error(`resonator ${i + 1} needs a negative loading capacitor at θ0 = ${fmt(thDeg, 4)}°: lower θ0`); });
    } else {
      // common length: inner resonators' mean frequency at fTune (θ ∝ f for a fixed physical length)
      for (let it = 0; it < 8; it++) {
        const sec2 = ctx.section(W(), S(), thDeg, fTune);
        const inner = Array.from({ length: n }, (_, i) => i).filter(i => n <= 2 || (i > 0 && i < n - 1));
        const f = inner.map(i => root(ff => ctx.Bred(sec2, ff, [i], coe)[0][0], fTune));
        const fm = f.reduce((a, b) => a + b, 0) / f.length;
        thDeg *= fm / fTune;
        if (Math.abs(fm / fTune - 1) < 1e-9) { r._spread = (Math.max(...f) - Math.min(...f)) / fTune; break; }
      }
    }
  };
  const kOf = (sec) => Array.from({ length: mh }, (_, i) => pairK(ctx, sec, i, structure === 'comb' ? Cl.map((c, j) => c + coe[j]) : coe, fTune));
  // gap loop
  let slope = null, prev = null;
  for (let it = 0; it < 25; it++) {
    let sec = ctx.section(W(), S(), thDeg, fTune);
    tune(sec); sec = ctx.section(W(), S(), thDeg, fTune);
    const k = kOf(sec), err = k.map((v, i) => Math.log(v / kT[i]));
    log.push(`gaps ${Sh.map(s => fmt(s * 1e3, 5)).join(' ')} mm: k/k_target − 1 = ${err.map(e => fmt(Math.expm1(e), 3)).join(' ')}`);
    if (Math.max(...err.map(Math.abs)) < 2e-4) break;
    if (!slope) slope = err.map(() => -2.0);                          // d ln k / d ln S, refined by secant
    else slope = slope.map((s0, i) => { const ds = Math.log(Sh[i] / prev.Sh[i]), de = err[i] - prev.err[i]; return Math.abs(ds) > 1e-6 && de / ds < -0.05 ? de / ds : s0; });
    prev = { Sh: [...Sh], err };
    Sh = Sh.map((s0, i) => s0 * Math.exp(Math.max(-0.5, Math.min(0.5, -err[i] / slope[i]))));
    const minS = sub.fab?.minSpace ?? 0;
    Sh = Sh.map((s0, i) => { if (s0 < minS) { if (!warnings.some(w => w.startsWith(`gap ${i + 1}`))) warnings.push(`gap ${i + 1}–${i + 2} would need ${fmt(s0 * 1e3, 4)} mm, below the minimum space ${minS * 1e3} mm; held at the minimum`); return minS; } return s0; });
  }
  const st = { Wh, Sh, thDeg, fTune, coe, Cl: Cl.slice(0, nh), Cl1: 0 };
  // tap: Qe and resonator-1 frequency
  const Qe = r.Qe;
  const b = (() => { const sec = ctx.section(W(), S(), thDeg, fTune), shunt = structure === 'comb' ? Cl.map((c, j) => c + coe[j]) : coe; const df = fTune * 1e-4; return (w0 / 2) * (ctx.Bred(sec, fTune + df, [0], shunt)[0][0] - ctx.Bred(sec, fTune - df, [0], shunt)[0][0]) / (2 * Math.PI * 2 * df); })();
  let tt = Math.asin(Math.min(0.95, Math.sin(thDeg * Math.PI / 180) * Math.sqrt(b * r.spec.R0 / Qe))) * 180 / Math.PI;
  let cl1 = structure === 'comb' ? Cl[0] : 0, m;
  for (let it = 0; it < 15; it++) {
    st.ttDeg = tt; if (structure === 'comb') st.Cl[0] = cl1; else st.Cl1 = cl1;
    m = measureQe(r, st, sub, via, Qe);
    const dq = m.Qe / Qe;
    tt = Math.min(Math.asin(Math.min(0.999, Math.sin(tt * Math.PI / 180) * Math.sqrt(dq))) * 180 / Math.PI, thDeg * 0.98);
    cl1 = Math.max(0, cl1 + (2 * Math.PI * m.fres - w0) * 2 * b / (w0 * w0));
    if (Math.abs(dq - 1) < 1e-4 && Math.abs(m.fres / fTune - 1) < 1e-6) break;
  }
  st.ttDeg = tt; if (structure === 'comb') st.Cl[0] = cl1; else st.Cl1 = cl1;
  m = measureQe(r, st, sub, via, Qe);
  if (Math.abs(m.Qe / Qe - 1) > 0.01) warnings.push(`the tap reaches Qe = ${fmt(m.Qe, 4)} instead of ${fmt(Qe, 4)}`);
  if (Math.abs(m.fres / fTune - 1) > 0.02 * r.spec.fbw) warnings.push(`tap loading leaves resonator 1 at ${fmt(m.fres / 1e9, 6)} GHz${structure === 'interdigital' ? ' (an end capacitor can only lower it)' : ''}`);
  st.tap = m;
  return st;
}

// ---------------------------------------------------------------- 3. polish on the physical model
// Non-adjacent couplings (mostly inductive in microstrip, so they fall off slowly: k13/k12 ≈ 0.2 is
// typical) distort the nearest-neighbour design and make an exact Chebyshev response unreachable.
// The goal optimiser then works on the actual spec — return loss across the ripple band, with the
// −3 dB band bounded from above — moving gaps, widths, length, loading capacitors and tap on a model
// whose C and L are linearised in the gaps and widths around the last field solve. The geometry is
// solved again and the step repeated (a trust-region loop with ±15 % steps).
// C, L and their derivatives in the gaps and widths around the current geometry → linearised netlist
function linearModel(r, st, sub, via, opts) {
  const n = r.spec.n, mh = Math.ceil((n - 1) / 2), nh = Math.ceil(n / 2), T = r.spec.target ?? r.spec;
  const W = fullW(st.Wh, n), S = fullS(st.Sh, n);
  const base = fieldLines({ W, S, sub, f0: T.f0 });
  const dC = [], dL = [], names = [], X0 = [];
  // derivatives from the zero-thickness solver (~10× faster); the base point is the exact thick solve
  const thin = (W2, S2) => fieldSolve(stripsOf(W2, S2, 0), microstrip({ h: sub.dielectric.h, er: sub.dielectric.er }));
  const b0 = thin(W, S);
  const diff = (W2, S2, dx) => { const fl = thin(W2, S2); dC.push(fl.C.map((row, i) => row.map((v, j) => (v - b0.C[i][j]) / dx))); dL.push(fl.L.map((row, i) => row.map((v, j) => (v - b0.L[i][j]) / dx))); };
  for (let g = 0; g < mh; g++) { const Sh2 = [...st.Sh], ds = st.Sh[g] * 0.02; Sh2[g] += ds; diff(W, fullS(Sh2, n), ds); names.push(`s${g + 1}${g + 2}`); X0.push(st.Sh[g]); }
  for (let g = 0; g < nh; g++) { const Wh2 = [...st.Wh], dw = st.Wh[g] * 0.02; Wh2[g] += dw; diff(fullW(Wh2, n), S, dw); names.push(`w${g + 1}`); X0.push(st.Wh[g]); }
  return buildNetlist(r, st, sub, via, { linear: { C0m: base.C, L0m: base.L, dC, dL, names, X0 }, lossless: true, portsOn: [1, n], fixLength: false, ...opts });
}
function applyParams(r, st, best) {
  const T = r.spec.target ?? r.spec, q = T.f0 / st.fTune;
  const Sh = st.Sh.map((_, k) => best[`s${k + 1}${k + 2}`] ?? st.Sh[k]), Wh = st.Wh.map((_, k) => best[`w${k + 1}`] ?? st.Wh[k]);
  const change = Math.max(...Sh.map((v, k) => Math.abs(v / st.Sh[k] - 1)), ...Wh.map((v, k) => Math.abs(v / st.Wh[k] - 1)));
  st.Sh = Sh; st.Wh = Wh;
  if (best.tt != null) st.ttDeg = best.tt / q;
  if (best.th0 != null) st.thDeg = best.th0 / q;
  if (r.spec.structure === 'interdigital') { if (best.cl1 != null) st.Cl1 = best.cl1; }
  else st.Cl = st.Cl.map((c, k) => best[`cl${k + 1}`] ?? c);
  return change;
}
// frequencies where the ideal |S21|² = p, below and above the band
function idealEdges(r, T, p) {
  const id = (f) => idealS21(r.spec.type, r.spec.n, r.spec.ripple, T.f0, T.fbw, f) ** 2;
  const find = (a, b, rising) => { for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if ((id(m) < p) === rising) a = m; else b = m; } return (a + b) / 2; };
  return [find(T.f0 * 0.5, T.f0, true), find(T.f0, T.f0 * 1.5, false)];
}
// Minimax stage: the netlist's own goals (return loss across the ripple band, skirt limits) with the
// Nelder–Mead optimiser on the linearised model, on a short sweep; ±15 % trust region per round.
function polishGoals(r, st, sub, via, log, rounds = 8) {
  const T = r.spec.target ?? r.spec, [fa, fb] = rippleEdges(T.f0, T.fbw);
  const lo = r.skirt ? r.skirt.fl : fa - (fb - fa) / 2, hi = r.skirt ? r.skirt.fh : fb + (fb - fa) / 2;
  let prev = null;
  for (let round = 0; round < rounds; round++) {
    const text = linearModel(r, st, sub, via, { freq: `${lo} ${hi} 161`, gapRange: [0.85, 1.15], wRange: [0.85, 1.15] });
    const g = optimise(text, { maxiter: 600 }); let it, last;
    while (!(it = g.next()).done) last = it.value;
    const out = it.value ?? last;
    const change = applyParams(r, st, out.best);
    // judge on the exact geometry (the linearised model is only good near its base point)
    const de = parseNetlist(buildNetlist(r, st, sub, via, { lossless: true, freq: `${lo} ${hi} 161` }));
    const exact = goalCost(de, solveNet(de)).cost;
    log.push(`goal polish ${round + 1}: cost ${out.cost.toExponential(2)} (linearised), ${exact.toExponential(2)} (exact geometry), largest W/S change ${fmt(change * 100, 3)} %`);
    if (exact === 0 || (prev != null && exact > prev * 0.9 && change < 0.01)) break;
    prev = exact;
  }
}

/**
 * r: design() result; opts: { substrate (id), via: {d, n} | null, iterations }
 * Returns { netlist, geometry: {W, S, len, tap}, report: [..], warnings: [..], assess }
 */
export function realise(r, opts = {}) {
  const sub = makeSubstrate(opts.substrate ?? 'jlc-ro4350b-0.762');
  const via = opts.via === null ? null : { d: opts.via?.d ?? Math.max(0.3e-3, sub.fab?.minDrill ?? 0.3e-3), n: opts.via?.n ?? 2 };
  const warnings = [...r.warnings], log = [];
  if (opts.progress) { const push = log.push.bind(log); log.push = (...a) => { a.forEach(x => opts.progress(x)); return push(...a); }; }
  const T = r.spec.target ?? r.spec;
  const geom = mapGeometry(r, sub, warnings);
  const st = refine(r, sub, via, geom, r.spec.f0, 1, warnings, log);
  st.warnings = warnings;
  // the response shape is judged lossless (as the homogeneous synthesis is); the loss is reported separately
  const stat = (tag) => { const x = assess({ ...r, netlist: buildNetlist(r, st, sub, via, { lossless: true }) }); log.push(`${tag}: centre ${fmt(x.fc / 1e9, 7)} GHz, −3 dB FBW ${fmt(x.bw3 * 100, 5)} % (ideal ${fmt(x.bw3ideal * 100, 5)} %), worst core RL ${fmt(x.rlCore, 4)} dB (lossless)`); return x; };
  let a = stat('coupled-resonator refinement');
  if (opts.polish !== false && r.spec.type === 'chebyshev') {
    polishGoals(r, st, sub, via, log); a = stat('after the goal polish');
  }
  const n = r.spec.n, W = fullW(st.Wh, n), S = fullS(st.Sh, n);
  const sec = physContext(r, sub, via).section(W, S, st.thDeg, st.fTune);
  const len = sec.len, tapLen = len * st.ttDeg / st.thDeg;
  // loss: the final netlist with the substrate's conductor and dielectric loss
  const dl = parseNetlist(buildNetlist(r, st, sub, via, { bare: true, freq: `${T.f0} ${T.f0} 1` }));
  const s21 = solveNet(dl).S(2, 1), il0 = -20 * Math.log10(Math.hypot(s21.re[0], s21.im[0]));
  const Qs = dl.sections[0].Qm;
  if (isFinite(a.rlTarget) && a.rlCore < a.rlTarget - 1) warnings.push(`the polished response reaches ${fmt(a.rlCore, 4)} dB return loss, short of the ideal ${fmt(a.rlTarget, 4)} dB: the non-adjacent couplings of this geometry could not be fully compensated; try another θ0 or Zr, or run the optimiser`);
  if (isFinite(a.bw3) && Math.abs(a.bw3 / a.bw3ideal - 1) > 0.05) warnings.push(`the −3 dB bandwidth is ${fmt(a.bw3 * 100, 4)} %, ${fmt((a.bw3 / a.bw3ideal - 1) * 100, 3)} % from the ideal ${fmt(a.bw3ideal * 100, 4)} %`);
  const report = [
    `substrate ${sub.id}: h ${fmt(sub.dielectric.h * 1e3, 4)} mm, εr ${sub.dielectric.er}, copper ${fmt(sub.copper.t * 1e6, 4)} µm; field-solved array`,
    `widths ${W.map(w => fmt(w * 1e3, 4)).join(' ')} mm; gaps ${S.map(s => fmt(s * 1e3, 4)).join(' ')} mm`,
    `line length ${fmt(len * 1e3, 5)} mm (${fmt(st.thDeg * T.f0 / st.fTune, 5)}° at f0, mean modal velocity); tap ${fmt(tapLen * 1e3, 5)} mm from the shorted end`,
    via ? `shorted ends: ${via.n} × ${fmt(via.d * 1e3, 3)} mm vias (${fmt(physContext(r, sub, via).Lv * 1e12, 4)} pH); open ends: KJK Δl as a capacitance` : 'shorted ends ideal (no vias)',
    `realised (lossless): centre ${fmt(a.fc / 1e9, 6)} GHz, −3 dB FBW ${fmt(a.bw3 * 100, 4)} % (ideal ${fmt(a.bw3ideal * 100, 4)} %), worst return loss over the central 80 % of the ripple band ${fmt(a.rlCore, 4)} dB${isFinite(a.rlTarget) ? ` (ideal ${fmt(a.rlTarget, 4)} dB)` : ''}`,
    `insertion loss at f0 ${fmt(il0, 3)} dB with the substrate's conductor and dielectric loss (modal Q ${Qs.map(q => fmt(q, 3)).join(', ')})`,
    'not modelled: tap T-junction and feed lines (issue #15)',
  ];
  if (r.spec.structure === 'interdigital' && r._spread > 0) report.splice(3, 0, `inner resonators spread by ${fmt(r._spread * 100, 3)} % of f0 with a common length (inhomogeneous medium)`);
  st.report = report; st.warnings = warnings;
  const netlist = buildNetlist(r, st, sub, via);
  return { netlist, geometry: { W, S, len, tapLen, thDeg: st.thDeg * T.f0 / st.fTune, Cl: r.spec.structure === 'comb' ? fullW(st.Cl, n) : null, Cl1: st.Cl1 }, report, warnings, assess: a, log, substrate: sub.id };
}

