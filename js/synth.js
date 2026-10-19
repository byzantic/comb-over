// Closed-form synthesis of tapped comb-line and interdigital bandpass filters, with optional
// numerical refinement using the analysis engine.
//
// Method (nodal / coupled-resonator):
//   prototype g_k  →  k_{i,i+1} = FBW/√(g_i g_{i+1}),  Qe = g0 g1 / FBW = g_n g_{n+1} / FBW
//
// Homogeneous array of N = n resonator lines, characteristic admittance matrix Y0 = vC with
// diagonal Ya (each line's admittance with all neighbours grounded) and adjacent mutuals −Ym_i.
// Node = the open end of each resonator, all other resonator nodes shorted:
//
//   comb-line (all shorted at A, capacitor Cl at B, length θ0):
//     B_ii(ω) = ωCl − Ya cot θ,  B_i,i+1(ω) = Ym cot θ     (θ = θ0 ω/ω0)
//     resonance at ω0:  Cl = Ya cot θ0 / ω0
//     slope b = (ω0/2) dB_ii/dω = (Ya/2)(cot θ0 + θ0 csc² θ0)
//     J = Ym cot θ0           ⇒ Ym = k b / cot θ0
//   interdigital (alternate ends shorted, θ0 = 90°, no capacitors):
//     B_ii = −Ya cot θ,  |B_i,i+1| = Ym csc θ,  b = (π/4) Ya,  J = Ym  ⇒ Ym = k b
//
// Tapped input/output: with the resonator voltage ∝ sin(βz) from its short, a load R0 tapped at θt
// appears at the open end as G0 (sin θt / sin θ0)², hence
//     sin θt = sin θ0 √(b R0 / Qe).
//
// Refinement: (i) each Ym is corrected so the split-mode coupling of the isolated pair,
// k = (fo² − fe²)/(fo² + fe²), equals the target (exact for this model, solved by root finding);
// (ii) the tap position (and, for comb-line, the end capacitor) is corrected using the full
// multi-conductor model of the singly loaded first resonator: the S11 group-delay peak gives
// f_res and Qe = ω_res τ_max / 4.

import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { C0, ETA0 } from './section.js';

// ---------------- low-pass prototypes ----------------
export function gValues(type, n, rippleDb = 0.1) {
  const g = [1];
  if (type === 'butterworth') {
    for (let k = 1; k <= n; k++) g.push(2 * Math.sin((2 * k - 1) * Math.PI / (2 * n)));
    g.push(1);
    return g;
  }
  if (type !== 'chebyshev') throw new Error(`unknown prototype "${type}"`);
  if (!(rippleDb > 0)) throw new Error('Chebyshev ripple must be > 0 dB');
  const beta = Math.log(1 / Math.tanh(rippleDb / 17.37));
  const gam = Math.sinh(beta / (2 * n));
  const a = (k) => Math.sin((2 * k - 1) * Math.PI / (2 * n));
  const b = (k) => gam * gam + Math.sin(k * Math.PI / n) ** 2;
  g.push(2 * a(1) / gam);
  for (let k = 2; k <= n; k++) g.push(4 * a(k - 1) * a(k) / (b(k - 1) * g[k - 1]));
  g.push(n % 2 ? 1 : 1 / Math.tanh(beta / 4) ** 2);
  return g;
}

export { idealS21 } from './synth-ideal.js';
import { idealS21 } from './synth-ideal.js';

export function returnLossDb(rippleDb) { return -10 * Math.log10(1 - 10 ** (-rippleDb / 10)); }
export function rippleEdges(f0, fbw) { // f/f0 − f0/f = ±FBW
  const s = Math.sqrt(1 + fbw * fbw / 4);
  return [f0 * (s - fbw / 2), f0 * (s + fbw / 2)];
}

// ---------------- closed-form design ----------------
function resonatorModel(structure, Ya, theta0) {
  if (structure === 'comb') {
    const ct = 1 / Math.tan(theta0), cs2 = 1 / Math.sin(theta0) ** 2;
    return { b: (Ya / 2) * (ct + theta0 * cs2), jPerYm: ct };
  }
  return { b: (Math.PI / 4) * Ya, jPerYm: 1 / Math.sin(theta0) };
}

// Split-mode resonant frequencies of an isolated pair (others grounded): returns [fe, fo] (fe < fo).
function pairSplit(structure, Ya, Ym, Cl, theta0, f0) {
  // mode condition: B_ii(ω) ± B_i,i+1(ω) = 0
  const F = (f, s) => {
    const th = theta0 * f / f0;
    if (structure === 'comb') return 2 * Math.PI * f * Cl - (Ya + s * Ym) / Math.tan(th);
    return -Ya / Math.tan(th) + s * Ym / Math.sin(th);
  };
  const root = (s) => {
    // B_ii − ... is monotonic increasing in f on (0, f(θ=π)); bracket around f0
    let lo = f0 * 1e-3, hi = f0 * Math.PI / theta0 * (1 - 1e-9);
    for (let i = 0; i < 200; i++) {
      const m = 0.5 * (lo + hi);
      if (F(m, s) > 0) hi = m; else lo = m;
    }
    return 0.5 * (lo + hi);
  };
  const a = root(+1), c = root(-1);
  return a < c ? [a, c] : [c, a];
}
const splitK = ([fe, fo]) => (fo * fo - fe * fe) / (fo * fo + fe * fe);

const DEFAULTS = {
  structure: 'comb', type: 'chebyshev', n: 4, ripple: 0.0432, f0: 1e9, fbw: 0.1,
  theta0Deg: 45, Zr: 70, er: 1, R0: 50, refine: true,
};

// Full design. With refine on, after the per-element corrections the realised centre frequency
// and −3 dB bandwidth are measured and the design f0 / FBW are pre-distorted to land on target.
export function design(spec) {
  const s = { ...DEFAULTS, ...spec };
  const target = { f0: s.f0, fbw: s.fbw };
  let r = designAt({ ...s, target });
  if (!s.refine) { addSkirt(r); r.netlist = toNetlist(r); return r; }
  let f0d = s.f0, fbwd = s.fbw;
  for (let it = 0; it < 6; it++) {
    if (r.warnings.length) break; // don't chase centre/bandwidth on a design that is already compromised
    let a;
    try { a = assess(r); } catch (e) { r.warnings.push(`centre/bandwidth correction stopped: ${e.message}`); break; }
    if (!isFinite(a.fc) || !isFinite(a.bw3)) break;
    const ef = s.f0 / a.fc, eb = a.bw3ideal / a.bw3;
    if (Math.abs(ef - 1) < 2e-5 && Math.abs(eb - 1) < 5e-4) break;
    let next;
    try { next = designAt({ ...s, f0: f0d * ef, fbw: fbwd * eb, target }); }
    catch (e) { r.warnings.push(`centre/bandwidth correction stopped: ${e.message}`); break; }
    f0d *= ef; fbwd *= eb; r = next;
  }
  r.predistort = { f0: f0d, fbw: fbwd };
  addSkirt(r);
  r.netlist = toNetlist(r);
  return r;
}

// Skirt goals for the optimiser: hold the rejection at the ideal −20 dB points to (realised + 0.5 dB),
// so polishing the passband ripple cannot buy return loss by widening the band. The realised value
// is used rather than the ideal one because comb-line skirts are inherently asymmetric.
function addSkirt(r) {
  const T = r.spec.target ?? r.spec, sp = { ...r.spec, ...T };
  const edge = (side) => {
    let lo = side < 0 ? T.f0 * 0.05 : T.f0, hi = side < 0 ? T.f0 : T.f0 * 4;
    for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2, v = idealS21(sp.type, sp.n, sp.ripple, T.f0, T.fbw, m); if ((v < 0.1) === (side < 0)) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const fl = edge(-1), fh = edge(1);
  try {
    const d = parseNetlist(toNetlist(r).replace(/^\.freq .*$/m, `.freq ${fl} ${fh} 2`));
    const S = solve(d).S(2, 1);
    const a = [0, 1].map(k => 20 * Math.log10(Math.hypot(S.re[k], S.im[k])));
    if (a.every(isFinite)) r.skirt = { fl, fh, al: a[0], ah: a[1] };
  } catch { /* leave without skirt goals */ }
}

export function designAt(s) {
  const { structure, type, n, f0, fbw, R0 } = s;
  if (!(n >= 2 && n <= 12)) throw new Error('order n must be 2..12');
  if (!(fbw > 0 && fbw < 1)) throw new Error('fractional bandwidth must be in (0, 1)');
  const theta0 = (structure === 'interdigital' ? 90 : s.theta0Deg) * Math.PI / 180;
  if (structure === 'comb' && !(theta0 > 0 && theta0 < Math.PI / 2)) throw new Error('comb-line θ0 must be between 0 and 90°');
  const v = C0 / Math.sqrt(s.er), eta = ETA0 / Math.sqrt(s.er), w0 = 2 * Math.PI * f0;
  const g = gValues(type, n, s.ripple);
  const k = Array.from({ length: n - 1 }, (_, i) => fbw / Math.sqrt(g[i + 1] * g[i + 2]));
  const Qe = g[0] * g[1] / fbw, QeOut = g[n] * g[n + 1] / fbw;
  const Ya = 1 / s.Zr;
  const { b, jPerYm } = resonatorModel(structure, Ya, theta0);
  const Cl = structure === 'comb' ? Ya / Math.tan(theta0) / w0 : 0;
  const warnings = [];

  // closed form
  const Ym0 = k.map(ki => ki * b / jPerYm);
  const sinT0 = Math.sin(theta0) * Math.sqrt(b * R0 / Qe);
  if (sinT0 >= 1) throw new Error(`tap position impossible (sin θt = ${sinT0.toFixed(3)} > 1): raise Zr, lower R0, or reduce the bandwidth`);
  const thetaT0 = Math.asin(sinT0);
  const closed = { Ym: Ym0, thetaT: thetaT0, Cl1: Cl };

  // refinement
  let Ym = Ym0.slice(), thetaT = thetaT0, Cl1 = Cl;
  const achieved = { k: Ym0.map(y => splitK(pairSplit(structure, Ya, y, Cl, theta0, f0))) };
  let tapReport = null;
  if (s.refine) {
    Ym = k.map((kt, i) => {
      let y = Ym0[i];
      for (let it = 0; it < 30; it++) {
        const ke = splitK(pairSplit(structure, Ya, y, Cl, theta0, f0));
        const r = kt / ke; y *= r;
        if (Math.abs(r - 1) < 1e-10) break;
      }
      return y;
    });
    achieved.k = Ym.map(y => splitK(pairSplit(structure, Ya, y, Cl, theta0, f0)));
    tapReport = refineTap({ ...s, theta0, v, eta, Ya, Ym, Cl, Qe, g });
    thetaT = tapReport.thetaT; Cl1 = tapReport.Cl1;
    if (tapReport.thetaT >= 0.979 * theta0 || Math.abs(tapReport.Qe / Qe - 1) > 0.01)
      warnings.push(`the tap cannot reach Qe = ${Qe.toPrecision(4)} (achieved ${tapReport.Qe.toPrecision(4)} with the tap at ${(tapReport.thetaT * 180 / Math.PI).toPrecision(4)}°); raise Zr, lower R0, or reduce the bandwidth`);
    if (structure === 'comb' && !(tapReport.Cl1 > 0))
      throw new Error('tap loading pulls resonator 1 so far that it would need a negative end capacitor; reduce the bandwidth');
    if (Math.abs(tapReport.fres / f0 - 1) > 0.02 * fbw)
      warnings.push(`tap loading leaves resonator 1 at ${(tapReport.fres / 1e9).toPrecision(6)} GHz (an end capacitor can only lower it); try the optimiser`);
  }

  // normalised capacitances
  const Cg = Array.from({ length: n }, (_, i) => (Ya - (Ym[i - 1] || 0) - (Ym[i] || 0)) * eta);
  const Cm = Ym.map(y => y * eta);
  Cg.forEach((c, i) => { if (c <= 0) warnings.push(`line ${i + 1}: ground capacitance C/ε = ${c.toFixed(3)} ≤ 0 — couplings too strong for this bandwidth (Ym/Ya does not depend on Zr); reduce the bandwidth${structure === 'comb' ? ' or θ0' : ''}`); });

  const res = {
    spec: s, g, k, Qe, QeOut, Ya, b, theta0, Cl, Cl1, closed, Ym, thetaT, Cg, Cm, achieved, tapReport, warnings,
  };
  res.netlist = toNetlist(res);
  return res;
}

// ---------------- netlist generation ----------------
// Line layout (1-based i): comb → shorted at A, open (capacitor) at B.
// interdigital → odd lines shorted at A, even lines shorted at B.
export function geometry(structure, n, theta0, thetaT, { load = true, tapsOn = [1, n], portsOn = [1, n], groundOthers = false } = {}) {
  const deg = (r) => +(r * 180 / Math.PI).toFixed(9);
  const shortAtA = (i) => structure === 'comb' || i % 2 === 1;
  // tap plane position (from A) for a given line
  const tapPos = (i) => shortAtA(i) ? thetaT : theta0 - thetaT;
  const planes = [...new Set([0, theta0, ...tapsOn.map(tapPos)].map(x => +x.toFixed(12)))].sort((a, b) => a - b);
  const nodeAt = (i, pi) => {
    const z = planes[pi];
    const isShort = shortAtA(i) ? z === 0 : Math.abs(z - theta0) < 1e-12;
    if (isShort) return '0';
    const isOpen = shortAtA(i) ? Math.abs(z - theta0) < 1e-12 : z === 0;
    if (isOpen) return groundOthers && !portsOn.includes(i) && !(load && i === 1) ? '0' : `r${i}`;
    if (tapsOn.includes(i) && Math.abs(z - tapPos(i)) < 1e-12) return `t${i}`;
    return `x${i}_${pi}`;
  };
  const secs = [];
  for (let p = 0; p < planes.length - 1; p++) {
    secs.push({ len: planes[p + 1] - planes[p], A: Array.from({ length: n }, (_, i) => nodeAt(i + 1, p)), B: Array.from({ length: n }, (_, i) => nodeAt(i + 1, p + 1)) });
  }
  return { secs, deg, planes };
}

function fmt(x, d = 6) { return +x.toPrecision(d); }

export function toNetlist(r) {
  const s = r.spec, n = s.n, T = s.target ?? s;
  const { structure } = s;
  const { f0, fbw } = T;          // target values (labels, sweep, ideal curve, goals)
  const q = T.f0 / s.f0;          // degrees at design f0 → degrees at the target f0 (.ref)
  const sym = (i) => Math.min(i, n + 1 - i); // symmetric index for lines
  const symM = (i) => Math.min(i, n - i);    // for couplings i..i+1
  const [fa, fb] = rippleEdges(f0, fbw);
  const span = Math.max(4 * fbw, 0.2);
  const fstart = f0 * Math.max(0.05, 1 - span), fstop = f0 * (1 + span) * (structure === 'comb' ? 1 : 1);
  const L = [];
  const name = structure === 'comb' ? 'Comb-line' : 'Interdigital';
  L.push(`.title ${name} ${s.type} n=${n}${s.type === 'chebyshev' ? ` ${s.ripple}dB` : ''}, f0 = ${fmt(f0 / 1e9, 6)} GHz, FBW = ${fmt(fbw * 100, 4)} % (synthesised)`);
  L.push(`# g = ${r.g.map(x => fmt(x, 5)).join(', ')}`);
  L.push(`# k = ${r.k.map(x => fmt(x, 5)).join(', ')};  Qe = ${fmt(r.Qe, 5)}`);
  L.push(`# resonator lines: Zr = ${s.Zr} ohm (neighbours grounded), theta0 = ${fmt(r.theta0 * 180 / Math.PI * q, 5)} deg at f0, er = ${s.er}`);
  if (r.predistort) L.push(`# pre-distorted design values: f0 = ${fmt(r.predistort.f0 / 1e9, 7)} GHz, FBW = ${fmt(r.predistort.fbw * 100, 5)} %`);
  L.push(`# tap: closed form ${fmt(r.closed.thetaT * 180 / Math.PI * q, 5)} deg${s.refine ? `, refined ${fmt(r.thetaT * 180 / Math.PI * q, 5)} deg` : ''} from the shorted end`);
  if (s.refine && r.tapReport) L.push(`# resonator 1 (tap-loaded, others grounded): f = ${fmt(r.tapReport.fres / 1e9, 6)} GHz, Qe = ${fmt(r.tapReport.Qe, 5)}`);
  r.warnings.forEach(w => L.push(`# WARNING: ${w}`));
  L.push(`.freq ${fmt(fstart / 1e9, 6)}G ${fmt(fstop / 1e9, 6)}G 801`);
  L.push(`.ref ${fmt(f0 / 1e9, 9)}G`);
  const ttd = r.thetaT * 180 / Math.PI * q, th0d = r.theta0 * 180 / Math.PI * q;
  L.push(`.param th0 = ${fmt(th0d, 9)}`);
  L.push(`.param tt = ${fmt(ttd, 6)} tune ${fmt(ttd * 0.6, 4)} ${fmt(Math.min(ttd * 1.4, th0d * 0.98), 4)}`);
  const half = Math.ceil(n / 2), halfM = Math.ceil((n - 1) / 2);
  for (let i = 1; i <= half; i++) L.push(`.param cg${i} = ${fmt(r.Cg[i - 1])} tune ${fmt(Math.max(r.Cg[i - 1] * 0.7, 1e-3), 4)} ${fmt(r.Cg[i - 1] * 1.3 + 0.05, 4)}`);
  for (let i = 1; i <= halfM; i++) L.push(`.param cm${i}${i + 1} = ${fmt(r.Cm[i - 1])} tune ${fmt(r.Cm[i - 1] * 0.7, 4)} ${fmt(r.Cm[i - 1] * 1.3, 4)}`);
  const endCap = r.Cl1 > 0;
  if (structure === 'comb') {
    L.push(`.param cl1 = ${fmtF(r.Cl1)} tune ${fmtF(r.Cl1 * 0.8)} ${fmtF(r.Cl1 * 1.2)}`);
    L.push(`.param cl = ${fmtF(r.Cl)} tune ${fmtF(r.Cl * 0.9)} ${fmtF(r.Cl * 1.1)}`);
  } else if (endCap) {
    L.push(`.param cl1 = ${fmtF(r.Cl1)} tune ${fmtF(r.Cl1 * 0.3)} ${fmtF(r.Cl1 * 2)}   # end-resonator trim (tap-loading compensation)`);
  }
  L.push('');
  L.push(`port t1 ${s.R0}`);
  L.push(`port t${n} ${s.R0}`);
  L.push('');
  const { secs } = geometry(structure, n, r.theta0, r.thetaT);
  const cg = Array.from({ length: n }, (_, i) => `cg${sym(i + 1)}`).join(' ');
  const cm = Array.from({ length: n - 1 }, (_, i) => `cm${symM(i + 1)}${symM(i + 1) + 1}`).join(' ');
  const lenExpr = (sec, p) => {
    // express each section length in terms of th0 and tt
    const t = r.thetaT, th = r.theta0, x = sec.len;
    const cands = [['tt*1deg', t], ['(th0-tt)*1deg', th - t], ['(th0-2*tt)*1deg', th - 2 * t], ['(2*tt-th0)*1deg', 2 * t - th], ['th0*1deg', th]];
    const c = cands.find(([, val]) => Math.abs(val - x) < 1e-9);
    return c ? c[0] : `${fmt(x * 180 / Math.PI * q, 9)}deg`;
  };
  secs.forEach((sec, p) => {
    L.push(`cline S${p + 1}`);
    L.push(`  er ${s.er}`);
    L.push(`  len ${lenExpr(sec, p)}`);
    L.push(`  Cg ${cg}`);
    if (n > 1) L.push(`  Cm ${cm}`);
    const end = (x) => (structure === 'interdigital' && x.startsWith('r') && !(endCap && (x === 'r1' || x === `r${n}`))) ? '-' : x;
    L.push(`  A ${sec.A.map(end).join(' ')}`);
    L.push(`  B ${sec.B.map(end).join(' ')}`);
    L.push('end');
  });
  if (structure === 'comb') {
    for (let i = 1; i <= n; i++) L.push(`C${i} r${i} 0 ${i === 1 || i === n ? 'cl1' : 'cl'}`);
  } else if (endCap) {
    L.push(`C1 r1 0 cl1`, `C${n} r${n} 0 cl1`);
  }
  L.push('');
  const ideal = s.type === 'chebyshev' ? `cheby(${n},${s.ripple},${fmt(f0, 9)},${fmt(fbw, 9)})` : `butter(${n},${fmt(f0, 9)},${fmt(fbw, 9)})`;
  if (s.type === 'chebyshev') L.push(`.goal db(S11) < ${fmt(-returnLossDb(s.ripple), 4)} ${fmt(fa + 0.02 * (fb - fa), 8)} ${fmt(fb - 0.02 * (fb - fa), 8)}`);
  if (r.skirt) {
    L.push(`.goal db(S21) < ${fmt(r.skirt.al + 0.5, 4)} ${fmt(fstart, 8)} ${fmt(r.skirt.fl, 8)}   # hold the synthesised skirt (ideal -20 dB point)`);
    L.push(`.goal db(S21) < ${fmt(r.skirt.ah + 0.5, 4)} ${fmt(r.skirt.fh, 8)} ${fmt(fstop, 8)}`);
  }
  L.push(`.plot ylim=-70,0 db(S11) db(S21) db(${ideal})`);
  L.push(`.plot gd(S21)`);
  L.push(`.smith S11`);
  return L.join('\n') + '\n';
}
function fmtF(x) { return fmt(x * 1e12, 6) + 'p'; }

// ---------------- tap refinement (full multiconductor model) ----------------
function singleResonatorNetlist(p, thetaT, Cl1, f1, f2, npts) {
  const { structure, n, er, R0 } = p;
  const { secs } = geometry(structure, n, p.theta0, thetaT, { tapsOn: [1], portsOn: [1], groundOthers: true });
  const Cg = Array.from({ length: n }, (_, i) => (p.Ya - (p.Ym[i - 1] || 0) - (p.Ym[i] || 0)) * p.eta);
  const Cm = p.Ym.map(y => y * p.eta);
  const end = (x) => (x === 'r1' && !(Cl1 > 0)) ? '-' : x;
  const L = [`.freq ${f1} ${f2} ${npts}`, `port t1 ${R0}`];
  secs.forEach((sec, i) => {
    L.push(`cline S${i}`, `  er ${er}`, `  len ${sec.len / (2 * Math.PI) * p.v / p.f0}`, `  Cg ${Cg.join(' ')}`);
    if (n > 1) L.push(`  Cm ${Cm.join(' ')}`);
    L.push(`  A ${sec.A.map(end).join(' ')}`, `  B ${sec.B.map(end).join(' ')}`, 'end');
  });
  if (Cl1 > 0) L.push(`C1 r1 0 ${Cl1}`);
  return L.join('\n');
}

function measureQe(p, thetaT, Cl1) {
  // two passes: coarse locate, then fine around the group-delay peak
  let fc = p.f0, span = Math.min(6 * p.f0 / Math.max(p.Qe, 1), 0.4 * p.f0);
  let best = null;
  for (let pass = 0; pass < 3; pass++) {
    const f1 = Math.max(fc - span, p.f0 * 0.05), f2 = fc + span;
    const d = parseNetlist(singleResonatorNetlist(p, thetaT, Cl1, f1, f2, 401));
    const r = solve(d), s = r.S(1, 1), F = r.freq;
    const ph = Array.from(F, (_, k) => Math.atan2(s.im[k], s.re[k]));
    for (let k = 1; k < ph.length; k++) { while (ph[k] - ph[k - 1] > Math.PI) ph[k] -= 2 * Math.PI; while (ph[k] - ph[k - 1] < -Math.PI) ph[k] += 2 * Math.PI; }
    let km = 1, tm = -Infinity;
    for (let k = 1; k < F.length - 1; k++) { const t = -(ph[k + 1] - ph[k - 1]) / (2 * Math.PI * (F[k + 1] - F[k - 1])); if (t > tm) { tm = t; km = k; } }
    // parabolic peak refinement
    const tau = (k) => -(ph[k + 1] - ph[k - 1]) / (2 * Math.PI * (F[k + 1] - F[k - 1]));
    let fr = F[km], tr = tm;
    if (km > 1 && km < F.length - 2) {
      const y0 = tau(km - 1), y1 = tau(km), y2 = tau(km + 1), den = y0 - 2 * y1 + y2;
      if (den < 0) { const dx = 0.5 * (y0 - y2) / den; fr = F[km] + dx * (F[1] - F[0]); tr = y1 - 0.25 * (y0 - y2) * dx; }
    }
    best = { fres: fr, tau: tr, Qe: 2 * Math.PI * fr * tr / 4 };
    fc = fr; span = Math.max(span / 8, 3 * fr / Math.max(best.Qe, 1) / 4);
  }
  return best;
}

function refineTap(p) {
  const b = resonatorModel(p.structure, p.Ya, p.theta0).b;
  const w0 = 2 * Math.PI * p.f0;
  let thetaT = Math.asin(Math.sin(p.theta0) * Math.sqrt(b * p.R0 / p.Qe));
  let Cl1 = p.Cl, m;
  for (let it = 0; it < 15; it++) {
    m = measureQe(p, thetaT, Cl1);
    const dq = m.Qe / p.Qe;
    // Qe ∝ 1/sin²θt to first order
    thetaT = Math.min(Math.asin(Math.min(0.999, Math.sin(thetaT) * Math.sqrt(dq))), p.theta0 * 0.98);
    // Newton step on the end capacitor: dB/dω = 2b/ω0  ⇒  ΔC = (ω_r − ω0)·2b/ω0²
    // (interdigital: a capacitor can only pull the end resonators down, so Cl1 is clamped at 0)
    Cl1 = Math.max(0, Cl1 + (2 * Math.PI * m.fres - w0) * 2 * b / (w0 * w0));
    if (Math.abs(dq - 1) < 1e-5 && Math.abs(m.fres / p.f0 - 1) < 1e-7) break;
  }
  m = measureQe(p, thetaT, Cl1);
  return { thetaT, Cl1, fres: m.fres, Qe: m.Qe };
}

// ---------------- assessment of a synthesised design ----------------
// Solves the generated netlist and reports the realised centre (geometric mean of the −3 dB points),
// the −3 dB fractional bandwidth against the ideal prototype, and the worst return loss over the
// central 80 % of the ripple band.
export function assess(r, npts = 2001) {
  const s = { ...r.spec, ...(r.spec.target ?? {}) };
  const [fa, fb] = rippleEdges(s.f0, s.fbw);
  const lo = s.f0 * Math.max(0.05, 1 - 3 * s.fbw), hi = s.f0 * (1 + 3 * s.fbw);
  const d = parseNetlist(r.netlist.replace(/^\.freq .*$/m, `.freq ${lo} ${hi} ${npts}`));
  const res = solve(d);
  const S21 = res.S(2, 1), S11 = res.S(1, 1), F = res.freq;
  const m21 = Array.from(F, (_, k) => Math.hypot(S21.re[k], S21.im[k]));
  const edges = (mag, level) => {
    let k0 = -1, k1 = -1;
    for (let k = 0; k < F.length; k++) if (mag(k) >= level) { if (k0 < 0) k0 = k; k1 = k; }
    if (k0 <= 0 || k1 >= F.length - 1) return null;
    const interp = (a, b) => F[a] + (level - mag(a)) / (mag(b) - mag(a)) * (F[b] - F[a]);
    return [interp(k0 - 1, k0), interp(k1, k1 + 1)];
  };
  const e = edges(k => m21[k], Math.SQRT1_2);
  const ie = edges(k => idealS21(s.type, s.n, s.ripple, s.f0, s.fbw, F[k]), Math.SQRT1_2);
  let rl = Infinity;
  const c0 = fa + 0.1 * (fb - fa), c1 = fb - 0.1 * (fb - fa);
  for (let k = 0; k < F.length; k++) if (F[k] >= c0 && F[k] <= c1) rl = Math.min(rl, -20 * Math.log10(Math.hypot(S11.re[k], S11.im[k])));
  return {
    fc: e ? Math.sqrt(e[0] * e[1]) : NaN, bw3: e ? (e[1] - e[0]) / Math.sqrt(e[0] * e[1]) : NaN,
    bw3ideal: ie ? (ie[1] - ie[0]) / Math.sqrt(ie[0] * ie[1]) : NaN, rlCore: rl, rlTarget: s.type === 'chebyshev' ? returnLossDb(s.ripple) : NaN,
  };
}
