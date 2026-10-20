// Hairpin bandpass filters in microstrip (issue #38): the edge-coupled filter folded. Each half-wave
// resonator is a U of two parallel arms joined at one end; consecutive U's are flipped, so the facing
// arms of neighbours are open at opposite ends, exactly as the coupled sections of the edge-coupled
// filter they come from. Input and output are tapped (tee, js/tee.js) on the outer arms.
//
// Model: all 2n arms as one field-solved N-line array (js/fieldlines.js), so the coupling between a
// hairpin's own two arms and the non-adjacent couplings are included; the U bottoms as two optimally
// mitred bends and a line (js/discontinuities.js); KJK open-end fringing as capacitances.
//
// Design:
//   1. arm width W_k from the resonator impedance Zr; inner gap of each U from `selfGap` (× W);
//   2. gaps between neighbours: the coupled pair at width W with the coupling coefficient
//      (Z0e − Z0o)/(Z0e + Z0o) of the edge-coupled section it replaces (Matthaei's inverters);
//   3. tap from the tapped half-wave resonator, Qe = (π/2)(R0/Zr)/sin²θ, θ from the U's midpoint;
//   4. the goal polish (return loss across the ripple band, −3 dB band bounded from above) on a model
//      whose C and L are linearised in the widths and gaps around the last field solve, moving the
//      widths, both kinds of gap (each resonator is trimmed by its own inner gap, which lengthens its
//      bottom), the common arm length and the tap; the geometry is solved again each round.
import { returnLossDb, rippleEdges, idealS21 } from './synth.js';
import { ecPrototype } from './synth-ec.js';
import { parseNetlist } from './netlist.js';
import { optimise, goalCost } from './optimize.js';
import { solve as solveNet } from './solver.js';
import { makeSubstrate } from './substrates.js';
import { fieldLines } from './fieldlines.js';
import { solve as fieldSolve, microstrip } from '../solver/mtl2d.js';
import { openEnd } from './discontinuities.js';
import { msline, mscoupled, synthMsline } from './microstrip.js';

const C0 = 299792458;
const fmt = (x, d = 6) => +x.toPrecision(d);

// strip widths and gaps of the array (mm) from the symmetric halves
function arrays(st, n) {
  const sym = (a, i, len) => a[Math.min(i, len - 1 - i)];
  const W = [], S = [];
  for (let k = 0; k < n; k++) { const w = sym(st.W, k, n); W.push(w, w); S.push(sym(st.G, k, n)); if (k < n - 1) S.push(sym(st.S, k, n - 1)); }
  return { W, S };
}
const symName = (pre, i, len) => `${pre}${Math.min(i, len - 1 - i) + 1}`;

/** Netlist for state st; opts { lossless, linear, freq, goals, layout }. */
export function hairpinNetlist(spec, sub, st, opts = {}) {
  const { n, f0, R0 = 50 } = spec, { lossless = false, goals = true } = opts;
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t;
  const { W, S } = arrays(st, n), N = 2 * n;
  const L = [];
  L.push(`.title Hairpin ${spec.type} n=${n}${spec.type === 'chebyshev' ? ` ${spec.ripple}dB` : ''}, f0 = ${fmt(f0 / 1e9, 6)} GHz, FBW = ${fmt(spec.fbw * 100, 4)} % on ${sub.id} (synthesised geometry)`);
  for (const line of st.report ?? []) L.push(`# ${line}`);
  const fa = Math.max(0.05 * f0, f0 * (1 - 3 * spec.fbw)), fb = f0 * (1 + 3 * spec.fbw);
  L.push(`.freq ${opts.freq ?? `${fmt(fa)} ${fmt(fb)} 801`}`, `.ref ${fmt(f0, 9)}`, `.substrate ${sub.id}`);
  if (opts.layout) L.push('.layout hairpin');
  const minS = Math.max(0.1, (sub.fab?.minSpace ?? 0.1e-3) * 1e3), minW = Math.max(0.1, (sub.fab?.minTrace ?? 0.1e-3) * 1e3);
  const tune = (v, lo, hi, u = '') => (opts.tune === false ? '' : ` tune ${fmt(lo, 6)}${u} ${fmt(hi, 6)}${u}`);
  L.push(`.param la = ${fmt(st.la, 9)}${tune(st.la, st.la * 0.9, st.la * 1.1)}   # arm length, degrees at f0 (mean modal velocity of the array)`);
  L.push(`.param tt = ${fmt(st.tt, 8)}${tune(st.tt, Math.max(st.tt * 0.6, st.hw * 1.2), Math.min(st.tt * 1.4, st.la / 2 - 1.2 * st.hw))}   # tap from the bend end of the outer arms, degrees`);
  L.push(`.param wf = ${fmt(st.wf, 7)}mm   # tap feed width (${R0} ohm)`, `.param hw = ${fmt(st.hw, 9)}   # half the feed width in degrees at f0`);
  st.W.forEach((v, i) => L.push(`.param w${i + 1} = ${fmt(v, 7)}mm${tune(v, Math.max(minW, v * 0.85), v * 1.15, 'mm')}`));
  st.S.forEach((v, i) => L.push(`.param s${i + 1}${i + 2} = ${fmt(v, 7)}mm${tune(v, Math.max(minS, v * 0.6), v * 1.6, 'mm')}`));
  st.G.forEach((v, i) => L.push(`.param g${i + 1} = ${fmt(v, 7)}mm${tune(v, Math.max(minS, v * 0.5), v * 1.5, 'mm')}   # inner gap of hairpin ${i + 1}`));
  L.push(`port t1 ${R0}`, `port t${n} ${R0}`);
  const Wn = (k) => symName('w', k, n);                       // width param of resonator k (0-based)
  const gapNames = []; for (let k = 0; k < n; k++) { gapNames.push(symName('g', k, n)); if (k < n - 1) gapNames.push(`s${Math.min(k, n - 2 - k) + 1}${Math.min(k, n - 2 - k) + 2}`); }
  // planes along the arms: coefficients over (la, tt, hw); output tap measured from its own bend end
  const bendLow = (k) => k % 2 === 0;                      // resonator k (0-based): bend at y = 0 for 1st, 3rd, …
  const outLow = bendLow(n - 1);
  const planes = [[0, 0, 0], [0, 1, -1], [0, 1, 1]];
  if (!outLow) planes.push([1, -1, -1], [1, -1, 1]);
  planes.push([1, 0, 0]);
  const val = (c) => c[0] * st.la + c[1] * st.tt + c[2] * st.hw;
  for (let p = 1; p < planes.length; p++) if (val(planes[p]) <= val(planes[p - 1]) + 1e-9) throw new Error('hairpin: the taps are too far from the bends for this arm length (tap planes overlap)');
  const term = (c, name) => (c === 0 ? '' : `${c > 0 ? '+' : '-'}${Math.abs(c) === 1 ? '' : `${Math.abs(c)}*`}${name}`);
  const lenExpr = (a, b) => { const d = [0, 1, 2].map(k => b[k] - a[k]); return `(${(term(d[0], 'la') + term(d[1], 'tt') + term(d[2], 'hw')).replace(/^\+/, '')})*1deg`; };
  const inTap = planes.length === 4 ? { 0: [1, 2], [N - 1]: [1, 2] } : { 0: [1, 2], [N - 1]: [3, 4] };
  const nodeAt = (i, p) => {
    const k = i >> 1, arm = i % 2 ? 'b' : 'a';
    if (p === 0) return bendLow(k) ? `u${k + 1}${arm}` : `o${i + 1}`;
    if (p === planes.length - 1) return bendLow(k) ? `o${i + 1}` : `u${k + 1}${arm}`;
    if (inTap[i]) { if (p === inTap[i][0]) return i === 0 ? 'ta1' : `ta${n}`; if (p === inTap[i][1]) return i === 0 ? 'tb1' : `tb${n}`; }
    return `x${i + 1}_${p}`;
  };
  for (let p = 0; p < planes.length - 1; p++) {
    const A = [], B = [];
    for (let i = 0; i < N; i++) { const j = inTap[i] && p === inTap[i][0]; A.push(j ? '-' : nodeAt(i, p)); B.push(j ? '-' : nodeAt(i, p + 1)); }
    if (opts.linear) {
      const { C0m, L0m, dC, dL, names, X0 } = opts.linear;
      const ex = (M0, dM, i, j) => `${M0[i][j]}${dM.map((D, g) => `${D[i][j] >= 0 ? '+' : ''}${D[i][j]}*(${names[g]}-${X0[g]})`).join('')}`;
      L.push(`cline S${p + 1}`, `  C [${C0m.map((row, i) => row.map((_, j) => ex(C0m, dC, i, j)).join(' ')).join('; ')}]`, `  L [${L0m.map((row, i) => row.map((_, j) => ex(L0m, dL, i, j)).join(' ')).join('; ')}]`);
    } else {
      L.push(`cline S${p + 1}`, '  geom msl', `  W [${Array.from({ length: N }, (_, i) => Wn(i >> 1)).join(' ')}]`, `  S [${gapNames.join(' ')}]`);
    }
    L.push(`  len ${lenExpr(planes[p], planes[p + 1])}`);
    if (lossless) L.push('  Q 1e30');
    L.push(`  A ${A.join(' ')}`, `  B ${B.join(' ')}`, 'end');
  }
  L.push(`tee TJ1 ta1 tb1 t1 Wa=${Wn(0)} Wb=${Wn(0)} W2=wf`, `tee TJ${n} ta${n} tb${n} t${n} Wa=${Wn(n - 1)} Wb=${Wn(n - 1)} W2=wf`);
  // U bottoms: bend, the inner-gap line, bend (reference planes at the edges of the crossing strips)
  for (let k = 0; k < n; k++) {
    const w = Wn(k), g = symName('g', k, n);
    L.push(`bend U${k + 1}a u${k + 1}a v${k + 1}a W=${w} mitre=opt`, `T${k + 1}_u v${k + 1}a v${k + 1}b W=${w} len=${g}`, `bend U${k + 1}b v${k + 1}b u${k + 1}b W=${w} mitre=opt`);
  }
  // open ends
  for (let i = 0; i < N; i++) {
    const w = W[i] / 1e3, l = msline({ W: w, h, er, t }), dl = openEnd({ W: w, h, er, t }).dl;
    L.push(`Coe${i + 1} o${i + 1} 0 ${fmt(dl * Math.sqrt(l.epsEff) / (C0 * l.Z0) * 1e12, 6)}p   # open-end fringing (Δl ${fmt(dl * 1e3, 4)} mm)`);
  }
  if (goals) {
    const [ra, rb] = rippleEdges(f0, spec.fbw), [l3, h3] = idealEdges(spec, 0.5), m3 = 0.015 * (h3 - l3);
    if (spec.type === 'chebyshev') L.push(`.goal db(S11) < ${fmt(-returnLossDb(spec.ripple), 4)} ${fmt(ra + 0.02 * (rb - ra), 8)} ${fmt(rb - 0.02 * (rb - ra), 8)}`);
    L.push(`.goal db(S21) < -3 ${fmt(fa, 8)} ${fmt(l3 - m3, 8)}   # −3 dB band at most 3 % wider than ideal`, `.goal db(S21) < -3 ${fmt(h3 + m3, 8)} ${fmt(fb, 8)}`);
    const ideal = spec.type === 'chebyshev' ? `cheby(${n},${spec.ripple},${fmt(f0, 9)},${fmt(spec.fbw, 9)})` : `butter(${n},${fmt(f0, 9)},${fmt(spec.fbw, 9)})`;
    L.push(`.plot ylim=-70,0 db(S11) db(S21) db(${ideal})`, '.plot gd(S21)');
  }
  return L.join('\n') + '\n';
}

function idealEdges(s, p) {
  const id = (f) => idealS21(s.type, s.n, s.ripple, s.f0, s.fbw, f) ** 2;
  const find = (a, b, rising) => { for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if ((id(m) < p) === rising) a = m; else b = m; } return (a + b) / 2; };
  return [find(s.f0 * 0.5, s.f0, true), find(s.f0, s.f0 * 1.5, false)];
}

// physical arm length (mm) of θ degrees at f0, for the array's mean modal velocity
function armMm(st, n, sub, f0, deg) {
  const { W, S } = arrays(st, n), fl = fieldLines({ W: W.map(x => x / 1e3), S: S.map(x => x / 1e3), sub, f0 });
  const nbar = fl.epsEff.reduce((a, e) => a + Math.sqrt(e), 0) / fl.epsEff.length;
  return deg / 360 * C0 / nbar / f0 * 1e3;
}

// linearised model: C, L of the array and their derivatives in each width/gap parameter
function linearNetlist(spec, sub, st, opts) {
  const n = spec.n, { W, S } = arrays(st, n), m = (a) => a.map(x => x / 1e3);
  const base = fieldLines({ W: m(W), S: m(S), sub, f0: spec.f0 });
  const thin = (st2) => { const a = arrays(st2, n); return fieldSolve(stripsOf(m(a.W), m(a.S)), microstrip({ h: sub.dielectric.h, er: sub.dielectric.er })); };
  const b0 = thin(st), dC = [], dL = [], names = [], X0 = [];
  for (const [key, pre, two] of [['W', 'w', false], ['S', 's', true], ['G', 'g', false]]) {
    st[key].forEach((v, i) => {
      const st2 = { ...st, [key]: st[key].map((x, j) => (j === i ? x * 1.02 : x)) }, dx = v * 0.02 / 1e3, fl = thin(st2);
      dC.push(fl.C.map((row, a) => row.map((x, b) => (x - b0.C[a][b]) / dx)));
      dL.push(fl.L.map((row, a) => row.map((x, b) => (x - b0.L[a][b]) / dx)));
      names.push(two ? `s${i + 1}${i + 2}` : `${pre}${i + 1}`); X0.push(v / 1e3);
    });
  }
  return hairpinNetlist(spec, sub, st, { ...opts, linear: { C0m: base.C, L0m: base.L, dC, dL, names, X0 }, lossless: true });
}
// strip list for the zero-thickness solver (as js/synth-geom.js: centres from x = 0, left to right)
function stripsOf(W, S) {
  const out = []; let x = 0;
  W.forEach((w, i) => { out.push({ x: x + w / 2, w }); x += w + (S[i] ?? 0); });
  return out;
}

/**
 * Hairpin filter on a substrate. spec: { type, n, ripple, f0, fbw, R0, Zr }; opts: { substrate, selfGap }.
 * Returns { netlist, report, warnings, assess, log, geometry }.
 */
export function realiseHairpin(spec0, opts = {}) {
  const spec = { type: 'chebyshev', ripple: 0.1, R0: 50, ...spec0 };
  if (spec.type === 'butterworth') spec.ripple = 0;
  spec.Zr ??= spec.R0;
  const sub = makeSubstrate(opts.substrate ?? 'jlc-ro4350b-0.762'), warnings = [], log = [];
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t, n = spec.n, f0 = spec.f0;
  if (!(n >= 2 && n <= 10)) throw new Error('hairpin order n must be 2..10');
  const nh = Math.ceil(n / 2), mh = Math.ceil((n - 1) / 2);
  const W0 = synthMsline({ Z0: spec.Zr, h, t, er, f: f0 }).W * 1e3;
  const minS = Math.max(0.1, (sub.fab?.minSpace ?? 0.1e-3) * 1e3);
  const P = ecPrototype(spec);
  // gaps for the edge-coupled sections' coupling coefficients at width W0
  const cOf = (S) => { const c = mscoupled({ W: W0 / 1e3, S: S / 1e3, h, t, er, f: f0 }); return (c.Ze - c.Zo) / (c.Ze + c.Zo); };
  const gapFor = (c) => { let lo = 0.02 * h * 1e3, hi = 20 * h * 1e3; for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi); if (cOf(m) > c) lo = m; else hi = m; } return Math.sqrt(lo * hi); };
  const st = { W: Array(nh).fill(W0), S: [], G: Array(nh).fill(Math.max(minS, (opts.selfGap ?? 2) * W0)) };
  for (let k = 1; k <= mh; k++) {
    const c = (P.Ze[k] - P.Zo[k]) / (P.Ze[k] + P.Zo[k]); let s = gapFor(c);
    if (s < minS) { warnings.push(`gap ${k}–${k + 1}: ${fmt(s, 3)} mm is below the minimum space ${minS} mm; clamped`); s = minS; }
    st.S.push(s);
  }
  // arm length and tap from the single-line estimate; the polish takes it from there
  const ln = msline({ W: W0 / 1e3, h, er, t, f: f0 }), lam = C0 / Math.sqrt(ln.epsEff) / f0 * 1e3;
  const thHalfBottom = (st.G[0] / 2 + W0 / 2) / lam * 360;
  st.la = 90 - thHalfBottom;
  st.wf = synthMsline({ Z0: spec.R0, h, t, er, f: f0 }).W * 1e3;
  const setHw = () => { st.hw = st.wf / 2 / armMm(st, n, sub, f0, st.la) * st.la; };
  setHw();
  const Qe = P.g[0] * P.g[1] / spec.fbw, s2 = Math.PI / 2 * (spec.R0 / spec.Zr) / Qe;
  if (!(s2 < 1)) throw new Error(`external Q ${fmt(Qe, 3)} is too low for a tap on a ${spec.Zr} Ω resonator: reduce the bandwidth or raise Zr`);
  st.tt = Math.max(Math.asin(Math.sqrt(s2)) * 180 / Math.PI - thHalfBottom, 1.3 * st.hw);
  // polish
  const [ra, rb] = rippleEdges(f0, spec.fbw), [l3, h3] = idealEdges(spec, 0.5), m3 = 0.015 * (h3 - l3);
  const lo = Math.max(0.05 * f0, f0 * (1 - 3 * spec.fbw)), hi = f0 * (1 + 3 * spec.fbw), eps = 1e-6 * (rb - ra);
  const lin = (a, b, k) => Array.from({ length: k }, (_, i) => a + (b - a) * i / (k - 1));
  const F = Float64Array.from([...lin(lo, l3 - m3 - eps, 9), ...lin(ra + 0.02 * (rb - ra) + eps, rb - 0.02 * (rb - ra) - eps, 41), ...lin(h3 + m3 + eps, hi, 9)]);
  const exactCost = () => { const d = parseNetlist(hairpinNetlist(spec, sub, st, { lossless: true })); return goalCost(d, solveNet(d, F)).cost; };
  let best = { cost: exactCost(), st: JSON.parse(JSON.stringify(st)) };
  log.push(`start: goal cost ${best.cost.toExponential(2)}`);
  for (let round = 0; round < 10 && best.cost > 0.1; round++) {
    const text = linearNetlist(spec, sub, st, {});
    const g = optimise(text, { maxiter: 500, freqs: F }); let it, last;
    while (!(it = g.next()).done) last = it.value;
    const out = it.value ?? last, b = out.best;
    let change = 0;
    for (const [key, name] of [['W', (i) => `w${i + 1}`], ['S', (i) => `s${i + 1}${i + 2}`], ['G', (i) => `g${i + 1}`]]) st[key] = st[key].map((v, i) => { const x = b[name(i)] * 1e3; change = Math.max(change, Math.abs(x / v - 1)); return x; });
    st.la = b.la; st.tt = b.tt; setHw();
    const c = exactCost();
    log.push(`polish ${round + 1}: ${out.cost.toExponential(2)} (linearised), ${c.toExponential(2)} (exact), largest W/gap change ${fmt(change * 100, 3)} %`);
    const prev = best.cost;
    if (c < best.cost) best = { cost: c, st: JSON.parse(JSON.stringify(st)) };
    if (c > prev * 0.9 && change < 0.01) break;
  }
  Object.assign(st, best.st);
  // report
  const d = parseNetlist(hairpinNetlist(spec, sub, st, { lossless: true }));
  const miss = goalCost(d, solveNet(d)).report.filter(g => g.maxViolation > 1);
  if (miss.length) warnings.push(`misses its goals by more than 1 dB (lossless): ${miss.map(g => `${g.goal.src} ${g.goal.op} ${g.goal.value} by up to ${fmt(g.maxViolation, 3)} dB`).join('; ')}`);
  const a = assessNet(hairpinNetlist(spec, sub, st, { lossless: true, goals: false }), spec);
  const il = (() => { const dd = parseNetlist(hairpinNetlist(spec, sub, st, { goals: false, freq: `${f0} ${f0} 1` })), s = solveNet(dd).S(2, 1); return -20 * Math.log10(Math.hypot(s.re[0], s.im[0])); })();
  const sp = (() => { const dd = parseNetlist(hairpinNetlist(spec, sub, st, { lossless: true, goals: false, freq: `${1.6 * f0} ${2.4 * f0} 801` })), r = solveNet(dd), s = r.S(2, 1); let bst = { peak: -Infinity, f: NaN }; for (let k = 0; k < r.freq.length; k++) { const v = 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); if (v > bst.peak) bst = { peak: v, f: r.freq[k] }; } return bst; })();
  const armLen = armMm(st, n, sub, f0, st.la), tapMm = armMm(st, n, sub, f0, st.tt);
  const { W, S } = arrays(st, n);
  st.report = [
    `substrate ${sub.id}: h ${fmt(h * 1e3, 4)} mm, εr ${er}, copper ${fmt(t * 1e6, 4)} µm; all ${2 * n} arms one field-solved array`,
    `arm widths ${W.filter((_, i) => i % 2 === 0).map(x => fmt(x, 4)).join(' ')} mm; inner gaps ${st.G.concat(st.G.slice(0, n - nh).reverse()).map(x => fmt(x, 4)).join(' ')} mm; gaps between hairpins ${S.filter((_, i) => i % 2 === 1).map(x => fmt(x, 4)).join(' ')} mm`,
    `arm length ${fmt(armLen, 5)} mm (${fmt(st.la, 5)}° at f0); tap ${fmt(tapMm, 4)} mm from the bend end of the outer arms`,
    `U bottoms: two optimally mitred bends and the inner-gap line; open ends: KJK Δl as a capacitance; taps: Hammerstad tee`,
    `realised (lossless): centre ${fmt(a.fc / 1e9, 6)} GHz, −3 dB FBW ${fmt(a.bw3 * 100, 4)} % (ideal ${fmt(a.bw3ideal * 100, 4)} %), worst return loss over the central 80 % of the ripple band ${fmt(a.rlCore, 4)} dB${isFinite(a.rlTarget) ? ` (ideal ${fmt(a.rlTarget, 4)} dB)` : ''}`,
    `insertion loss at f0 ${fmt(il, 3)} dB with the substrate's conductor and dielectric loss`,
    `spurious passband near 2f0: peak S21 ${fmt(sp.peak, 3)} dB at ${fmt(sp.f / 1e9, 4)} GHz (${fmt(sp.f / f0, 4)} f0)`,
  ];
  return { netlist: hairpinNetlist(spec, sub, st, { layout: true }), report: st.report, warnings, assess: a, log, spurious: sp, il, substrate: sub.id, state: st, geometry: { W, S, armLen, tapMm } };
}

function assessNet(text, s) {
  const [ra, rb] = rippleEdges(s.f0, s.fbw), lo = s.f0 * (1 - 3 * s.fbw), hi = s.f0 * (1 + 3 * s.fbw);
  const d = parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${lo} ${hi} 2001`)), res = solveNet(d);
  const S21 = res.S(2, 1), S11 = res.S(1, 1), F = res.freq;
  const edges = (mag) => { let k0 = -1, k1 = -1; for (let k = 0; k < F.length; k++) if (mag(k) >= Math.SQRT1_2) { if (k0 < 0) k0 = k; k1 = k; } if (k0 <= 0 || k1 >= F.length - 1) return null; const ip = (a, b) => F[a] + (Math.SQRT1_2 - mag(a)) / (mag(b) - mag(a)) * (F[b] - F[a]); return [ip(k0 - 1, k0), ip(k1, k1 + 1)]; };
  const e = edges(k => Math.hypot(S21.re[k], S21.im[k])), ie = edges(k => idealS21(s.type, s.n, s.ripple, s.f0, s.fbw, F[k]));
  let rl = Infinity; const c0 = ra + 0.1 * (rb - ra), c1 = rb - 0.1 * (rb - ra);
  for (let k = 0; k < F.length; k++) if (F[k] >= c0 && F[k] <= c1) rl = Math.min(rl, -20 * Math.log10(Math.hypot(S11.re[k], S11.im[k])));
  return { fc: e ? Math.sqrt(e[0] * e[1]) : NaN, bw3: e ? (e[1] - e[0]) / Math.sqrt(e[0] * e[1]) : NaN, bw3ideal: ie ? (ie[1] - ie[0]) / Math.sqrt(ie[0] * ie[1]) : NaN, rlCore: rl, rlTarget: s.type === 'chebyshev' ? returnLossDb(s.ripple) : NaN };
}
