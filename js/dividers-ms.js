// Microstrip realisations of the compact Wilkinson divider and the branch-line hybrid (issue #39).
//
// Compact Wilkinson, n sections (equal split):
//   The two arms run side by side at a gap s from the input, each section k a pair of width W_k and
//   length L_k; a chip resistor (`res`, js/resistors.js) bridges the arm ends of every section — the
//   arms' centre spacing W + s is close to the resistor's pad pitch, so its pads land on both arms. After
//   the last resistor each output turns away (two optimally mitred bends, js/routing.js) to the port
//   pitch, at the port impedance (a `step` from the arm width where it is 1.5:1 or more).
//   coupled: true models each section as a coupled pair (the even mode carries the divided power, the
//   odd mode the isolation; their impedances and velocities differ, which is what a compact layout does
//   to a Wilkinson); coupled: false as two independent lines — the usual simplification, kept for
//   comparison. The input line meets both arms at x = 0 (that junction is not modelled).
//   Design: the ideal Chebyshev arm impedances (js/dividers.js), realised as the pair's even-mode
//   impedance (coupled) or a single line (uncoupled), 90° at f0, the ideal resistors; then the goal
//   polish (match at all three ports, isolation) moves the widths, lengths and resistors.
//
// Branch-line hybrid: a rectangle of lines — series arms R0/√2 (top, bottom), shunt arms R0 (left,
//   right) — with a Hammerstad tee (js/tee.js) at each corner: the port line and the series arm are
//   the main arms, the shunt arm the side arm. Lengths are measured between the tees' reference planes.
//   Design: closed-form impedances and 90° lines, then the goal polish (match and isolation across the
//   band, equal split at f0) on the widths and lengths, which absorbs the tees.
import { wilkinson } from './dividers.js';
import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { optimise, goalCost } from './optimize.js';
import { makeSubstrate } from './substrates.js';
import { msline, mscoupled, synthMsline } from './microstrip.js';
import { routeOrtho } from './routing.js';
import { RES_PACKAGES } from './resistors.js';

const C0 = 299792458;
const fmt = (x, d = 7) => +x.toPrecision(d);
const lin = (a, b, k) => Array.from({ length: k }, (_, i) => a + (b - a) * i / (k - 1));

// ---------------------------------------------------------------- compact Wilkinson
// the output route (mm, from the last resistor at x = xe): its inner edge on the arm's inner edge (±s/2,
// so the gap stays s and the width step goes outwards), out by a, across to the port pitch, out by b
export function wilkinsonRoute(xe, s, pitch, wf, sgn) {
  const a = Math.max(2 * wf, 3), b = Math.max(2 * wf, 3), y0 = sgn * (s / 2 + wf / 2);
  return [[xe, y0], [xe + a, y0], [xe + a, sgn * pitch / 2], [xe + a + b, sgn * pitch / 2]];
}

export function wilkinsonMsNetlist(spec, sub, st, opts = {}) {
  const { f0, R0 = 50, sections: n } = spec, coupled = st.coupled, pkg = st.pkg;
  const L = [];
  L.push(`.title Compact Wilkinson, ${n} section${n > 1 ? 's' : ''}, f0 = ${fmt(f0 / 1e9, 5)} GHz on ${sub.id} (arms ${coupled ? 'modelled as coupled pairs' : 'modelled as independent lines'})`);
  for (const r of st.report ?? []) L.push(`# ${r}`);
  L.push(`.freq ${opts.freq ?? `${fmt(f0 * 0.5)} ${fmt(f0 * 1.5)} 401`}`, `.ref ${fmt(f0, 9)}`, `.substrate ${sub.id}`);
  if (opts.layout) L.push(`.layout wilkinson pitch=${fmt(st.pitch, 5)}mm`);
  const tune = (v, lo, hi, u = '') => (opts.tune === false || opts.fixed ? '' : ` tune ${fmt(lo, 5)}${u} ${fmt(hi, 5)}${u}`);
  L.push(`.param s = ${fmt(st.s, 6)}mm   # gap between the arms (the resistor bridges it)`, `.param wf = ${fmt(st.wf, 6)}mm   # port lines (${R0} ohm)`);
  for (let k = 0; k < n; k++) {
    L.push(`.param w${k + 1} = ${fmt(st.W[k], 7)}mm${tune(st.W[k], st.W[k] * 0.7, st.W[k] * 1.4, 'mm')}`);
    L.push(`.param l${k + 1} = ${fmt(st.L[k], 7)}mm${tune(st.L[k], st.L[k] * 0.8, st.L[k] * 1.2, 'mm')}`);
    L.push(`.param r${k + 1} = ${fmt(st.R[k], 6)}${tune(st.R[k], st.R[k] * 0.5, st.R[k] * 2)}`);
  }
  L.push(`port in ${R0}`, `port o1 ${R0}`, `port o2 ${R0}`);
  for (let k = 0; k < n; k++) {
    const a = k ? `a${k}` : 'in', b = k ? `b${k}` : 'in';
    if (coupled) L.push(`cline K${k + 1} geom=msl W=w${k + 1} S=s`, `  len l${k + 1}`, ...(opts.lossless ? ['  Q 1e30'] : []), `  A ${a} ${b}`, `  B a${k + 1} b${k + 1}`, 'end');
    else L.push(`T${k + 1}a ${a} a${k + 1} W=w${k + 1} len=l${k + 1}${opts.lossless ? ' Q=1e30' : ''}`, `T${k + 1}b ${b} b${k + 1} W=w${k + 1} len=l${k + 1}${opts.lossless ? ' Q=1e30' : ''}`);
    L.push(`res R${k + 1} a${k + 1} b${k + 1} R=r${k + 1} pkg=${pkg}${opts.lossless ? '' : ''}`);
  }
  // outputs: width step (when modelled) and the route to the port pitch
  const wn = st.W[n - 1], step = Math.max(wn, st.wf) / Math.min(wn, st.wf) >= 1.5, xe = st.L.reduce((x, y) => x + y, 0);
  for (const [arm, port, sgn] of [['a', 'o1', -1], ['b', 'o2', 1]]) {
    const from = step ? `${arm}${n}s` : `${arm}${n}`;
    if (step) L.push(`step ST${arm} ${arm}${n} ${from} W1=w${n} W2=wf`);
    const rt = routeOrtho(wilkinsonRoute(xe, st.s, st.pitch, st.wf, sgn), { W: st.wf, mitre: 'opt', sub, name: `O${arm}`, a: from, b: port });
    L.push(...rt.lines.map(l => (opts.lossless && /^T/.test(l) ? `${l} Q=1e30` : l)));
  }
  if (opts.goals !== false) {
    const lo = f0 * (1 - st.fbw / 2), hi = f0 * (1 + st.fbw / 2);
    L.push(`.goal db(S11) < -20 ${fmt(lo)} ${fmt(hi)}`, `.goal db(S22) < -20 ${fmt(lo)} ${fmt(hi)}`, `.goal db(S32) < -20 ${fmt(lo)} ${fmt(hi)}`);
    L.push('.plot ylim=-50,0 db(S11) db(S21) db(S31) db(S22) db(S32)');
  }
  return L.join('\n') + '\n';
}

/**
 * spec: { f0, R0, sections (1–3), fbw }; opts: { substrate, coupled (default true), gap (mm), pitch (mm,
 * default 12: the SMA courtyard), pkg ('0603') }. Returns { netlist, report, warnings, state, assess }.
 */
export function realiseWilkinson(spec0, opts = {}) {
  const spec = { R0: 50, sections: 1, fbw: 0.2, ...spec0 };
  const sub = makeSubstrate(opts.substrate ?? 'jlc-ro4350b-1.524'), warnings = [], log = [];
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t, f0 = spec.f0, n = spec.sections, R0 = spec.R0;
  const ideal = wilkinson({ f0, R0, sections: n, fbw: Math.max(spec.fbw, 0.2) });
  const pkg = opts.pkg ?? '0603', P = RES_PACKAGES[pkg];
  if (!P) throw new Error(`unknown resistor package ${pkg}`);
  const minS = Math.max(0.1, (sub.fab?.minSpace ?? 0.1e-3) * 1e3);
  const coupled = opts.coupled ?? true;
  const wf = synthMsline({ Z0: R0, h, t, er, f: f0 }).W * 1e3;
  // the gap: the resistor's pads (centres ±x, length l along the resistor) must each overlap their arm by
  // at least 0.3 mm: (W + s)/2 − W/2 ≤ x + l/2 − 0.3 → s ≤ 2x + l − 0.6
  const sMax = 2 * P.pads.x + P.pads.l - 0.6, s = opts.gap ?? Math.max(minS, Math.min(1.0, sMax));
  if (s > sMax + 1e-9) throw new Error(`wilkinson: a ${s} mm gap is wider than the ${pkg} resistor can bridge (≤ ${fmt(sMax, 3)} mm)`);
  const st = { coupled, pkg, s, wf, pitch: opts.pitch ?? 12, fbw: spec.fbw, W: [], L: [], R: [...ideal.R] };
  for (const Z of ideal.Z) {
    let W;
    if (coupled) { let lo = 0.05, hi = 20; for (let i = 0; i < 60; i++) { const m = Math.sqrt(lo * hi), c = mscoupled({ W: m / 1e3, S: s / 1e3, h, t, er, f: f0 }); if (c.Ze > Z) lo = m; else hi = m; } W = Math.sqrt(lo * hi); }
    else W = synthMsline({ Z0: Z, h, t, er, f: f0 }).W * 1e3;
    const eps = coupled ? mscoupled({ W: W / 1e3, S: s / 1e3, h, t, er, f: f0 }).epse : msline({ W: W / 1e3, h, t, er, f: f0 }).epsEff;
    st.W.push(W); st.L.push(C0 / Math.sqrt(eps) / f0 / 4 * 1e3);
  }
  const lo = f0 * (1 - spec.fbw / 2), hi = f0 * (1 + spec.fbw / 2), F = Float64Array.from(lin(lo, hi, 31));
  const text = (o = {}) => wilkinsonMsNetlist(spec, sub, st, o);
  const cost = () => { const d = parseNetlist(text({ lossless: true })); return goalCost(d, solve(d, F)).cost; };
  let c = cost();
  log.push(`start (${coupled ? 'coupled' : 'uncoupled'} arms, gap ${fmt(s, 3)} mm): goal cost ${c.toExponential(2)}`);
  for (let round = 0; round < 4 && c > 1e-4; round++) {
    const g = optimise(text({ lossless: true }), { maxiter: 400, freqs: F }); let it, last;
    while (!(it = g.next()).done) last = it.value;
    const b = (it.value ?? last).best;
    st.W = st.W.map((_, k) => b[`w${k + 1}`] * 1e3); st.L = st.L.map((_, k) => b[`l${k + 1}`] * 1e3); st.R = st.R.map((_, k) => b[`r${k + 1}`]);
    const c2 = cost(); log.push(`polish ${round + 1}: goal cost ${c2.toExponential(2)}`);
    if (c2 > c * 0.95) { c = c2; break; }
    c = c2;
  }
  const a = assessDivider(text({ lossless: true, goals: false }), lo, hi, 3);
  st.report = [
    `substrate ${sub.id}; arms ${coupled ? 'as coupled pairs (Kirschning–Jansen)' : 'as independent lines'} at a ${fmt(s, 3)} mm gap; ${pkg} resistors bridging it`,
    `sections: ${st.W.map((w, k) => `W ${fmt(w, 4)} mm, ${fmt(st.L[k], 4)} mm, R ${fmt(st.R[k], 4)} Ω`).join('; ')}; outputs at a ${fmt(st.pitch, 3)} mm pitch through two mitred bends each`,
    `lossless, ${fmt(lo / 1e9, 4)}–${fmt(hi / 1e9, 4)} GHz: return loss ≥ ${fmt(a.rl[0], 3)} dB (input), ≥ ${fmt(a.rl[1], 3)} dB (outputs); isolation ≥ ${fmt(a.iso, 3)} dB; split ${fmt(a.split[0], 4)} … ${fmt(a.split[1], 4)} dB`,
    'not modelled: the junction where the input line meets both arms; the resistor body over the gap (its pads, ESL and body capacitance are)',
  ];
  if (a.iso < 20) warnings.push(`isolation only ${fmt(a.iso, 3)} dB over the band`);
  return { netlist: text({ layout: true }), report: st.report, warnings, log, state: st, assess: a, spec, sub };
}

// worst return loss at each port group, isolation (ports 2–3, or 1–4 for a hybrid), split range (dB)
export function assessDivider(text, lo, hi, nports) {
  const d = parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${lo} ${hi} 101`)), r = solve(d), F = r.freq;
  const db = (i, j, k) => { const s = r.S(i, j); return 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); };
  const worst = (fn) => { let m = -Infinity; for (let k = 0; k < F.length; k++) m = Math.max(m, fn(k)); return m; };
  if (nports === 3) {
    const sp = Array.from(F, (_, k) => db(2, 1, k));
    return { rl: [-worst(k => db(1, 1, k)), -worst(k => Math.max(db(2, 2, k), db(3, 3, k)))], iso: -worst(k => db(3, 2, k)), split: [Math.min(...sp), Math.max(...sp)] };
  }
  const sp = Array.from(F, (_, k) => [db(2, 1, k), db(3, 1, k)]).flat();
  const ph = Array.from(F, (_, k) => { const a = r.S(2, 1), b = r.S(3, 1); let x = (Math.atan2(b.im[k], b.re[k]) - Math.atan2(a.im[k], a.re[k])) * 180 / Math.PI; while (x > 180) x -= 360; while (x < -180) x += 360; return x; });
  return { rl: [-worst(k => db(1, 1, k))], iso: -worst(k => db(4, 1, k)), split: [Math.min(...sp), Math.max(...sp)], phase: [Math.min(...ph), Math.max(...ph)] };
}

// ---------------------------------------------------------------- branch-line hybrid
export function branchlineMsNetlist(spec, sub, st, opts = {}) {
  const { f0, R0 = 50 } = spec, L = [];
  L.push(`.title Branch-line hybrid, f0 = ${fmt(f0 / 1e9, 5)} GHz on ${sub.id}`);
  for (const r of st.report ?? []) L.push(`# ${r}`);
  L.push(`.freq ${opts.freq ?? `${fmt(f0 * 0.6)} ${fmt(f0 * 1.4)} 401`}`, `.ref ${fmt(f0, 9)}`, `.substrate ${sub.id}`);
  if (opts.layout) L.push('.layout branchline');
  const tune = (v, a, b) => (opts.tune === false ? '' : ` tune ${fmt(v * a, 5)}mm ${fmt(v * b, 5)}mm`);
  L.push(`.param wse = ${fmt(st.wse, 7)}mm${tune(st.wse, 0.7, 1.4)}   # series arms (R0/√2)`, `.param wsh = ${fmt(st.wsh, 7)}mm${tune(st.wsh, 0.7, 1.4)}   # shunt arms (R0)`,
    `.param lse = ${fmt(st.lse, 7)}mm${tune(st.lse, 0.85, 1.15)}`, `.param lsh = ${fmt(st.lsh, 7)}mm${tune(st.lsh, 0.85, 1.15)}`, `.param wf = ${fmt(st.wf, 6)}mm   # port lines`);
  L.push(`port p1 ${R0}   # input`, `port p2 ${R0}   # through`, `port p3 ${R0}   # coupled`, `port p4 ${R0}   # isolated`);
  const q = opts.lossless ? ' Q=1e30' : '';
  L.push('tee TJ1 p1 s1 v1 Wa=wf Wb=wse W2=wsh', 'tee TJ2 s2 p2 v2 Wa=wse Wb=wf W2=wsh', 'tee TJ3 s3 p3 v3 Wa=wse Wb=wf W2=wsh', 'tee TJ4 p4 s4 v4 Wa=wf Wb=wse W2=wsh',
    `Tse1 s1 s2 W=wse len=lse${q}`, `Tse2 s4 s3 W=wse len=lse${q}`, `Tsh1 v1 v4 W=wsh len=lsh${q}`, `Tsh2 v2 v3 W=wsh len=lsh${q}`);
  if (opts.goals !== false) {
    const lo = f0 * (1 - st.fbw / 2), hi = f0 * (1 + st.fbw / 2);
    L.push(`.goal db(S11) < -20 ${fmt(lo)} ${fmt(hi)}`, `.goal db(S41) < -20 ${fmt(lo)} ${fmt(hi)}`, `.goal db(S21) = -3.0103 ${fmt(f0)} ${fmt(f0)}`, `.goal db(S31) = -3.0103 ${fmt(f0)} ${fmt(f0)}`);
    L.push('.plot ylim=-40,0 db(S11) db(S21) db(S31) db(S41)', '.plot ang(S31/S21)');
  }
  return L.join('\n') + '\n';
}

export function realiseBranchline(spec0, opts = {}) {
  const spec = { R0: 50, fbw: 0.1, ...spec0 };
  const sub = makeSubstrate(opts.substrate ?? 'jlc-ro4350b-1.524'), warnings = [], log = [];
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t, f0 = spec.f0, R0 = spec.R0;
  const q = (Z) => { const W = synthMsline({ Z0: Z, h, t, er, f: f0 }).W * 1e3; return { W, l: C0 / Math.sqrt(msline({ W: W / 1e3, h, t, er, f: f0 }).epsEff) / f0 / 4 * 1e3 }; };
  const se = q(R0 / Math.SQRT2), sh = q(R0);
  const st = { wse: se.W, wsh: sh.W, wf: synthMsline({ Z0: R0, h, t, er, f: f0 }).W * 1e3, fbw: spec.fbw };
  st.lse = se.l - st.wsh; st.lsh = sh.l - st.wse;                       // between the tees' planes (≈ minus the crossing strip)
  const lo = f0 * (1 - spec.fbw / 2), hi = f0 * (1 + spec.fbw / 2), F = Float64Array.from([...lin(lo, hi, 21), f0].sort((a, b) => a - b));
  const text = (o = {}) => branchlineMsNetlist(spec, sub, st, o);
  const cost = () => { const d = parseNetlist(text({ lossless: true })); return goalCost(d, solve(d, F)).cost; };
  let c = cost(); log.push(`start: goal cost ${c.toExponential(2)}`);
  for (let round = 0; round < 4 && c > 1e-4; round++) {
    const g = optimise(text({ lossless: true }), { maxiter: 400, freqs: F }); let it, last;
    while (!(it = g.next()).done) last = it.value;
    Object.assign(st, Object.fromEntries(['wse', 'wsh', 'lse', 'lsh'].map(k => [k, (it.value ?? last).best[k] * 1e3])));
    const c2 = cost(); log.push(`polish ${round + 1}: goal cost ${c2.toExponential(2)}`);
    if (c2 > c * 0.95) { c = c2; break; }
    c = c2;
  }
  const a = assessDivider(text({ lossless: true, goals: false }), lo, hi, 4);
  st.report = [
    `substrate ${sub.id}; Hammerstad tees at the corners`,
    `series arms W ${fmt(st.wse, 4)} mm × ${fmt(st.lse, 4)} mm, shunt arms W ${fmt(st.wsh, 4)} mm × ${fmt(st.lsh, 4)} mm (between the tees' planes); port lines ${fmt(st.wf, 4)} mm`,
    `lossless, ${fmt(lo / 1e9, 4)}–${fmt(hi / 1e9, 4)} GHz: return loss ≥ ${fmt(a.rl[0], 3)} dB; isolation ≥ ${fmt(a.iso, 3)} dB; through/coupled ${fmt(a.split[0], 4)} … ${fmt(a.split[1], 4)} dB; phase difference ${fmt(a.phase[0], 4)} … ${fmt(a.phase[1], 4)}°`,
  ];
  return { netlist: text({ layout: true }), report: st.report, warnings, log, state: st, assess: a, spec, sub };
}
