// Microstrip discontinuity models (issue #5). SI units (metres, henries).
//
//   openEnd({W, h, er, t})   open-end length extension Δl (Kirschning, Jansen & Koster 1981),
//                            with Hammerstad's simpler formula alongside as a cross-check
//   viaL({d, h})             inductance of one plated via through the substrate (Goldfarb & Pucel 1991)
//
// Not here yet: the T-junction model, needed only by tapped comb-line / interdigital layouts (#15).
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
