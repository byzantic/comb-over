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
import { assess, returnLossDb, rippleEdges, idealS21 } from './synth.js';
import { parseNetlist } from './netlist.js';
import { optimise, goalCost } from './optimize.js';
import { solve as solveNet } from './solver.js';
import { Section, C0 } from './section.js';
import { makeSubstrate } from './substrates.js';
import { fieldLines } from './fieldlines.js';
import { solve as fieldSolve, microstrip } from '../solver/mtl2d.js';
import { viaL, openEnd } from './discontinuities.js';
import { smdForCeff, padC, TRIMMER_FOOTPRINT, TRIMMER_DEFAULTS, SMD_DEFAULT_Q } from './capacitors.js';
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
  // board layout (#15): the template reads the geometry, vias, taps and capacitors from this netlist
  if (!opts.bare && !opts.linear) L.push(`.layout ${structure}${structure === 'comb' && (st.cap?.type ?? 'ideal') === 'ideal' ? ' cap=smd-0603' : ''}`);
  L.push(opts.fixLength ? `.param th0 = ${fmt(th0, 9)}` : `.param th0 = ${fmt(th0, 9)} tune ${fmt(th0 * 0.97, 6)} ${fmt(th0 * 1.03, 6)}`);
  L.push(`.param tt = ${fmt(tt, 7)} tune ${fmt(Math.max(tt * 0.7, st.hwDeg * q * 1.2), 4)} ${fmt(Math.min(tt * 1.3, th0 - st.hwDeg * q * 1.2), 4)}`);
  L.push(`.param wf = ${mmS(st.wf)}   # tap feed width (${s.R0} ohm)`);
  L.push(`.param hw = ${fmt(st.hwDeg * q, 9)}   # half the feed width in degrees at f0 (the tap junction spans tt ± hw)`);
  const wr = opts.wRange ?? [0.85, 1.15];
  for (let i = 1; i <= nh; i++) L.push(opts.fixWidths ? `.param w${i} = ${mmS(st.Wh[i - 1])}` : `.param w${i} = ${mmS(st.Wh[i - 1])} tune ${mmS(Math.max(st.Wh[i - 1] * wr[0], sub.fab?.minTrace ?? 0))} ${mmS(st.Wh[i - 1] * wr[1])}`);
  const sr = opts.gapRange ?? [0.8, 1.25];
  for (let i = 1; i <= mh; i++) L.push(`.param s${i}${i + 1} = ${mmS(st.Sh[i - 1])} tune ${mmS(Math.max(st.Sh[i - 1] * sr[0], sub.fab?.minSpace ?? 0))} ${mmS(st.Sh[i - 1] * sr[1])}`);
  if (structure === 'comb') for (let i = 1; i <= nh; i++) L.push(`.param cl${i} = ${pF(st.Cl[i - 1])} tune ${pF(st.Cl[i - 1] * 0.85)} ${pF(st.Cl[i - 1] * 1.15)}`);
  else if (st.ext1 > 0) L.push(`.param ext1 = ${mmS(st.ext1)} tune ${mmS(st.ext1 * 0.3)} ${mmS(st.ext1 * 2 + 0.05e-3)}   # end-resonator extension (tap-loading compensation)`);
  L.push('');
  portsOn.forEach(i => L.push(`port t${i} ${s.R0}`));
  L.push('');
  // planes along the lines (degrees at the tuning frequency), symbolic in th0, tt and hw so the
  // section lengths follow the parameters: ends, and each tap's junction (tap ± hw, hw = half the
  // feed width). Inside a junction the tapped line is carried by the tee; its strip in the coupled
  // section is left floating there (it still shapes the fields of its neighbours).
  const shortAtA = (i) => structure === 'comb' || i % 2 === 1;   // 1-based
  const P = (c) => ({ c, v: c[0] * st.thDeg + c[1] * st.ttDeg + c[2] * st.hwDeg });
  const tapC = (i) => (shortAtA(i) ? [0, 1, 0] : [1, -1, 0]);
  let planes = [P([0, 0, 0]), P([1, 0, 0])];
  for (const i of tapsOn) { const c = tapC(i); planes.push(P([c[0], c[1], -1]), P([c[0], c[1], 1])); }
  planes = planes.sort((a, b) => a.v - b.v).filter((p, k, a) => k === 0 || p.v - a[k - 1].v > 1e-9);
  if (planes[0].v < -1e-9 || planes.at(-1).v > st.thDeg + 1e-9) throw new Error('the tap junction does not fit on the line (tap too close to an end)');
  const same = (a, b) => Math.abs(a.v - b.v) < 1e-9;
  const nodeAt = (i, k) => {
    const pl = planes[k];
    const atA = same(pl, P([0, 0, 0])), atB = same(pl, P([1, 0, 0]));
    const shortEnd = shortAtA(i) ? atA : atB, openEnd = shortAtA(i) ? atB : atA;
    if (shortEnd) return via ? `g${i}` : '0';
    if (openEnd) return groundOthers && !portsOn.includes(i) && i !== 1 ? '0' : `r${i}`;
    if (tapsOn.includes(i)) { const c = tapC(i); if (same(pl, P([c[0], c[1], -1]))) return `ta${i}`; if (same(pl, P([c[0], c[1], 1]))) return `tb${i}`; }
    return `x${i}_${k}`;
  };
  const inJunction = (i, k) => tapsOn.includes(i) && (() => { const c = tapC(i), lo = P([c[0], c[1], -1]).v, hi = P([c[0], c[1], 1]).v; return planes[k].v >= lo - 1e-9 && planes[k + 1].v <= hi + 1e-9; })();
  const term = (c, name) => (c === 0 ? '' : `${c > 0 ? '+' : '-'}${Math.abs(c) === 1 ? '' : `${Math.abs(c)}*`}${name}`);
  const lenExpr = (a, b) => { const d = [0, 1, 2].map(k => b.c[k] - a.c[k]); const e = (term(d[0], 'th0') + term(d[1], 'tt') + term(d[2], 'hw')).replace(/^\+/, ''); return `(${e})*1deg`; };
  for (let k = 0; k < planes.length - 1; k++) {
    const A = [], B = [];
    for (let i = 1; i <= n; i++) { const j = inJunction(i, k); A.push(j ? '-' : nodeAt(i, k)); B.push(j ? '-' : nodeAt(i, k + 1)); }
    if (opts.linear) {
      // C and L linearised in the gap and width parameters around the last field solve (fast optimiser model)
      const { C0m, L0m, dC, dL, names, X0 } = opts.linear;
      const ex = (M0, dM, i, j) => `${M0[i][j]}${dM.map((D, g) => `${D[i][j] >= 0 ? '+' : ''}${D[i][j]}*(${names[g]}-${X0[g]})`).join('')}`;
      L.push(`cline S${k + 1}`);
      L.push(`  C [${C0m.map((row, i) => row.map((_, j) => ex(C0m, dC, i, j)).join(' ')).join('; ')}]`);
      L.push(`  L [${L0m.map((row, i) => row.map((_, j) => ex(L0m, dL, i, j)).join(' ')).join('; ')}]`);
    } else {
      L.push(`cline S${k + 1}`, '  geom msl');
      L.push(`  W [${Array.from({ length: n }, (_, m) => symW(m + 1)).join(' ')}]`);
      L.push(`  S [${Array.from({ length: n - 1 }, (_, m) => symS(m + 1)).join(' ')}]`);
    }
    L.push(`  len ${lenExpr(planes[k], planes[k + 1])}`);
    if (lossless) L.push('  Q 1e30');
    L.push(`  A ${A.join(' ')}`, `  B ${B.join(' ')}`, 'end');
  }
  // tap junctions (Hammerstad tee, js/tee.js): main arms on the resonator, side arm to the port
  for (const i of tapsOn) L.push(`tee TJ${i} ta${i} tb${i} t${i} Wa=${symW(i)} Wb=${symW(i)} W2=wf`);
  if (via) for (let i = 1; i <= n; i++) L.push(`via V${i} g${i} d=${fmt(via.d * 1e3, 4)}mm n=${via.n}${lossless ? '' : ''}`);
  const W = fullW(st.Wh, n), coe = st.coe;
  // loading capacitors: ideal, or a part with its pad, ESL and ground vias (js/capacitors.js, #14);
  // the cl parameters are the parts' nominal values
  const ct = st.cap?.type ?? 'ideal', cv = st.cap?.via;
  const capLine = (i, p) => (ct === 'ideal' ? `C${i} r${i} 0 ${p}` : `cap C${i} r${i} C=${p} type=${ct}${ct === 'smd' ? ` pkg=${st.cap.pkg}` : ''}${ct === 'printed' ? '' : ` d=${fmt(cv.d * 1e3, 4)}mm n=${cv.n}`}${lossless && ct !== 'printed' ? ' Q=1e30' : ''}`);
  for (let i = 1; i <= n; i++) {
    const node = `r${i}`;
    if (groundOthers && !portsOn.includes(i) && !(i === 1)) continue;
    if (structure === 'comb') L.push(capLine(i, symC(i)));
    else if (st.ext1 > 0 && (i === 1 || i === n)) L.push(`T${i}_ext r${i} - W=${symW(i)} len=ext1   # end-resonator extension beyond the array`);
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

// nominal capacitor value that gives the effective (ideal) capacitance Ceff at f, for the chosen part
function nominalCap(Ceff, cap, sub, f) {
  if (!cap || cap.type === 'ideal' || cap.type === 'printed') return Ceff;
  if (cap.type === 'smd') {
    const x = smdForCeff({ Ceff, pkg: cap.pkg, sub, via: cap.via, f });
    if (!(x.C > 0)) throw new Error(x.why ?? 'no SMD value gives the loading capacitance');
    return x.C;
  }
  // trimmer: its pad, ESL and the ground vias (as expandCap)
  const Cp = padC({ W: TRIMMER_FOOTPRINT.pads.w, L: TRIMMER_FOOTPRINT.pads.l, sub });
  const Ls = TRIMMER_DEFAULTS.esl + viaL({ d: cap.via.d, h: sub.dielectric.h, n: cap.via.n }).L, w = 2 * Math.PI * f, x = Ceff - Cp;
  if (!(x > 0)) throw new Error('the trimmer pad alone exceeds the loading capacitance');
  return x / (1 + w * w * Ls * x);
}

// open-stub extension of the end resonators (interdigital) with the input capacitance C at f:
// tan(βΔ)/(ωZ0) = C
function extFor(C, st, sub, f) {
  if (!(C > 0)) return 0;
  const l = msline({ W: st.Wh[0], h: sub.dielectric.h, er: sub.dielectric.er, t: sub.copper.t, f });
  const w = 2 * Math.PI * f, beta = w * Math.sqrt(l.epsEff) / C0;
  return Math.atan(w * l.Z0 * C) / beta;
}

// tap junction size: the feed width (port impedance on the substrate) and half of it in degrees
function setJunction(r, st, sub, via) {
  const { h, er } = sub.dielectric, t = sub.copper.t, n = r.spec.n;
  st.wf = synthMsline({ Z0: r.spec.R0, h, er, t }).W;
  const len = physContext(r, sub, via).section(fullW(st.Wh, n), fullS(st.Sh, n), st.thDeg, st.fTune).len;
  st.hwDeg = st.wf / 2 / len * st.thDeg;
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
function refine(r, sub, via, geom, fTune, kScale, warnings, log, capOpt) {
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
  const st = { Wh, Sh, thDeg, fTune, coe, Cl: Cl.slice(0, nh).map(c => nominalCap(c, capOpt, sub, fTune)), ext1: 0, cap: capOpt };
  setJunction(r, st, sub, via);
  // tap: Qe and resonator-1 frequency
  const Qe = r.Qe;
  const b = (() => { const sec = ctx.section(W(), S(), thDeg, fTune), shunt = structure === 'comb' ? Cl.map((c, j) => c + coe[j]) : coe; const df = fTune * 1e-4; return (w0 / 2) * (ctx.Bred(sec, fTune + df, [0], shunt)[0][0] - ctx.Bred(sec, fTune - df, [0], shunt)[0][0]) / (2 * Math.PI * 2 * df); })();
  let tt = Math.max(Math.asin(Math.min(0.95, Math.sin(thDeg * Math.PI / 180) * Math.sqrt(b * r.spec.R0 / Qe))) * 180 / Math.PI, 1.2 * st.hwDeg);
  let cl1 = structure === 'comb' ? Cl[0] : 0, m;
  for (let it = 0; it < 15; it++) {
    st.ttDeg = tt; if (structure === 'comb') st.Cl[0] = nominalCap(cl1, capOpt, sub, fTune); else st.ext1 = extFor(cl1, st, sub, fTune);
    m = measureQe(r, st, sub, via, Qe);
    const dq = m.Qe / Qe;
    tt = Math.max(Math.min(Math.asin(Math.min(0.999, Math.sin(tt * Math.PI / 180) * Math.sqrt(dq))) * 180 / Math.PI, thDeg - 1.2 * st.hwDeg), 1.2 * st.hwDeg);
    cl1 = Math.max(0, cl1 + (2 * Math.PI * m.fres - w0) * 2 * b / (w0 * w0));
    if (Math.abs(dq - 1) < 1e-4 && Math.abs(m.fres / fTune - 1) < 1e-6) break;
  }
  st.ttDeg = tt; if (structure === 'comb') st.Cl[0] = nominalCap(cl1, capOpt, sub, fTune); else st.ext1 = extFor(cl1, st, sub, fTune);
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
  if (r.spec.structure === 'interdigital') { if (best.ext1 != null) st.ext1 = best.ext1; }
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
  let prev = null, best = null;
  for (let round = 0; round < rounds; round++) {
    setJunction(r, st, sub, via);
    const text = linearModel(r, st, sub, via, { freq: `${lo} ${hi} 201`, gapRange: [0.85, 1.15], wRange: [0.85, 1.15] });
    // frequencies: dense across the ripple band (the return-loss goal), a few on each skirt (the
    // bandwidth bounds)
    const [l3, h3] = idealEdges(r, T, 0.5), m3 = 0.015 * (h3 - l3);
    const lin = (a, b, k) => Array.from({ length: k }, (_, i) => a + (b - a) * i / (k - 1));
    const eps = 1e-6 * (fb - fa);                                                   // (endpoints strictly inside the goal range)
    const ga = fa + 0.02 * (fb - fa) + eps, gb = fb - 0.02 * (fb - fa) - eps;       // the return-loss goal's range
    // skirts: denser towards the band, where the bound bites
    const sk = (a, b, k) => Array.from({ length: k }, (_, i) => b + (a - b) * (i / (k - 1)) ** 2);
    const F = Float64Array.from([...sk(lo, l3 - m3 - eps, 9), ...lin(ga, gb, 41), ...sk(hi, h3 + m3 + eps, 9)].sort((a, b) => a - b));
    const g = optimise(text, { maxiter: 400, freqs: F }); let it, last;
    while (!(it = g.next()).done) last = it.value;
    const out = it.value ?? last;
    const change = applyParams(r, st, out.best);
    // judge on the exact geometry (the linearised model is only good near its base point)
    const de = parseNetlist(buildNetlist(r, st, sub, via, { lossless: true, freq: `${lo} ${hi} 201` }));
    const Fx = Float64Array.from([...F, ...lin(ga, gb, 241)].sort((a, b) => a - b));
    const exact = goalCost(de, solveNet(de, Fx)).cost;
    log.push(`goal polish ${round + 1}: cost ${out.cost.toExponential(2)} (linearised), ${exact.toExponential(2)} (exact geometry), largest W/S change ${fmt(change * 100, 3)} %`);
    st.goalCost = exact;
    if (!best || exact < best.cost) best = { cost: exact, st: JSON.parse(JSON.stringify(st)) };
    // done when the exact model meets the goals to within about 0.3 dB, or stops improving
    if (exact < 0.1 || (prev != null && exact > prev * 0.9 && change < 0.01)) break;
    prev = exact;
  }
  if (best && best.cost < st.goalCost) { Object.assign(st, best.st); log.push(`goal polish: kept round with exact cost ${best.cost.toExponential(2)}`); }
}
// the netlist's goals on the exact geometry (lossless): [{ goal, worst violation }]
function goalReport(r, st, sub, via) {
  const T = r.spec.target ?? r.spec, [fa, fb] = rippleEdges(T.f0, T.fbw);
  const lo = r.skirt ? r.skirt.fl : fa - (fb - fa) / 2, hi = r.skirt ? r.skirt.fh : fb + (fb - fa) / 2;
  const d = parseNetlist(buildNetlist(r, st, sub, via, { lossless: true, freq: `${lo} ${hi} 401` }));
  return goalCost(d, solveNet(d)).report;
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
  const capOpt = { type: opts.cap?.type ?? 'ideal', pkg: opts.cap?.pkg ?? '0603', via: via ?? { d: 0.3e-3, n: 2 } };
  const st = refine(r, sub, via, geom, r.spec.f0, 1, warnings, log, capOpt);
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
  if (r.spec.type === 'chebyshev') {
    const miss = goalReport(r, st, sub, via).filter(g => g.maxViolation > 1);   // tolerance: 1 dB on the ideal return loss
    if (miss.length) warnings.push(`the geometry misses its goals by more than 1 dB (lossless): ${miss.map(g => `${g.goal.src} ${g.goal.op} ${g.goal.value} by up to ${fmt(g.maxViolation, 3)} dB`).join('; ')}; the non-adjacent couplings could not be fully compensated: try another θ0 or Zr, or run the optimiser`);
  }
  const report = [
    `substrate ${sub.id}: h ${fmt(sub.dielectric.h * 1e3, 4)} mm, εr ${sub.dielectric.er}, copper ${fmt(sub.copper.t * 1e6, 4)} µm; field-solved array`,
    `widths ${W.map(w => fmt(w * 1e3, 4)).join(' ')} mm; gaps ${S.map(s => fmt(s * 1e3, 4)).join(' ')} mm`,
    `line length ${fmt(len * 1e3, 5)} mm (${fmt(st.thDeg * T.f0 / st.fTune, 5)}° at f0, mean modal velocity); tap ${fmt(tapLen * 1e3, 5)} mm from the shorted end`,
    via ? `shorted ends: ${via.n} × ${fmt(via.d * 1e3, 3)} mm vias (${fmt(physContext(r, sub, via).Lv * 1e12, 4)} pH); open ends: KJK Δl as a capacitance` : 'shorted ends ideal (no vias)',
    `realised (lossless): centre ${fmt(a.fc / 1e9, 6)} GHz, −3 dB FBW ${fmt(a.bw3 * 100, 4)} % (ideal ${fmt(a.bw3ideal * 100, 4)} %), worst return loss over the central 80 % of the ripple band ${fmt(a.rlCore, 4)} dB${isFinite(a.rlTarget) ? ` (ideal ${fmt(a.rlTarget, 4)} dB)` : ''}`,
    `insertion loss at f0 ${fmt(il0, 3)} dB with the substrate's conductor and dielectric loss (modal Q ${Qs.map(q => fmt(q, 3)).join(', ')})${st.cap?.type === 'smd' ? `, and the capacitors' Q (${SMD_DEFAULT_Q}, the default for C0G parts)` : st.cap?.type === 'trimmer' ? `, and the trimmers' Q (${TRIMMER_DEFAULTS.Q})` : ''}`,
    'tap junctions: Hammerstad tee (as Qucs); the board layout (.layout) adds the feed lines and edge connectors',
  ];
  // the capacitor model's own notes (from the parser): self-resonance summarised, the rest as given
  const capW = dl.warnings.map(w => w.replace(/^line \d+: /, '')).filter(w => /^C\d+: /.test(w));
  const srf = capW.map(w => w.match(/self-resonance with ESL \+ via ([\d.]+) GHz/)).filter(Boolean).map(m => +m[1]);
  if (srf.length) report.push(`capacitor self-resonance (ESL + vias) ${[...new Set([Math.min(...srf), Math.max(...srf)].map(x => fmt(x, 3)))].join('–')} GHz, under 3 f0: modelled, but above it the capacitors are inductive, so the upper stopband differs from an ideal-capacitor design`);
  [...new Set(capW.filter(w => !/self-resonance/.test(w)))].forEach(w => report.push(`capacitor ${w}`));
  if (r.spec.structure === 'interdigital' && r._spread > 0) report.splice(3, 0, `inner resonators spread by ${fmt(r._spread * 100, 3)} % of f0 with a common length (inhomogeneous medium)`);
  st.report = report; st.warnings = warnings;
  const netlist = buildNetlist(r, st, sub, via);
  return { netlist, geometry: { W, S, len, tapLen, thDeg: st.thDeg * T.f0 / st.fTune, Cl: r.spec.structure === 'comb' ? fullW(st.Cl, n) : null, ext1: st.ext1 }, report, warnings, assess: a, log, substrate: sub.id };
}

