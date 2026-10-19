// Comb-line loading capacitors (issue #14): SMD chip capacitors, printed (parallel-plate) pads and
// trimmers — values, parasitic models, realisability on a substrate, and footprint geometry.
// SI units unless stated (geometry in millimetres, as in js/layout.js).
//
// Sources and assumptions
//   SMD land patterns: KiCad library Capacitor_SMD:C_0402_1005Metric / C_0603_1608Metric /
//     C_0805_2012Metric (CC-BY-SA 4.0 with the KiCad library exception).
//   ESL defaults are TYPICAL values for MLCCs of each size, not from a particular datasheet: override
//     with esl= from the part you use. Q defaults likewise (C0G/NP0 RF parts are usually a few hundred
//     at 1 GHz).
//   Trimmers: Murata TZC3 series (datasheet: TZC3Z030 1.4–3.0 pF, TZC3Z060 2.0–6.0, TZC3R100 3.0–10,
//     TZC3P200 5.0–20, TZC3P300 6.5–30 pF; Q specified only at 1 MHz; frequency curves to 2 GHz for the
//     Z types, 1 GHz for R/P). Land pattern = KiCad's C_Trimmer_Murata_TZC3 (5.0 / 3.3 / 1.0 mm).
//   Not here: gap and interdigital printed capacitors (their closed forms need checking against the
//     sources before use).
import { msline } from './microstrip.js';
import { openEnd, viaL } from './discontinuities.js';

const C0 = 299792458;

// ---------------------------------------------------------------- E series
export const E_SERIES = {
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
};
/** Nearest E-series value (in log terms) to C. */
export function snapE(C, series = 'E24') {
  const base = E_SERIES[series];
  if (!base) throw new Error(`unknown series ${series} (E12, E24)`);
  if (!(C > 0)) throw new Error('capacitance must be > 0');
  const dec = Math.floor(Math.log10(C)), cands = [];
  for (const k of [dec - 1, dec, dec + 1]) for (const m of base) cands.push(m * 10 ** k);
  return cands.reduce((b, v) => (Math.abs(Math.log(v / C)) < Math.abs(Math.log(b / C)) ? v : b));
}

// ---------------------------------------------------------------- SMD chip capacitors
// pad: centre offset x (mm), size [along, across] (mm); esl: typical (H); kicad: library footprint
export const SMD_PACKAGES = {
  '0402': { pads: { x: 0.48, l: 0.56, w: 0.62 }, crt: [0.91, 0.46], esl: 0.4e-9, kicad: 'C_0402_1005Metric' },
  '0603': { pads: { x: 0.775, l: 0.9, w: 0.95 }, crt: [1.48, 0.73], esl: 0.6e-9, kicad: 'C_0603_1608Metric' },
  '0805': { pads: { x: 0.95, l: 1.0, w: 1.45 }, crt: [1.7, 0.98], esl: 0.8e-9, kicad: 'C_0805_2012Metric' },
};
export const SMD_DEFAULT_Q = 300;

// Capacitance of a pad over the ground plane: a short microstrip section W wide, L long, plus the
// open-end fringing at both ends (Δl each, Kirschning–Jansen–Koster). W, L in mm.
export function padC({ W, L, sub }) {
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t;
  const m = msline({ W: W / 1e3, h, t, er });
  const dl = openEnd({ W: W / 1e3, h, er, t }).dl;
  return (L / 1e3 + 2 * dl) * Math.sqrt(m.epsEff) / (C0 * m.Z0);
}

/**
 * SMD capacitor from a resonator node to ground: hot pad (shunt pad C) → ESL → C (with Q) → cold pad
 * → n vias (Goldfarb–Pucel) to ground. Returns the element values and the effective capacitance
 *   Ceff(f) = Cpad + C / (1 − ω² (ESL + Lvia) C)
 */
export function smdModel({ pkg = '0603', C, Q = SMD_DEFAULT_Q, esl, sub, via = { d: 0.3e-3, n: 2 }, f }) {
  const p = SMD_PACKAGES[pkg];
  if (!p) throw new Error(`unknown SMD package ${pkg} (${Object.keys(SMD_PACKAGES).join(', ')})`);
  const L = esl ?? p.esl;
  const Cp = sub ? padC({ W: p.pads.w, L: p.pads.l, sub }) : 0;
  const Lv = sub ? viaL({ d: via.d, h: sub.dielectric.h, n: via.n }).L : 0;
  const w = 2 * Math.PI * f, Ls = L + Lv;
  const den = 1 - w * w * Ls * C;
  return { pkg, C, Q, esl: L, Cpad: Cp, Lvia: Lv, Ceff: Cp + (den > 0 ? C / den : NaN), srf: 1 / (2 * Math.PI * Math.sqrt(Ls * C)) };
}

/** Nominal C (before snapping) whose effective capacitance at f is Ceff, for an SMD model. */
export function smdForCeff({ Ceff, ...o }) {
  const probe = smdModel({ ...o, C: 1e-12 });
  const x = Ceff - probe.Cpad;
  if (!(x > 0)) return { C: NaN, why: `the ${o.pkg ?? '0603'} pad alone is ${(probe.Cpad * 1e12).toFixed(3)} pF, more than the ${(Ceff * 1e12).toFixed(3)} pF needed` };
  const w = 2 * Math.PI * o.f, Ls = probe.esl + probe.Lvia;
  return { C: x / (1 + w * w * Ls * x) };                       // inverse of C/(1 − ω²LsC)
}

// ---------------------------------------------------------------- printed parallel-plate pad
// A square pad of side a to the bottom ground, fed at one edge: an open-ended microstrip stub of width a,
// length a (+ Δl). Its input capacitance tan(β(a + Δl)) / (ω Z0) is used at f.
// Validity: a ≤ λg/8 (stays capacitive and nearly lumped), W/h ≤ 100 (microstrip model range); sizes are
// also capped at a practical 25 mm side.
export function printedC({ a, sub, f }) {
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t;
  const m = msline({ W: a / 1e3, h, t, er, f });
  const dl = openEnd({ W: a / 1e3, h, er, t }).dl;
  const beta = 2 * Math.PI * f * Math.sqrt(m.epsEff) / C0;
  return Math.tan(beta * (a / 1e3 + dl)) / (2 * Math.PI * f * m.Z0);
}
export const PRINTED_MAX_SIDE = 25;   // mm: a practical limit on a loading pad, below the λg/8 and W/h limits at low f
export function printedRange({ sub, f, minSide = 0.5, maxSide = PRINTED_MAX_SIDE }) {
  const h = sub.dielectric.h * 1e3, er = sub.dielectric.er;
  const lg = C0 / f / Math.sqrt(er) * 1e3;                        // conservative (εeff < εr): mm
  const aMax = Math.min(lg / 8, 100 * h, maxSide);
  return { aMin: minSide, aMax, Cmin: printedC({ a: minSide, sub, f }), Cmax: printedC({ a: aMax, sub, f }) };
}
/** Pad side a (mm) for a target capacitance at f, or { why } when out of range. */
export function printedSize({ C, sub, f, minSide = 0.5 }) {
  const r = printedRange({ sub, f, minSide });
  if (C > r.Cmax) return { ...r, why: `${(C * 1e12).toFixed(2)} pF needs more than the largest printed pad on ${sub.id} at ${(f / 1e9).toPrecision(3)} GHz (${r.aMax.toFixed(1)} mm square, ${(r.Cmax * 1e12).toFixed(2)} pF): use SMD or a thinner substrate` };
  if (C < r.Cmin) return { ...r, a: r.aMin, why: `${(C * 1e12).toFixed(3)} pF is below a ${minSide} mm pad (${(r.Cmin * 1e12).toFixed(3)} pF)` };
  let lo = r.aMin, hi = r.aMax;
  for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (printedC({ a: mid, sub, f }) < C) lo = mid; else hi = mid; }
  return { ...r, a: Math.sqrt(lo * hi) };
}

// ---------------------------------------------------------------- trimmers (Murata TZC3)
export const TRIMMERS = [
  { mpn: 'TZC3Z030A110', Cmin: 1.4e-12, Cmax: 3.0e-12, fMax: 2e9, tc: 'NP0' },
  { mpn: 'TZC3Z060A110', Cmin: 2.0e-12, Cmax: 6.0e-12, fMax: 2e9, tc: 'NP0' },
  { mpn: 'TZC3R100A110', Cmin: 3.0e-12, Cmax: 10e-12, fMax: 1e9, tc: 'N750' },
  { mpn: 'TZC3P200A110', Cmin: 5.0e-12, Cmax: 20e-12, fMax: 1e9, tc: 'N1200' },
  { mpn: 'TZC3P300A110', Cmin: 6.5e-12, Cmax: 30e-12, fMax: 1e9, tc: 'N1200' },
];
export const TRIMMER_FOOTPRINT = { kicad: 'C_Trimmer_Murata_TZC3', pads: { x: 2.075, l: 0.85, w: 1.0 }, crt: [2.75, 1.85] };
export const TRIMMER_DEFAULTS = { esl: 1e-9, Q: 100 };      // assumptions: not published by Murata

/** Trimmer whose range covers C with 10 % adjustment margin each way, preferring the narrowest range. */
export function pickTrimmer(C, f) {
  const ok = TRIMMERS.filter(t => C >= t.Cmin * 1.1 && C <= t.Cmax * 0.9);
  if (!ok.length) return { why: `no TZC3 trimmer covers ${(C * 1e12).toFixed(2)} pF with ±10 % adjustment (series 1.4–30 pF)` };
  const t = ok.sort((a, b) => a.Cmax / a.Cmin - b.Cmax / b.Cmin)[0];
  return { ...t, warn: f > t.fMax ? `${t.mpn}: Murata publishes frequency curves only up to ${t.fMax / 1e9} GHz` : null };
}

// ---------------------------------------------------------------- comb-line re-tuning after snapping
/**
 * Common line length that best absorbs E-series snapping. For a comb resonator (neighbours grounded)
 * the needed loading is Cl ∝ cot θ, so one length change scales every Cl alike: choose cot θ' = cot θ0 ·
 * exp(mean ln(Cact/Cneed)); the per-resonator residual is reported as a frequency error using the slope
 * b = (Ya/2)(cot θ + θ csc² θ):   Δf/f ≈ −ω0 ΔC / (2 b).
 */
export function retuneLength({ theta0, Cneed, Cact, Ya, f0 }) {
  const mean = Cneed.reduce((a, c, i) => a + Math.log(Cact[i] / c), 0) / Cneed.length;
  const theta = Math.atan(1 / (Math.exp(mean) / Math.tan(theta0)));
  const w0 = 2 * Math.PI * f0;
  const b = (Ya / 2) * (1 / Math.tan(theta) + theta / Math.sin(theta) ** 2);
  const need = Cneed.map(c => c * (1 / Math.tan(theta)) / (1 / Math.tan(theta0)));
  const df = Cact.map((c, i) => -w0 * (c - need[i]) / (2 * b));
  return { theta, scale: theta / theta0, dfRel: df };
}

// ---------------------------------------------------------------- geometry (mm, local frame)
// The resonator end is at the origin, +x pointing away from the line. Returns copper polygons by role,
// via positions and a courtyard; js/kicad.js turns them into footprints, #15's layouts place them.
const rectC = (cx, cy, l, w) => [[cx - l / 2, cy - w / 2], [cx + l / 2, cy - w / 2], [cx + l / 2, cy + w / 2], [cx - l / 2, cy + w / 2]];
export function capGeometry({ type, pkg = '0603', a, via = { d: 0.3, n: 2 } }) {
  if (type === 'smd' || type === 'trimmer') {
    const fp = type === 'smd' ? SMD_PACKAGES[pkg] : TRIMMER_FOOTPRINT;
    const { x, l, w } = fp.pads;
    // hot pad starts at the line end (x = 0); the part's pads are 2x apart; beyond the cold pad a
    // ground land carries the vias
    const hx = l / 2, cx = hx + 2 * x, vp = via.d + 0.3, gap = 0.15, ov = 0.05;   // ov: copper overlap, so pads join
    const landL = via.n * vp + (via.n - 1) * gap + 0.3, landW = Math.max(w, vp + 0.3), lx0 = cx + l / 2;
    const vias = Array.from({ length: via.n }, (_, i) => ({ x: lx0 + 0.15 + vp / 2 + i * (vp + gap), y: 0, drill: via.d, pad: vp }));
    const x1 = lx0 + landL, yc = Math.max(fp.crt[1], landW / 2 + 0.25);
    return {
      hot: [[[-ov, -w / 2], [l, -w / 2], [l, w / 2], [-ov, w / 2]]],
      cold: [rectC(cx, 0, l, w), [[lx0 - ov, -landW / 2], [x1, -landW / 2], [x1, landW / 2], [lx0 - ov, landW / 2]]],
      vias, part: { x: hx + x, kicad: fp.kicad },
      crt: [[-0.25, -yc], [x1 + 0.25, -yc], [x1 + 0.25, yc], [-0.25, yc]],
    };
  }
  if (type === 'printed') {
    if (!(a > 0)) throw new Error('printed capacitor geometry needs the pad side a');
    return { hot: [rectC(a / 2, 0, a, a)], cold: [], vias: [], crt: [[-0.25, -a / 2 - 0.25], [a + 0.25, -a / 2 - 0.25], [a + 0.25, a / 2 + 0.25], [-0.25, a / 2 + 0.25]] };
  }
  throw new Error(`unknown capacitor type ${type}`);
}

// ---------------------------------------------------------------- netlist element
/**
 * Expand `cap NAME N1 [N2] C=.. [type=ideal|smd|printed|trimmer] [pkg=0402|0603|0805] [Q=..] [esl=..]
 *      [d=..] [n=..] [a=..] [series=E12|E24] [mpn=..]` into primitive netlist lines.
 *   ideal    C (with Q)
 *   smd      hot-pad C to ground, ESL, C (Q), cold pad to n vias (or to N2)
 *   printed  square pad of side a (given, or sized for C at f) to ground: open microstrip stub
 *   trimmer  Murata TZC3 chosen to cover C (or mpn=): ESL, C (Q), cold side to vias
 * series= snaps C to the E-series first (warning shows the change). Returns { lines, info, warnings }.
 */
export function expandCap({ name, nodes, o, ev, sub, f, fail }) {
  const type = (o.type ?? 'ideal').toLowerCase();
  const n1 = nodes[0], n2 = nodes[1] ?? '0';
  if (!n1) fail('cap NAME N1 [N2] C=.. [type=…]');
  const gnd = n2 === '0' || /^gnd$/i.test(n2);
  const warnings = [], lines = [];
  const known = new Set(['type', 'c', 'pkg', 'q', 'esl', 'd', 'n', 'a', 'series', 'mpn']);
  for (const k of Object.keys(o)) if (!known.has(k)) fail(`unknown cap option ${k}`);
  let C = o.c != null ? ev(o.c) : null;
  if (o.series && C != null) { const s = snapE(C, o.series.toUpperCase()); if (Math.abs(s / C - 1) > 1e-9) warnings.push(`C ${(C * 1e12).toPrecision(4)} pF snapped to ${o.series.toUpperCase()} ${(s * 1e12).toPrecision(3)} pF`); C = s; }
  const num = (x) => (+x.toPrecision(6)).toString();
  const via = { d: o.d != null ? ev(o.d) : 0.3e-3, n: Math.max(1, Math.round(o.n != null ? ev(o.n) : 2)) };
  const needSub = () => { if (!sub) fail(`cap type=${type} needs a .substrate (pads and vias depend on it)`); };
  const needF = () => { if (!(f > 0)) fail(`cap type=${type} needs .ref (or .freq) before it`); };
  const coldToGround = (node) => (gnd ? `via V${name} ${node} d=${num(via.d)} n=${via.n}` : `wire ${node} ${n2}`);
  if (type === 'ideal') {
    if (!(C > 0)) fail('cap: C= is required');
    lines.push(`C${name} ${n1} ${n2} ${num(C)}${o.q ? ` Q=${num(ev(o.q))}` : ''}`);
    return { lines, warnings, info: { type, C, Ceff: C } };
  }
  if (type === 'smd') {
    needSub(); needF();
    if (!(C > 0)) fail('cap: C= is required');
    const pkg = o.pkg ?? '0603';
    if (!SMD_PACKAGES[pkg]) fail(`unknown SMD package ${pkg} (${Object.keys(SMD_PACKAGES).join(', ')})`);
    const Q = o.q != null ? ev(o.q) : SMD_DEFAULT_Q, esl = o.esl != null ? ev(o.esl) : SMD_PACKAGES[pkg].esl;
    const m = smdModel({ pkg, C, Q, esl, sub, via, f });
    if (m.srf < 3 * f) warnings.push(`self-resonance with ESL + via ${(m.srf / 1e9).toPrecision(3)} GHz is under 3 × f (${(f / 1e9).toPrecision(3)} GHz)`);
    if (m.Cpad > 0) lines.push(`C${name}_pad ${n1} 0 ${num(m.Cpad)}`);
    lines.push(`L${name}_esl ${n1} ${name}_x ${num(esl)}`, `C${name}_c ${name}_x ${name}_y ${num(C)} Q=${num(Q)}`, coldToGround(`${name}_y`));
    return { lines, warnings, info: { type, pkg, C, Q, esl, Cpad: m.Cpad, Lvia: gnd ? m.Lvia : 0, Ceff: m.Ceff, srf: m.srf, via } };
  }
  if (type === 'printed') {
    needSub(); needF();
    if (!gnd) fail('cap type=printed is a pad to ground (no N2)');
    let a;
    if (o.a != null) a = ev(o.a) * 1e3;
    else {
      if (!(C > 0)) fail('cap type=printed needs C= or a=');
      const z = printedSize({ C, sub, f });
      if (z.why) warnings.push(z.why);
      a = z.a ?? z.aMax;
    }
    const dl = openEnd({ W: a / 1e3, h: sub.dielectric.h, er: sub.dielectric.er, t: sub.copper.t }).dl * 1e3;
    lines.push(`T${name}_pp ${n1} - W=${num(a)}mm len=${num(a + dl)}mm`);
    return { lines, warnings, info: { type, a, C: printedC({ a, sub, f }), Ceff: printedC({ a, sub, f }), range: printedRange({ sub, f }) } };
  }
  if (type === 'trimmer') {
    needSub(); needF();
    if (!(C > 0)) fail('cap: C= (the trimmer setting) is required');
    const t = o.mpn ? TRIMMERS.find(x => x.mpn.toLowerCase() === o.mpn.toLowerCase()) : pickTrimmer(C, f);
    if (!t || t.why) { warnings.push(t?.why ?? `unknown trimmer ${o.mpn}`); }
    else {
      if (C < t.Cmin || C > t.Cmax) warnings.push(`${t.mpn} adjusts ${t.Cmin * 1e12}–${t.Cmax * 1e12} pF; ${(C * 1e12).toPrecision(3)} pF is outside it`);
      if (t.warn) warnings.push(t.warn);
      if (f > t.fMax && !t.warn) warnings.push(`${t.mpn}: Murata publishes frequency curves only up to ${t.fMax / 1e9} GHz`);
    }
    const Q = o.q != null ? ev(o.q) : TRIMMER_DEFAULTS.Q, esl = o.esl != null ? ev(o.esl) : TRIMMER_DEFAULTS.esl;
    const Cp = padC({ W: TRIMMER_FOOTPRINT.pads.w, L: TRIMMER_FOOTPRINT.pads.l, sub });
    lines.push(`C${name}_pad ${n1} 0 ${num(Cp)}`, `L${name}_esl ${n1} ${name}_x ${num(esl)}`, `C${name}_c ${name}_x ${name}_y ${num(C)} Q=${num(Q)}`, coldToGround(`${name}_y`));
    const m = smdModel({ pkg: '0603', C, Q, esl, sub, via, f });
    return { lines, warnings, info: { type, mpn: t?.mpn, range: t && !t.why ? [t.Cmin, t.Cmax] : null, C, Q, esl, Cpad: Cp, Ceff: Cp + C / (1 - (2 * Math.PI * f) ** 2 * (esl + (gnd ? m.Lvia : 0)) * C), via } };
  }
  fail(`unknown cap type ${type} (ideal, smd, printed, trimmer)`);
}
