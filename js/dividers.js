// Power dividers/combiners and hybrids (issue #39): ideal TEM designs (this file) and the microstrip
// realisations of the compact Wilkinson and the branch-line coupler (js/dividers-ms.js).
//
// Ideal designs, as netlists of uniform lines (`T … Z0= len=90deg` at .ref f0):
//   wilkinson({ f0, R0, sections, fbw, splitDb })
//       equal split, 1–3 sections: each arm a Chebyshev quarter-wave transformer from 2R0 (junction) to
//       R0 (port) for the bandwidth fbw (small-reflection theory), one resistor per section; the
//       resistors are 2R0 for one section and polished on the isolation goals for more.
//       unequal split (one section; splitDb = 10 log(P3/P2)): Pozar §7.3 — K² = P3/P2,
//       Z03 = R0 √((1 + K²)/K³), Z02 = K² Z03, R = R0 (K + 1/K), outputs at R0 K and R0/K brought to R0
//       by quarter-wave transformers.
//   wilkinsonTree({ f0, R0, ways })   2^m-way corporate tree of equal two-way stages
//   branchline({ f0, R0 })            series arms R0/√2, shunt arms R0, all 90°
//   ratrace({ f0, R0 })               1.5 λ ring of R0√2, arms 90/90/90/270°: port 1 is Δ (2 and 4 out of
//                                     phase), port 3 is Σ (2 and 4 in phase), 1 and 3 isolated
//   gysel({ f0, R0, R, Z3 })          equal Gysel: arms Z1 = √2R0 to the outputs, Z2 = √(R R0) from each
//                                     output to a node with R to ground (default R0), the two nodes
//                                     joined by a half-wave Z3 (bandwidth only; default R0/√2); from the
//                                     even/odd analysis in the function
import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { optimise, goalCost } from './optimize.js';

const fmt = (x, d = 7) => +x.toPrecision(d);

/** Chebyshev multi-section quarter-wave transformer from Z0 to ZL for fractional bandwidth fbw. */
export function chebyshevTransformer(Z0, ZL, N, fbw) {
  if (N === 1) return [Math.sqrt(Z0 * ZL)];
  const thm = Math.PI / 2 * (1 - fbw / 2), sec = 1 / Math.cos(thm);
  const TN = (x) => (Math.abs(x) <= 1 ? Math.cos(N * Math.acos(x)) : Math.cosh(N * Math.acosh(Math.abs(x))) * (x < 0 && N % 2 ? -1 : 1));
  const A = 0.5 * Math.log(ZL / Z0) / TN(sec);
  // cosine series of A T_N(sec θm cos θ) = Σ a_j cos jθ (j = N, N−2, …); Γ(θ) = 2 Σ Γ_k cos (N−2k)θ
  const M = 4096, a = (j) => { let s = 0; for (let i = 0; i < M; i++) { const th = (i + 0.5) * Math.PI / M; s += A * TN(sec * Math.cos(th)) * Math.cos(j * th); } return s * (j === 0 ? 1 : 2) / M; };
  const G = [];
  for (let k = 0; k <= Math.floor(N / 2); k++) { const j = N - 2 * k; G.push(j === 0 ? a(0) : a(j) / 2); }
  const full = Array.from({ length: N + 1 }, (_, k) => G[Math.min(k, N - k)]);
  const Z = [Z0];
  for (let k = 0; k < N; k++) Z.push(Z[k] * Math.exp(2 * full[k]));
  return Z.slice(1, N + 1);                                  // the N section impedances
}

const header = (title, f0, span = 0.5, n = 401) => [`.title ${title}`, `.freq ${fmt(f0 * (1 - span))} ${fmt(f0 * (1 + span))} ${n}`, `.ref ${fmt(f0, 9)}`];

export function wilkinson({ f0, R0 = 50, sections = 1, fbw = 0.4, splitDb = 0 } = {}) {
  if (!(f0 > 0)) throw new Error('wilkinson: f0 is required');
  if (!(sections >= 1 && sections <= 3)) throw new Error('wilkinson: 1 to 3 sections');
  if (splitDb !== 0) return wilkinsonUnequal({ f0, R0, splitDb });
  const Z = chebyshevTransformer(2 * R0, R0, sections, fbw);    // junction (2R0 per arm) → port (R0)
  const st = { Z, R: Array.from({ length: sections }, (_, k) => 2 * R0 * (sections === 1 ? 1 : 1 + 0.5 * (sections - 1 - k))) };
  const text = (o = {}) => {
    const L = header(`Wilkinson divider, ${sections} section${sections > 1 ? 's' : ''}, f0 = ${fmt(f0 / 1e9, 5)} GHz`, f0, Math.min(0.9, sections * 0.4), 401);
    st.R.forEach((r, k) => L.push(`.param r${k + 1} = ${fmt(r)}${o.tune ? ` tune ${fmt(r * 0.3)} ${fmt(r * 3)}` : ''}`));
    L.push(`port in ${R0}`, `port o1 ${R0}`, `port o2 ${R0}`);
    for (let k = 0; k < sections; k++) {
      const a = k ? `a${k}` : 'in', b = k ? `b${k}` : 'in', a2 = k === sections - 1 ? 'o1' : `a${k + 1}`, b2 = k === sections - 1 ? 'o2' : `b${k + 1}`;
      L.push(`T${k + 1}a ${a} ${a2} Z0=${fmt(Z[k])} len=90deg`, `T${k + 1}b ${b} ${b2} Z0=${fmt(Z[k])} len=90deg`, `R${k + 1} ${a2} ${b2} r${k + 1}`);
    }
    if (o.goals) {
      const lo = f0 * (1 - fbw / 2), hi = f0 * (1 + fbw / 2);
      L.push(`.goal db(S32) < -30 ${fmt(lo)} ${fmt(hi)}`, `.goal db(S22) < -30 ${fmt(lo)} ${fmt(hi)}`);
    }
    L.push('.plot ylim=-50,0 db(S11) db(S21) db(S31) db(S22) db(S32)');
    return L.join('\n') + '\n';
  };
  if (sections > 1) {
    // the resistors by the optimiser, from several starts (the cost has local minima), keeping the best
    const lo = f0 * (1 - fbw / 2), hi = f0 * (1 + fbw / 2), F = Float64Array.from({ length: 41 }, (_, i) => lo + (hi - lo) * i / 40);
    const cost = () => { const d = parseNetlist(text({ goals: true })); return goalCost(d, solve(d, F)).cost; };
    const starts = [[1, 1, 1], [2, 1, 0.5], [0.5, 1, 2], [4, 2, 1], [1, 2, 4]].map(m => m.slice(0, sections).map(x => 2 * R0 * x));
    let best = null;
    for (const s0 of starts) {
      st.R = [...s0];
      for (let round = 0; round < 3; round++) {
        const g = optimise(text({ tune: true, goals: true }), { maxiter: 600, freqs: F }); let it, last;
        while (!(it = g.next()).done) last = it.value;
        st.R = st.R.map((_, k) => (it.value ?? last).best[`r${k + 1}`]);
      }
      const c = cost();
      if (!best || c < best.c) best = { c, R: [...st.R] };
    }
    st.R = best.R;
  }
  return { netlist: text(), Z, R: st.R, kind: 'wilkinson' };
}

function wilkinsonUnequal({ f0, R0, splitDb }) {
  const K2 = 10 ** (splitDb / 10), K = Math.sqrt(K2);                // P3/P2 = K²
  const Z03 = R0 * Math.sqrt((1 + K2) / K ** 3), Z02 = K2 * Z03, R = R0 * (K + 1 / K);
  const R2 = R0 * K, R3 = R0 / K, Zt2 = Math.sqrt(R0 * R2), Zt3 = Math.sqrt(R0 * R3);
  const L = header(`Unequal Wilkinson, P3/P2 = ${splitDb} dB, f0 = ${fmt(f0 / 1e9, 5)} GHz`, f0, 0.5, 401);
  L.push(`port in ${R0}`, `port o2 ${R0}`, `port o3 ${R0}`,
    `T2 in x2 Z0=${fmt(Z02)} len=90deg`, `T3 in x3 Z0=${fmt(Z03)} len=90deg`, `R1 x2 x3 ${fmt(R)}`,
    `T2t x2 o2 Z0=${fmt(Zt2)} len=90deg   # R0 K → R0`, `T3t x3 o3 Z0=${fmt(Zt3)} len=90deg   # R0/K → R0`,
    '.plot ylim=-50,0 db(S11) db(S21) db(S31) db(S32)');
  return { netlist: L.join('\n') + '\n', Z: { Z02, Z03, Zt2, Zt3 }, R: [R], kind: 'wilkinson-unequal' };
}

export function wilkinsonTree({ f0, R0 = 50, ways = 4 } = {}) {
  const m = Math.log2(ways);
  if (!(Number.isInteger(m) && m >= 1 && m <= 4)) throw new Error('wilkinsonTree: ways = 2, 4, 8 or 16');
  const L = header(`${ways}-way Wilkinson tree, f0 = ${fmt(f0 / 1e9, 5)} GHz`, f0, 0.5, 401);
  L.push(`port in ${R0}`);
  for (let i = 1; i <= ways; i++) L.push(`port o${i} ${R0}`);
  const Z = fmt(Math.SQRT2 * R0);
  let level = ['in'], k = 0;
  for (let s = 0; s < m; s++) {
    const next = [];
    for (const n of level) {
      k++;
      const a = s === m - 1 ? `o${next.length + 1}` : `n${k}a`, b = s === m - 1 ? `o${next.length + 2}` : `n${k}b`;
      L.push(`T${k}a ${n} ${a} Z0=${Z} len=90deg`, `T${k}b ${n} ${b} Z0=${Z} len=90deg`, `R${k} ${a} ${b} ${2 * R0}`);
      next.push(a, b);
    }
    level = next;
  }
  L.push('.plot ylim=-50,0 db(S11) db(S21) db(S32)');
  return { netlist: L.join('\n') + '\n', kind: 'wilkinson-tree' };
}

export function branchline({ f0, R0 = 50 } = {}) {
  const L = header(`Branch-line hybrid, f0 = ${fmt(f0 / 1e9, 5)} GHz`, f0, 0.4, 401);
  L.push(`port p1 ${R0}   # input`, `port p2 ${R0}   # through (−90°)`, `port p3 ${R0}   # coupled (−180°)`, `port p4 ${R0}   # isolated`,
    `Ts1 p1 p2 Z0=${fmt(R0 / Math.SQRT2)} len=90deg`, `Ts2 p4 p3 Z0=${fmt(R0 / Math.SQRT2)} len=90deg`,
    `Tp1 p1 p4 Z0=${R0} len=90deg`, `Tp2 p2 p3 Z0=${R0} len=90deg`,
    '.plot ylim=-40,0 db(S11) db(S21) db(S31) db(S41)', '.plot ang(S31/S21)');
  return { netlist: L.join('\n') + '\n', kind: 'branchline' };
}

export function ratrace({ f0, R0 = 50 } = {}) {
  const Z = fmt(Math.SQRT2 * R0);
  const L = header(`Rat-race (180°) hybrid, f0 = ${fmt(f0 / 1e9, 5)} GHz`, f0, 0.4, 401);
  L.push(`port p1 ${R0}   # Δ input: out of phase to p2 and p4 (90° and 270°), p3 isolated`, `port p2 ${R0}`, `port p3 ${R0}   # Σ input: in phase to p2 and p4 (90° each), p1 isolated`, `port p4 ${R0}`,
    `T12 p1 p2 Z0=${Z} len=90deg`, `T23 p2 p3 Z0=${Z} len=90deg`, `T34 p3 p4 Z0=${Z} len=90deg`, `T41 p4 p1 Z0=${Z} len=270deg`,
    '.plot ylim=-40,0 db(S11) db(S21) db(S31) db(S41)', '.plot ang(S21/S41) ang(S23/S43)');
  return { netlist: L.join('\n') + '\n', kind: 'ratrace' };
}

export function gysel({ f0, R0 = 50, R, Z3 } = {}) {
  // even mode (outputs driven alike): the half-wave Z3's midpoint is open, so each half is a λ/4 open stub,
  // a short at the resistor node; Z2 then opens the output and the input match needs Z1 = √(2R0·R0).
  // Odd mode: the input is a virtual ground (Z1 opens the output) and Z3's halves are λ/4 shorted stubs,
  // open at the node; the output sees R through Z2: Z2²/R = R0. Z3 sets the bandwidth only.
  // In the even mode Z3 is a half-wave shorted at both ends: a mode trapped at exactly f0 that leaves
  // the resistors unexcited. With ideal lossless lines it shows as a spike of zero width at f0
  // (|S22| = |S32| = 0.5 within about 1e-7 of f0); any line loss removes it (Q = 1000: S22 6e-5).
  R ??= R0; Z3 ??= R0 / Math.SQRT2;
  const v = { z1: Math.SQRT2 * R0, z2: Math.sqrt(R * R0), z3: Z3, r: R };
  const L = header(`Gysel divider, f0 = ${fmt(f0 / 1e9, 5)} GHz`, f0, 0.5, 401);
  L.push(`port in ${R0}`, `port o1 ${R0}`, `port o2 ${R0}`,
    `T1a in o1 Z0=${fmt(v.z1)} len=90deg`, `T1b in o2 Z0=${fmt(v.z1)} len=90deg`, `T2a o1 na Z0=${fmt(v.z2)} len=90deg`, `T2b o2 nb Z0=${fmt(v.z2)} len=90deg`,
    `T3 na nb Z0=${fmt(v.z3)} len=180deg`, `Ra na 0 ${fmt(v.r)}`, `Rb nb 0 ${fmt(v.r)}`,
    '.plot ylim=-50,0 db(S11) db(S21) db(S22) db(S32)');
  return { netlist: L.join('\n') + '\n', values: v, kind: 'gysel' };
}
