// Edge-coupled (parallel-coupled, Cohn) half-wave bandpass filters in microstrip (issue #38).
//
// Design (Matthaei, Young & Jones §10.03; Cohn 1958): admittance inverters from the low-pass prototype
//   J01 Z0 = √(πΔ / 2g0g1),  Jk,k+1 Z0 = πΔ / (2√(gk gk+1)),  Jn,n+1 Z0 = √(πΔ / 2gn gn+1)
//   Z0e = Z0 [1 + JZ0 + (JZ0)²],  Z0o = Z0 [1 − JZ0 + (JZ0)²]      (n + 1 coupled sections, Δ = FBW)
// Physical: each section a symmetric coupled microstrip pair (Kirschning–Jansen, js/microstrip.js) of
// width W and gap S for its Z0e/Z0o, θ = 90° at f0 for the mean modal velocity. Each resonator is open
// at both ends (KJK Δl as a capacitance) and changes width at its middle where the sections meet (a
// `step` element when the ratio is in the step model's range, ≥ 1.5:1).
// Microstrip's unequal even/odd velocities detune the sections, shrink the band and open a spurious
// passband near 2f0; the polish (the netlist's goals, Nelder–Mead on W, S, θ, symmetric) recovers the
// passband; the 2f0 response is reported, not cured (homogeneous TEM has a transmission zero at 2f0,
// where every section is λ/2; the velocity mismatch removes it).
import { gValues, returnLossDb, rippleEdges, idealS21 } from './synth.js';
import { synthMscoupled, mscoupled, msline, fabCheck } from './microstrip.js';
import { openEnd } from './discontinuities.js';
import { makeSubstrate } from './substrates.js';
import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { optimise, goalCost } from './optimize.js';

const C0 = 299792458;
const fmt = (x, d = 6) => +x.toPrecision(d);

/** Inverters and even/odd impedances of the n + 1 sections. */
export function ecPrototype({ type = 'chebyshev', n, ripple = 0.1, fbw, R0 = 50 }) {
  if (!(n >= 1 && n <= 12)) throw new Error('order n must be 1..12');
  if (!(fbw > 0 && fbw < 0.4)) throw new Error('fractional bandwidth must be between 0 and 40 %');
  const g = gValues(type, n, ripple), D = fbw;
  const J = Array.from({ length: n + 1 }, (_, k) => (k === 0 ? Math.sqrt(Math.PI * D / (2 * g[0] * g[1])) : k === n ? Math.sqrt(Math.PI * D / (2 * g[n] * g[n + 1])) : Math.PI * D / (2 * Math.sqrt(g[k] * g[k + 1]))));
  return { g, J, Ze: J.map(j => R0 * (1 + j + j * j)), Zo: J.map(j => R0 * (1 - j + j * j)) };
}

// frequencies where the ideal |S21|² = p, below and above the band
function idealEdges(s, p) {
  const id = (f) => idealS21(s.type, s.n, s.ripple, s.f0, s.fbw, f) ** 2;
  const find = (a, b, rising) => { for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if ((id(m) < p) === rising) a = m; else b = m; } return (a + b) / 2; };
  return [find(s.f0 * 0.5, s.f0, true), find(s.f0, s.f0 * 1.5, false)];
}

/**
 * The netlist for state st = { w[], s[], th[] } (per symmetric index m = 0..⌊n/2⌋; mm, mm, degrees at f0).
 * opts: { lossless, freq, goals (default true), tune (default true) }.
 */
export function ecNetlist(spec, sub, st, opts = {}) {
  const { n, f0, R0 = 50 } = spec, { lossless = false, goals = true, tune = true } = opts;
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t;
  const m = (k) => Math.min(k, n - k), W = (k) => st.w[m(k)];
  const fa = f0 * (1 - 1.5 * spec.fbw * 2), fb = f0 * (1 + 1.5 * spec.fbw * 2);
  const L = [];
  L.push(`.title Edge-coupled ${spec.type} n=${n} ${spec.type === 'chebyshev' ? spec.ripple + 'dB' : ''}, f0 = ${fmt(f0 / 1e9, 6)} GHz, FBW = ${fmt(spec.fbw * 100, 4)} % on ${sub.id}`);
  for (const line of st.report ?? []) L.push(`# ${line}`);
  L.push(`.freq ${opts.freq ?? `${fmt(Math.max(f0 * 0.05, fa))} ${fmt(fb)} 801`}`, `.ref ${fmt(f0, 9)}`, `.substrate ${sub.id}`);
  if (st.layout) L.push(`.layout ${st.layout}`);
  const minS = Math.max(0.1, (sub.fab?.minSpace ?? 0.1e-3) * 1e3), minW = Math.max(0.1, (sub.fab?.minTrace ?? 0.1e-3) * 1e3);
  const tr = (v, lo, hi, u) => (tune ? ` tune ${fmt(lo, 6)}${u} ${fmt(hi, 6)}${u}` : '');
  for (let i = 0; i <= Math.floor(n / 2); i++) {
    L.push(`.param w${i} = ${fmt(st.w[i], 7)}mm${tr(st.w[i], Math.max(minW, st.w[i] * 0.7), st.w[i] * 1.3, 'mm')}`);
    L.push(`.param s${i} = ${fmt(st.s[i], 7)}mm${tr(st.s[i], Math.max(minS, st.s[i] * 0.6), st.s[i] * 1.6, 'mm')}`);
    L.push(`.param th${i} = ${fmt(st.th[i], 8)}${tr(st.th[i], st.th[i] * 0.9, st.th[i] * 1.1, '')}`);
  }
  L.push(`port in ${R0}`, `port out ${R0}`);
  // resonator j (1..n): left half = line 2 of section j−1, right half = line 1 of section j; middle node
  // splits into jL/jR when its width changes
  const mid = (j, side) => (j === 0 ? 'in' : j === n + 1 ? 'out' : stepAt(j) ? `j${j}${side}` : `j${j}`);
  function stepAt(j) { const a = W(j - 1), b = W(j); return Math.max(a, b) / Math.min(a, b) >= 1.5; }
  for (let k = 0; k <= n; k++) {
    L.push(`cline S${k + 1} geom=msl W=w${m(k)} S=s${m(k)}`);
    L.push(`  len th${m(k)}*1deg`);
    if (lossless) L.push('  Q 1e30');
    L.push(`  A ${mid(k, 'R')} o${k + 1}a`, `  B o${k + 1}b ${mid(k + 1, 'L')}`, 'end');
  }
  // open ends: line 1 of section k (resonator k's right half) at its B end, line 2 (resonator k+1's
  // left half) at its A end; both lines of a section have its width
  for (let k = 0; k <= n; k++) {
    for (const [node, w] of [[`o${k + 1}a`, W(k)], [`o${k + 1}b`, W(k)]]) {
      const l = msline({ W: w / 1e3, h, er, t }), dl = openEnd({ W: w / 1e3, h, er, t }).dl;
      L.push(`Coe_${node} ${node} 0 ${fmt(dl * Math.sqrt(l.epsEff) / (C0 * l.Z0) * 1e12, 6)}p   # open-end fringing (Δl ${fmt(dl * 1e3, 4)} mm)`);
    }
  }
  for (let j = 1; j <= n; j++) if (stepAt(j)) L.push(`step ST${j} j${j}L j${j}R W1=w${m(j - 1)} W2=w${m(j)}`);
  if (goals) {
    const [ra, rb] = rippleEdges(f0, spec.fbw), [l3, h3] = idealEdges({ ...spec }, 0.5), m3 = 0.015 * (h3 - l3);
    if (spec.type === 'chebyshev') L.push(`.goal db(S11) < ${fmt(-returnLossDb(spec.ripple), 4)} ${fmt(ra + 0.02 * (rb - ra), 8)} ${fmt(rb - 0.02 * (rb - ra), 8)}`);
    L.push(`.goal db(S21) < -3 ${fmt(Math.max(f0 * 0.05, fa), 8)} ${fmt(l3 - m3, 8)}   # −3 dB band at most 3 % wider than ideal`);
    L.push(`.goal db(S21) < -3 ${fmt(h3 + m3, 8)} ${fmt(fb, 8)}`);
    const ideal = spec.type === 'chebyshev' ? `cheby(${n},${spec.ripple},${fmt(f0, 9)},${fmt(spec.fbw, 9)})` : `butter(${n},${fmt(f0, 9)},${fmt(spec.fbw, 9)})`;
    L.push(`.plot ylim=-70,0 db(S11) db(S21) db(${ideal})`, '.plot gd(S21)');
  }
  return L.join('\n') + '\n';
}

/**
 * Edge-coupled filter on a substrate: closed-form start, then the goal polish. spec: { type, n, ripple,
 * f0, fbw, R0 }; opts: { substrate }. Returns { netlist, state, report, warnings, assess }.
 */
export function realiseEdgeCoupled(spec0, opts = {}) {
  const spec = { type: 'chebyshev', ripple: 0.1, R0: 50, ...spec0 };
  if (spec.type === 'butterworth') spec.ripple = 0;
  const sub = makeSubstrate(opts.substrate ?? 'jlc-ro4350b-0.762'), warnings = [], log = [];
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t, n = spec.n, f0 = spec.f0;
  const P = ecPrototype(spec), half = Math.floor(n / 2);
  const st = { w: [], s: [], th: [] };
  for (let i = 0; i <= half; i++) {
    const x = synthMscoupled({ Ze: P.Ze[i], Zo: P.Zo[i], h, t, er });
    if (!x.converged) throw new Error(`section ${i + 1}: Z0e ${fmt(P.Ze[i], 4)} / Z0o ${fmt(P.Zo[i], 4)} Ω cannot be realised in coupled microstrip on ${sub.id}`);
    let W = x.W * 1e3, S = x.S * 1e3;
    const minS = Math.max(0.1, (sub.fab?.minSpace ?? 0.1e-3) * 1e3);
    if (S < minS) { warnings.push(`section ${i + 1}: gap ${fmt(S, 3)} mm is below the minimum space ${minS} mm; clamped (the coupling will be too weak: a narrower bandwidth or a thinner substrate helps)`); S = minS; }
    st.w.push(W); st.s.push(S); st.th.push(90);
  }
  const text = (o = {}) => ecNetlist(spec, sub, st, o);
  // polish: the netlist's goals, lossless, on a frequency list dense in the band
  const T = spec, [ra, rb] = rippleEdges(f0, spec.fbw), [l3, h3] = idealEdges(spec, 0.5), m3 = 0.015 * (h3 - l3);
  const lo = f0 * (1 - 3 * spec.fbw), hi = f0 * (1 + 3 * spec.fbw);
  const lin = (a, b, k) => Array.from({ length: k }, (_, i) => a + (b - a) * i / (k - 1));
  const eps = 1e-6 * (rb - ra);
  const F = Float64Array.from([...lin(lo, l3 - m3 - eps, 9), ...lin(ra + 0.02 * (rb - ra) + eps, rb - 0.02 * (rb - ra) - eps, 41), ...lin(h3 + m3 + eps, hi, 9)]);
  const cost = () => { const d = parseNetlist(text({ lossless: true })); return goalCost(d, solve(d, F)).cost; };
  let c = cost();
  log.push(`closed-form start: goal cost ${c.toExponential(2)}`);
  for (let round = 0; round < 6 && c > 0.05; round++) {
    const g = optimise(text({ lossless: true }), { maxiter: 600, freqs: F }); let it, last;
    while (!(it = g.next()).done) last = it.value;
    const out = it.value ?? last;
    for (let i = 0; i <= half; i++) { st.w[i] = out.best[`w${i}`] * 1e3; st.s[i] = out.best[`s${i}`] * 1e3; st.th[i] = out.best[`th${i}`]; }
    const c2 = cost();
    log.push(`polish ${round + 1}: goal cost ${c2.toExponential(2)}`);
    if (c2 > c * 0.95) { c = c2; break; }
    c = c2;
  }
  // checks, report
  for (let i = 0; i <= half; i++) { const fc = fabCheck({ W: st.w[i] / 1e3, S: st.s[i] / 1e3 }, sub); if (fc?.length) warnings.push(...fc.map(x => `section ${i + 1}: ${x}`)); }
  const d = parseNetlist(text({ lossless: true }));
  const rep = goalCost(d, solve(d)).report.filter(g => g.maxViolation > 1);
  if (rep.length) warnings.push(`misses its goals by more than 1 dB (lossless): ${rep.map(g => `${g.goal.src} ${g.goal.op} ${g.goal.value} by up to ${fmt(g.maxViolation, 3)} dB`).join('; ')}`);
  const a = assessText(text({ lossless: true }), spec);
  const il = ilAt(text({ goals: false }), f0), spur = spurious(text({ lossless: true, goals: false }), f0);
  const W = Array.from({ length: n + 1 }, (_, k) => st.w[Math.min(k, n - k)]), S = Array.from({ length: n + 1 }, (_, k) => st.s[Math.min(k, n - k)]), TH = Array.from({ length: n + 1 }, (_, k) => st.th[Math.min(k, n - k)]);
  const lens = Array.from({ length: n + 1 }, (_, k) => { const cm = mscoupled({ W: W[k] / 1e3, S: S[k] / 1e3, h, t, er, f: f0 }); const v = ((Math.sqrt(cm.epse) + Math.sqrt(cm.epso)) / 2); return TH[k] / 360 * C0 / v / f0 * 1e3; });
  st.report = [
    `substrate ${sub.id}: h ${fmt(h * 1e3, 4)} mm, εr ${er}; coupled microstrip (Kirschning–Jansen)`,
    `sections (Z0e/Z0o ${P.Ze.map((z, k) => `${fmt(z, 4)}/${fmt(P.Zo[k], 4)}`).join(', ')} Ω): widths ${W.map(x => fmt(x, 4)).join(' ')} mm; gaps ${S.map(x => fmt(x, 4)).join(' ')} mm; lengths ${lens.map(x => fmt(x, 4)).join(' ')} mm`,
    `realised (lossless): centre ${fmt(a.fc / 1e9, 6)} GHz, −3 dB FBW ${fmt(a.bw3 * 100, 4)} % (ideal ${fmt(a.bw3ideal * 100, 4)} %), worst return loss over the central 80 % of the ripple band ${fmt(a.rlCore, 4)} dB${isFinite(a.rlTarget) ? ` (ideal ${fmt(a.rlTarget, 4)} dB)` : ''}`,
    `insertion loss at f0 ${fmt(il, 3)} dB with the substrate's conductor and dielectric loss`,
    `spurious passband near 2f0: peak S21 ${fmt(spur.peak, 3)} dB at ${fmt(spur.f / 1e9, 4)} GHz (${fmt(spur.f / f0, 4)} f0). In homogeneous TEM each section is λ/2 there and transmits nothing; microstrip's unequal even/odd velocities remove that zero`,
    'open ends: KJK Δl as capacitances; width steps of 1.5:1 or more as step elements (smaller ones are not modelled)',
  ];
  st.layout = 'edgecoupled';
  return { netlist: text(), state: st, report: st.report, warnings, assess: a, log, spurious: spur, il, substrate: sub.id, W, S, lengths: lens };
}

function assessText(text, s) {
  const [ra, rb] = rippleEdges(s.f0, s.fbw), lo = s.f0 * (1 - 3 * s.fbw), hi = s.f0 * (1 + 3 * s.fbw);
  const d = parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${lo} ${hi} 2001`)), res = solve(d);
  const S21 = res.S(2, 1), S11 = res.S(1, 1), F = res.freq;
  const edges = (mag) => { let k0 = -1, k1 = -1; for (let k = 0; k < F.length; k++) if (mag(k) >= Math.SQRT1_2) { if (k0 < 0) k0 = k; k1 = k; } if (k0 <= 0 || k1 >= F.length - 1) return null; const ip = (a, b) => F[a] + (Math.SQRT1_2 - mag(a)) / (mag(b) - mag(a)) * (F[b] - F[a]); return [ip(k0 - 1, k0), ip(k1, k1 + 1)]; };
  const e = edges(k => Math.hypot(S21.re[k], S21.im[k])), ie = edges(k => idealS21(s.type, s.n, s.ripple, s.f0, s.fbw, F[k]));
  let rl = Infinity; const c0 = ra + 0.1 * (rb - ra), c1 = rb - 0.1 * (rb - ra);
  for (let k = 0; k < F.length; k++) if (F[k] >= c0 && F[k] <= c1) rl = Math.min(rl, -20 * Math.log10(Math.hypot(S11.re[k], S11.im[k])));
  return { fc: e ? Math.sqrt(e[0] * e[1]) : NaN, bw3: e ? (e[1] - e[0]) / Math.sqrt(e[0] * e[1]) : NaN, bw3ideal: ie ? (ie[1] - ie[0]) / Math.sqrt(ie[0] * ie[1]) : NaN, rlCore: rl, rlTarget: s.type === 'chebyshev' ? returnLossDb(s.ripple) : NaN };
}
function ilAt(text, f) { const d = parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${f} ${f} 1`)), s = solve(d).S(2, 1); return -20 * Math.log10(Math.hypot(s.re[0], s.im[0])); }
function spurious(text, f0) {
  const d = parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${1.6 * f0} ${2.4 * f0} 801`)), r = solve(d), s = r.S(2, 1);
  let best = { peak: -Infinity, f: NaN };
  for (let k = 0; k < r.freq.length; k++) { const v = 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); if (v > best.peak) best = { peak: v, f: r.freq[k] }; }
  return best;
}
