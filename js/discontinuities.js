// Microstrip discontinuity models (issue #5). SI units (metres, henries).
//
//   openEnd({W, h, er, t})   open-end length extension Δl (Kirschning, Jansen & Koster 1981),
//                            with Hammerstad's simpler formula alongside as a cross-check
//   viaL({d, h})             inductance of one plated via through the substrate (Goldfarb & Pucel 1991)
//
//   bendLC({W, h, er, mitre})  90° bend, square corner (Kirschning, Jansen & Koster) or optimally
//                            mitred (Douville & James): series L / shunt C / series L (#37)
//   stepLC({W1, W2, h, er, t, f})  step in width (Gupta; Garg & Bahl): L1 / shunt C / L2 (#37)
//   tlcY(L1, C, L2, f)       the T network as an admittance block over [A, B, mid]
// The T-junction is in js/tee.js. Bends and steps use the closed forms as Qucs implements them
// (mscorner, msmbend, msstep); none has been checked here against EM simulation yet (#16).
import { msline } from './microstrip.js';

const MU0 = 4e-7 * Math.PI;

/**
 * Open-end extension of a microstrip line: the open end behaves like a longer line by Δl.
 * M. Kirschning, R. H. Jansen, N. H. L. Koster, "Accurate model for open end effect of microstrip
 * lines", Electronics Letters 17(3), 1981. Stated accuracy ≈ 2.5 % for 0.01 ≤ W/h ≤ 100, εr ≤ 128.
 * εeff is the static effective permittivity of the line.
 * Returns { dl (m), dlH (Hammerstad, m), u, epsEff, warnings }.
 */
export function openEnd({ W, h, er, t = 0 }) {
  const u = W / h;
  const epsEff = msline({ W, h, t, er }).epsEff;
  const warnings = [];
  if (u < 0.01 || u > 100) warnings.push(`W/h = ${u.toPrecision(3)} outside the open-end model range 0.01–100`);
  if (er > 128) warnings.push('εr above 128 is outside the open-end model range');
  const e81 = epsEff ** 0.81, u8544 = u ** 0.8544;
  const x1 = 0.434907 * (e81 + 0.26) / (e81 - 0.189) * (u8544 + 0.236) / (u8544 + 0.87);
  const x2 = 1 + u ** 0.371 / (2.358 * er + 1);
  const x3 = 1 + 0.5274 * Math.atan(0.084 * u ** (1.9413 / x2)) / epsEff ** 0.9236;
  const x4 = 1 + 0.0377 * Math.atan(0.067 * u ** 1.456) * (6 - 5 * Math.exp(0.036 * (1 - er)));
  const x5 = 1 - 0.218 * Math.exp(-7.5 * u);
  const dl = h * x1 * x3 * x5 / x4;
  // E. O. Hammerstad, "Equations for microstrip circuit design", 5th EuMC, 1975
  const dlH = h * 0.412 * (epsEff + 0.3) / (epsEff - 0.258) * (u + 0.264) / (u + 0.8);
  return { dl, dlH, u, epsEff, warnings };
}

/**
 * Inductance of a cylindrical via of diameter d through a substrate of height h, to the ground plane:
 *   L = (μ0 / 2π) [ h ln((h + √(r² + h²)) / r) + 1.5 (r − √(r² + h²)) ],   r = d/2
 * M. E. Goldfarb, R. A. Pucel, "Modeling via hole grounds in microstrip", IEEE Microwave and Guided
 * Wave Letters 1(6), 1991 (agrees with their measurements within a few % for h/d ≈ 0.5–5).
 * n vias in parallel: L/n, mutual coupling neglected (optimistic when they are close together).
 */
export function viaL({ d, h, n = 1 }) {
  if (!(d > 0) || !(h > 0)) throw new Error('via: d and h must be > 0');
  const r = d / 2, s = Math.hypot(r, h);
  const L1 = MU0 / (2 * Math.PI) * (h * Math.log((h + s) / r) + 1.5 * (r - s));
  const warnings = [];
  if (h / d < 0.3 || h / d > 10) warnings.push(`via h/d = ${(h / d).toPrecision(3)}: outside the range where the Goldfarb–Pucel formula was checked`);
  return { L: L1 / n, L1, n, warnings };
}

/**
 * 90° microstrip bend of width W, reference planes at the edges of the crossing strip.
 * mitre 'none': M. Kirschning, R. H. Jansen, N. H. L. Koster, "Measurement and computer-aided modeling
 *   of microstrip discontinuities by an improved resonator method", IEEE MTT-S 1983:
 *   C/W = (10.35 εr + 2.5) W/h + (2.6 εr + 5.64) pF/m,  L/h = 220 [1 − 1.35 exp(−0.18 (W/h)^1.39)] nH/m;
 *   range 0.2 ≤ W/h ≤ 6, 2.36 ≤ εr ≤ 10.4.
 * mitre 'opt': R. J. P. Douville, D. S. James, "Experimental study of symmetric microstrip bends and their
 *   compensation", IEEE Trans. MTT 26(3), 1978, at the optimum mitre:
 *   C/W = (3.93 εr + 0.62) W/h + (7.6 εr + 3.80) pF/m,  L/h = 440 [1 − 1.062 exp(−0.177 (W/h)^0.947)] nH/m;
 *   optimum mitre M = 52 + 65 exp(−1.35 W/h) % of the corner diagonal W√2; range 0.2 ≤ W/h ≤ 6, 2.5 ≤ εr ≤ 25.
 * Equivalent circuit: L/2 – C – L/2 (the L above is the total series inductance).
 * Returns { L1, C, L2, mitre (fraction of the diagonal, 0 for none), warnings }.
 */
export function bendLC({ W, h, er, mitre = 'none' }) {
  const u = W / h, warnings = [];
  let C, L, M = 0;
  if (mitre === 'none') {
    C = W * ((10.35 * er + 2.5) * u + (2.6 * er + 5.64)) * 1e-12;
    L = 220e-9 * h * (1 - 1.35 * Math.exp(-0.18 * u ** 1.39));
    if (u < 0.2 || u > 6) warnings.push(`bend W/h = ${u.toPrecision(3)} outside the model range 0.2–6`);
    if (er < 2.36 || er > 10.4) warnings.push(`bend εr = ${er} outside the model range 2.36–10.4`);
  } else if (mitre === 'opt') {
    C = W * ((3.93 * er + 0.62) * u + (7.6 * er + 3.80)) * 1e-12;
    L = 440e-9 * h * (1 - 1.062 * Math.exp(-0.177 * u ** 0.947));
    M = (52 + 65 * Math.exp(-1.35 * u)) / 100;
    if (u < 0.2 || u > 6) warnings.push(`mitred bend W/h = ${u.toPrecision(3)} outside the model range 0.2–6`);
    if (er < 2.5 || er > 25) warnings.push(`mitred bend εr = ${er} outside the model range 2.5–25`);
  } else throw new Error(`bend: mitre=${mitre} (use none or opt)`);
  if (!(L > 0)) { warnings.push('bend inductance not positive at this W/h; set to zero'); L = 0; }
  return { L1: L / 2, C, L2: L / 2, mitre: M, warnings };
}

/**
 * Step in width from W1 (node A) to W2 (node B), reference plane at the step. K. C. Gupta, R. Garg,
 * R. Chadha, "Computer-Aided Design of Microwave Circuits", 1981; Garg & Bahl (as in Qucs msstep), with
 * Wa ≥ Wb the wider and narrower widths:
 *   C = √(Wa Wb) [(10.1 log10 εr + 2.33) Wa/Wb − 12.6 log10 εr − 3.17] pF/m   (εr ≤ 10, 1.5 ≤ Wa/Wb ≤ 3.5)
 *   L = h [40.5 (Wa/Wb − 1) − 75 log10(Wa/Wb) + 0.2 (Wa/Wb − 1)²] nH/m          (1 ≤ Wa/Wb ≤ 5)
 *   split L1 : L2 = Z1 √εeff1 : Z2 √εeff2 (each side's share)
 * C is clamped at 0 where the fit goes negative (near Wa/Wb = 1). Returns { L1, C, L2, warnings }.
 */
export function stepLC({ W1, W2, h, er, t = 0, f = 0 }) {
  if (!(W1 > 0 && W2 > 0)) throw new Error('step: W1 and W2 must be > 0');
  if (Math.abs(W1 / W2 - 1) < 1e-9) throw new Error('step: W1 = W2 is not a step');
  const Wa = Math.max(W1, W2), Wb = Math.min(W1, W2), r = Wa / Wb, lg = Math.log10(er), warnings = [];
  let C = Math.sqrt(Wa * Wb) * ((10.1 * lg + 2.33) * r - 12.6 * lg - 3.17) * 1e-12;
  const L = h * (40.5 * (r - 1) - 75 * Math.log10(r) + 0.2 * (r - 1) ** 2) * 1e-9;
  if (C < 0) C = 0;
  if (er > 10) warnings.push(`step εr = ${er} above the model range (≤ 10)`);
  if (r < 1.5 || r > 3.5) warnings.push(`step width ratio ${r.toPrecision(3)} outside the capacitance fit range 1.5–3.5`);
  if (r > 5) warnings.push(`step width ratio ${r.toPrecision(3)} outside the inductance fit range 1–5`);
  const l1 = msline({ W: W1, h, er, t, f }), l2 = msline({ W: W2, h, er, t, f });
  const a = l1.Z0 * Math.sqrt(l1.epsEff), b = l2.Z0 * Math.sqrt(l2.epsEff);
  return { L1: Math.max(L, 0) * a / (a + b), C, L2: Math.max(L, 0) * b / (a + b), warnings };
}

/**
 * T network L1 (A–mid), C (mid–ground), L2 (mid–B) as an admittance block over [A, B, mid], in the form
 * the solver stamps (row-major, imaginary parts; lossless). A zero inductance is replaced by 1 fH.
 */
export function tlcY(L1, C, L2, f) {
  const w = 2 * Math.PI * f, n = 3, im = new Float64Array(9), re = new Float64Array(9);
  const arm = (i, L) => { const y = -1 / (w * Math.max(L, 1e-15)); im[i * n + i] += y; im[2 * n + 2] += y; im[i * n + 2] -= y; im[2 * n + i] -= y; };
  arm(0, L1); arm(1, L2); im[2 * n + 2] += w * C;
  return { re, im, n };
}
