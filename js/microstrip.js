// Closed-form microstrip models (issue #3).
//
// Single line:   Hammerstad & Jensen (1980) quasi-static Z0 and εeff, with their strip-thickness
//                correction; Kirschning & Jansen (1982) dispersion of εeff and Z0.
// Coupled pair:  Kirschning & Jansen (1984) quasi-static even/odd Z and εeff, and dispersion of
//                even/odd εeff; strip thickness via Jansen's even/odd effective widths with the
//                Hammerstad–Bekkadal ΔW. Even/odd *impedance* dispersion is NOT included (see notes).
// Losses:        conductor loss by Wheeler's incremental-inductance rule applied to the same
//                closed-form models (works for single lines and for each coupled mode), with the
//                Hammerstad roughness factor; dielectric loss from the filling factor.
//
// Units: SI throughout (metres, hertz, ohms). Equations follow the published papers; constants were
// cross-checked against the Qucs technical documentation (qucs.github.io/tech, §11) and, for single
// lines, numerically against scikit-rf's MLine (see tests/microstrip.mjs).

export const ETA0 = 376.730313668;
export const C0 = 299792458;
const MU0 = 4e-7 * Math.PI;
const E = Math.E;

// ---------------- Hammerstad & Jensen building blocks ----------------
function hjA(u) {
  return 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
}
function hjB(er) { return 0.564 * ((er - 0.9) / (er + 3)) ** 0.053; }
function hjEps(u, er) { return (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-hjA(u) * hjB(er)); }
// impedance of the air-filled line, normalised width u (zero thickness)
function hjZair(u) {
  const fu = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528));
  return ETA0 / (2 * Math.PI) * Math.log(fu / u + Math.sqrt(1 + (2 / u) ** 2));
}
const coth = (x) => 1 / Math.tanh(x);
const sech = (x) => 1 / Math.cosh(x);

// Quasi-static single line with strip thickness (Hammerstad & Jensen).
function mslineStatic(W, h, t, er) {
  const u = W / h, tn = t / h;
  let du1 = 0;
  if (tn > 0) du1 = tn / Math.PI * Math.log(1 + 4 * E / (tn * coth(Math.sqrt(6.517 * u)) ** 2));
  const dur = du1 * (1 + sech(Math.sqrt(er - 1))) / 2;
  const u1 = u + du1, ur = u + dur;
  const zr = hjZair(ur), z1 = hjZair(u1);
  const er_r = hjEps(ur, er);
  return { Z0: zr / Math.sqrt(er_r), epsEff: er_r * (z1 / zr) ** 2, Weff: ur * h };
}

// Kirschning & Jansen dispersion of εeff (single line; also used per mode).
function kjEps(u, fn, er, eps0) {
  const P1 = 0.27488 + (0.6315 + 0.525 / (1 + 0.0157 * fn) ** 20) * u - 0.065683 * Math.exp(-8.7513 * u);
  const P2 = 0.33622 * (1 - Math.exp(-0.03442 * er));
  const P3 = 0.0363 * Math.exp(-4.6 * u) * (1 - Math.exp(-((fn / 38.7) ** 4.97)));
  const P4 = 1 + 2.751 * (1 - Math.exp(-((er / 15.916) ** 8)));
  const P = P1 * P2 * ((0.1844 + P3 * P4) * fn) ** 1.5763;
  return er - (er - eps0) / (1 + P);
}

// Kirschning & Jansen dispersion of Z0 (single line).
function kjZ(u, fn, er, eps0, epsf, Z0) {
  const R1 = 0.03891 * er ** 1.4;
  const R2 = 0.267 * u ** 7;
  const R3 = 4.766 * Math.exp(-3.228 * u ** 0.641);
  const R4 = 0.016 + (0.0514 * er) ** 4.524;
  const R5 = (fn / 28.843) ** 12;
  const R6 = 22.2 * u ** 1.92;
  const R7 = 1.206 - 0.3144 * Math.exp(-R1) * (1 - Math.exp(-R2));
  const R8 = 1 + 1.275 * (1 - Math.exp(-0.004625 * R3 * er ** 1.674 * (fn / 18.365) ** 2.745));
  const R9 = 5.086 * R4 * R5 / (0.3838 + 0.386 * R4) * Math.exp(-R6) / (1 + 1.2992 * R5) * (er - 1) ** 6 / (1 + 10 * (er - 1) ** 6);
  const R10 = 0.00044 * er ** 2.136 + 0.0184;
  const R11 = (fn / 19.47) ** 6 / (1 + 0.0962 * (fn / 19.47) ** 6);
  const R12 = 1 / (1 + 0.00245 * u * u);
  const R13 = 0.9408 * epsf ** R8 - 0.9603;
  const R14 = (0.9408 - R9) * eps0 ** R8 - 0.9603;
  const R15 = 0.707 * R10 * (fn / 12.3) ** 1.097;
  const R16 = 1 + 0.0503 * er * er * R11 * (1 - Math.exp(-((u / 15) ** 6)));
  const R17 = R7 * (1 - 1.1241 * R12 / R16 * Math.exp(-0.026 * fn ** 1.15656 - R15));
  return Z0 * (R13 / R14) ** R17;
}

const fnOf = (f, h) => f * h * 1e-6;        // (f/GHz)·(h/mm)

// ---------------- public: single line ----------------
// msline({W, h, t=0, er, f=0}) → { Z0, epsEff, Z0_static, epsEff_static, Weff, warnings }
export function msline({ W, h, t = 0, er, f = 0 }) {
  check({ W, h, t, er });
  const s = mslineStatic(W, h, t, er);
  // dispersion uses the thickness-corrected width (as scikit-rf does; identical for t = 0)
  const u = s.Weff / h, fn = fnOf(f, h);
  const warnings = [];
  if (W / h < 0.01 || W / h > 100) warnings.push(`W/h = ${(W / h).toPrecision(3)} outside the Hammerstad–Jensen range 0.01–100`);
  if (er > 128) warnings.push('εr above 128 is outside the Hammerstad–Jensen range');
  let Z0 = s.Z0, eps = s.epsEff;
  if (f > 0) {
    if (u < 0.1 || u > 100 || er > 20 || fn > 60) warnings.push('outside the Kirschning–Jansen dispersion range (0.1 ≤ W/h ≤ 100, εr ≤ 20, f·h ≤ 60 GHz·mm)');
    eps = kjEps(u, fn, er, s.epsEff);
    Z0 = kjZ(u, fn, er, s.epsEff, eps, s.Z0);
  }
  return { Z0, epsEff: eps, Z0_static: s.Z0, epsEff_static: s.epsEff, Weff: s.Weff, warnings };
}

// ---------------- public: coupled pair ----------------
function hammerstadBekkadalDW(W, h, t) {
  if (!(t > 0)) return 0;
  if (W / h >= 1 / (2 * Math.PI)) return t / Math.PI * (1 + Math.log(2 * h / t));
  return t / Math.PI * (1 + Math.log(4 * Math.PI * W / t));
}

// Kirschning–Jansen quasi-static even (mode='e') or odd ('o') values for normalised width u (zero thickness).
function kjCoupledStatic(u, g, er, mode) {
  const eps0 = hjEps(u, er);                       // single line of width u
  const ZL0 = hjZair(u) / Math.sqrt(eps0);
  const Q1 = 0.8695 * u ** 0.194;
  const Q2 = 1 + 0.7519 * g + 0.189 * g ** 2.31;
  const Q3 = 0.1975 + (16.6 + (8.4 / g) ** 6) ** -0.387 + Math.log(g ** 10 / (1 + (g / 3.4) ** 10)) / 241;
  const Q4 = 2 * Q1 / Q2 / (Math.exp(-g) * u ** Q3 + (2 - Math.exp(-g)) * u ** -Q3);
  if (mode === 'e') {
    const v = u * (20 + g * g) / (10 + g * g) + g * Math.exp(-g);
    const epse = hjEps(v, er);
    const Ze = Math.sqrt(eps0 / epse) * ZL0 / (1 - ZL0 * Math.sqrt(eps0) * Q4 / ETA0);
    return { Z: Ze, eps: epse };
  }
  const ao = 0.7287 * (eps0 - (er + 1) / 2) * (1 - Math.exp(-0.179 * u));
  const bo = 0.747 * er / (0.15 + er);
  const co = bo - (bo - 0.207) * Math.exp(-0.414 * u);
  const dO = 0.593 + 0.694 * Math.exp(-0.562 * u);
  const epso = ((er + 1) / 2 + ao - eps0) * Math.exp(-co * g ** dO) + eps0;
  const Q5 = 1.794 + 1.14 * Math.log(1 + 0.638 / (g + 0.517 * g ** 2.43));
  const Q6 = 0.2305 + Math.log(g ** 10 / (1 + (g / 5.8) ** 10)) / 281.3 + Math.log(1 + 0.598 * g ** 1.154) / 5.1;
  const Q7 = (10 + 190 * g * g) / (1 + 82.3 * g ** 3);
  const Q8 = Math.exp(-6.5 - 0.95 * Math.log(g) - (g / 0.15) ** 5);
  const Q9 = Math.log(Q7) * (Q8 + 1 / 16.5);
  const Q10 = Q4 - Q5 / Q2 * u ** (Q6 * u ** -Q9);
  const Zo = Math.sqrt(eps0 / epso) * ZL0 / (1 - ZL0 * Math.sqrt(eps0) * Q10 / ETA0);
  return { Z: Zo, eps: epso };
}

// Kirschning–Jansen dispersion of even/odd εeff.
function kjCoupledEps(u, g, fn, er, eps0, mode) {
  const P1 = 0.27488 + (0.6315 + 0.525 / (1 + 0.0157 * fn) ** 20) * u - 0.065683 * Math.exp(-8.7513 * u);
  const P2 = 0.33622 * (1 - Math.exp(-0.03442 * er));
  const P3 = 0.0363 * Math.exp(-4.6 * u) * (1 - Math.exp(-((fn / 38.7) ** 4.97)));
  const P4 = 1 + 2.751 * (1 - Math.exp(-((er / 15.916) ** 8)));
  let F;
  if (mode === 'e') {
    const P5 = 0.334 * Math.exp(-3.3 * (er / 15) ** 3) + 0.746;
    const P6 = P5 * Math.exp(-((fn / 18) ** 0.368));
    const P7 = 1 + 4.069 * P6 * g ** 0.479 * Math.exp(-1.347 * g ** 0.595 - 0.17 * g ** 2.5);
    F = P1 * P2 * ((P3 * P4 + 0.1844 * P7) * fn) ** 1.5763;
  } else {
    const P8 = 0.7168 * (1 + 1.076 / (1 + 0.0576 * (er - 1)));
    const P9 = P8 - 0.7913 * (1 - Math.exp(-((fn / 20) ** 1.424))) * Math.atan(2.481 * (er / 8) ** 0.946);
    const P10 = 0.242 * (er - 1) ** 0.55;
    const P11 = 0.6366 * (Math.exp(-0.3401 * fn) - 1) * Math.atan(1.263 * (u / 3) ** 1.629);
    const P12 = P9 + (1 - P9) / (1 + 1.183 * u ** 1.376);
    const P13 = 1.695 * P10 / (0.414 + 1.605 * P10);
    const P14 = 0.8928 + 0.1072 * (1 - Math.exp(-0.42 * (fn / 20) ** 3.215));
    const P15 = Math.abs(1 - 0.8928 * (1 + P11) * Math.exp(-P13 * g ** 1.092) * P12 / P14);
    F = P1 * P2 * ((P3 * P4 + 0.1844) * fn * P15) ** 1.5763;
  }
  return er - (er - eps0) / (1 + F);
}

// mscoupled({W, S, h, t=0, er, f=0}) → { Ze, Zo, epse, epso, *_static, We, Wo, warnings }
// Even/odd impedances are quasi-static at every frequency; εeff includes dispersion.
export function mscoupled({ W, S, h, t = 0, er, f = 0 }) {
  check({ W, h, t, er });
  if (!(S > 0)) throw new Error('gap S must be > 0');
  const u = W / h, g = S / h, fn = fnOf(f, h);
  const warnings = [];
  if (u < 0.1 || u > 10) warnings.push(`W/h = ${u.toPrecision(3)} outside the Kirschning–Jansen range 0.1–10`);
  if (g < 0.1 || g > 10) warnings.push(`S/h = ${g.toPrecision(3)} outside the Kirschning–Jansen range 0.1–10`);
  if (er < 1 || er > 18) warnings.push('εr outside the Kirschning–Jansen range 1–18');
  if (f > 0 && fn > 25) warnings.push(`f·h = ${fn.toPrecision(3)} GHz·mm above the dispersion model's 25`);
  // strip thickness: Jansen's even/odd effective widths (valid for S ≫ 2t)
  let We = W, Wo = W;
  if (t > 0) {
    if (S < 10 * 2 * t) warnings.push(`gap S < 20 t: the strip-thickness correction (valid for S ≫ 2t) is approximate here; compare with t = 0`);
    const dW = hammerstadBekkadalDW(W, h, t);
    const dt = 2 * t * h / (S * er);
    We = W + dW * (1 - 0.5 * Math.exp(-0.69 * dW / dt));
    Wo = We + dt;
  }
  const ue = We / h, uo = Wo / h;
  const e = kjCoupledStatic(ue, g, er, 'e'), o = kjCoupledStatic(uo, g, er, 'o');
  let epse = e.eps, epso = o.eps;
  if (f > 0) {
    epse = kjCoupledEps(ue, g, fn, er, e.eps, 'e');
    epso = kjCoupledEps(uo, g, fn, er, o.eps, 'o');
  }
  return { Ze: e.Z, Zo: o.Z, epse, epso, Ze_static: e.Z, Zo_static: o.Z, epse_static: e.eps, epso_static: o.eps, We, Wo, warnings };
}

// ---------------- losses ----------------
const skinDepth = (f, sigma) => 1 / Math.sqrt(Math.PI * f * MU0 * sigma);
const roughness = (rough, delta) => (rough > 0 ? 1 + 2 / Math.PI * Math.atan(1.4 * (rough / delta) ** 2) : 1);

// Dielectric attenuation (Np/m) for a quasi-TEM mode with effective permittivity eps.
export function alphaDielectric(f, er, eps, tand) {
  if (!(tand > 0) || er <= 1) return 0;
  return Math.PI * f / C0 * er * (eps - 1) / (Math.sqrt(eps) * (er - 1)) * tand;
}

// Wheeler incremental inductance: R = ω·ΔL with all conductor surfaces receded by δ/2,
// L = Z_air/c from the air-filled closed-form model. Returns α_c (Np/m).
function alphaWheeler(Zair, ZairReceded, Z, f, Kr) {
  const R = 2 * Math.PI * f * (ZairReceded - Zair) / C0;
  return Kr * R / (2 * Z);
}

// mslineLoss({W, h, t, er, tand, sigma, rough, f, model}) → { alphaC, alphaD, alpha (Np/m), dBperM, Q, Qc, Qd }
// model: 'wheeler' (default; incremental inductance, agrees with Pucel–Massé–Hartwig) or
//        'hammerstad' (Rs/(Z0·W)·Ki·Kr, the formula used by Qucs and scikit-rf). The two differ by up
//        to ~3× for narrow lines (W/h ≈ 0.1); see docs/manual.md §4.6.
export function mslineLoss({ W, h, t = 0, er, tand = 0, sigma = 5.8e7, rough = 0, f, model = 'wheeler' }) {
  const line = msline({ W, h, t, er, f });
  const d = skinDepth(f, sigma);
  const warnings = [...line.warnings];
  if (t > 0 && t < 3 * d) warnings.push(`copper thickness ${(t * 1e6).toPrecision(3)} µm is under 3 skin depths (${(3 * d * 1e6).toPrecision(3)} µm): conductor loss underestimated`);
  let alphaC;
  if (model === 'hammerstad') {
    const Rs = 1 / (sigma * d);
    const Ki = Math.exp(-1.2 * (line.Z0 / ETA0) ** 0.7);
    alphaC = t > 0 ? Rs / (line.Z0 * W) * Ki * roughness(rough, d) : 0;
  } else if (model === 'wheeler') {
    const za = mslineStatic(W, h, t, 1).Z0;
    const zr = mslineStatic(W - d, h + d, Math.max(t - d, 0), 1).Z0;
    alphaC = alphaWheeler(za, zr, line.Z0, f, roughness(rough, d));
  } else throw new Error(`unknown conductor-loss model "${model}"`);
  const alphaD = alphaDielectric(f, er, line.epsEff, tand);
  return lossPack(alphaC, alphaD, f, line.epsEff, warnings);
}

// mscoupledLoss({W, S, h, t, er, tand, sigma, rough, f}) → { even: {...}, odd: {...} }
export function mscoupledLoss({ W, S, h, t = 0, er, tand = 0, sigma = 5.8e7, rough = 0, f }) {
  const c = mscoupled({ W, S, h, t, er, f });
  const d = skinDepth(f, sigma), Kr = roughness(rough, d);
  const air = mscoupled({ W, S, h, t, er: 1 });
  const rec = mscoupled({ W: W - d, S: S + d, h: h + d, t: Math.max(t - d, 0), er: 1 });
  return {
    even: lossPack(alphaWheeler(air.Ze, rec.Ze, c.Ze, f, Kr), alphaDielectric(f, er, c.epse, tand), f, c.epse, c.warnings),
    odd: lossPack(alphaWheeler(air.Zo, rec.Zo, c.Zo, f, Kr), alphaDielectric(f, er, c.epso, tand), f, c.epso, c.warnings),
  };
}

function lossPack(alphaC, alphaD, f, eps, warnings) {
  const beta = 2 * Math.PI * f * Math.sqrt(eps) / C0;
  const alpha = alphaC + alphaD;
  return { alphaC, alphaD, alpha, dBperM: 20 * Math.log10(Math.E) * alpha, Q: beta / (2 * alpha), Qc: beta / (2 * alphaC), Qd: alphaD > 0 ? beta / (2 * alphaD) : Infinity, warnings };
}

// ---------------- synthesis ----------------
// W for a target Z0 (single line). Z0 falls monotonically with W, so bisect in log W.
export function synthMsline({ Z0, h, t = 0, er, f = 0 }) {
  let lo = Math.log(1e-3 * h), hi = Math.log(200 * h);
  const Zat = (lnW) => msline({ W: Math.exp(lnW), h, t, er, f }).Z0;
  if (!(Zat(hi) < Z0 && Zat(lo) > Z0)) throw new Error(`Z0 = ${Z0} Ω is outside the range this substrate can realise`);
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (Zat(m) > Z0) lo = m; else hi = m;
  }
  const W = Math.exp((lo + hi) / 2);
  return { W, ...msline({ W, h, t, er, f }) };
}

// (W, S) for target even/odd impedances (quasi-static). Damped Newton in (ln W, ln S) from several
// starting gaps; the closed-form model is smooth, so this converges in a few iterations.
export function synthMscoupled({ Ze, Zo, h, t = 0, er }) {
  if (!(Ze > Zo && Zo > 0)) throw new Error('need Ze > Zo > 0');
  const F = (x) => { const c = mscoupled({ W: Math.exp(x[0]), S: Math.exp(x[1]), h, t, er }); return [Math.log(c.Ze / Ze), Math.log(c.Zo / Zo)]; };
  const W0 = synthMsline({ Z0: Math.sqrt(Ze * Zo), h, t, er }).W;
  let best = null;
  for (const s0 of [0.3, 1, 3, 0.1, 10]) {
    let x = [Math.log(W0), Math.log(s0 * h)];
    let r = F(x), nr = Math.hypot(...r);
    for (let it = 0; it < 60 && nr > 1e-12; it++) {
      const J = [[0, 0], [0, 0]], dh = 1e-6;
      for (let j = 0; j < 2; j++) { const xp = x.slice(); xp[j] += dh; const rp = F(xp); J[0][j] = (rp[0] - r[0]) / dh; J[1][j] = (rp[1] - r[1]) / dh; }
      const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      if (!isFinite(det) || Math.abs(det) < 1e-14) break;
      let dx = [(-r[0] * J[1][1] + r[1] * J[0][1]) / det, (-J[0][0] * r[1] + J[1][0] * r[0]) / det];
      const step = Math.hypot(...dx); if (step > 1) dx = dx.map(v => v / step);   // damp in log space
      let lam = 1, xn, rn, nn;
      for (; lam > 1e-4; lam /= 2) { xn = [x[0] + lam * dx[0], x[1] + lam * dx[1]]; rn = F(xn); nn = Math.hypot(...rn); if (isFinite(nn) && nn < nr) break; }
      if (!(nn < nr)) break;
      x = xn; r = rn; nr = nn;
    }
    if (!best || nr < best.nr) best = { x, nr };
    if (nr < 1e-10) break;
  }
  const W = Math.exp(best.x[0]), S = Math.exp(best.x[1]);
  const c = mscoupled({ W, S, h, t, er });
  const ok = best.nr < 1e-6;
  return { W, S, converged: ok, residual: best.nr, ...c, warnings: ok ? c.warnings : [`no (W, S) found for Ze = ${Ze} Ω, Zo = ${Zo} Ω on this substrate (closest: Ze ${c.Ze.toFixed(2)}, Zo ${c.Zo.toFixed(2)} Ω)`, ...c.warnings] };
}

// Check dimensions against a substrate's fabrication limits; returns warnings.
export function fabCheck({ W, S }, sub) {
  const w = [], f = sub?.fab || {};
  if (f.minTrace != null && W < f.minTrace) w.push(`W = ${(W * 1e3).toFixed(3)} mm is below the minimum trace ${(f.minTrace * 1e3).toFixed(3)} mm`);
  if (S != null && f.minSpace != null && S < f.minSpace) w.push(`S = ${(S * 1e3).toFixed(3)} mm is below the minimum space ${(f.minSpace * 1e3).toFixed(3)} mm`);
  return w;
}

// Convenience: geometry parameters from a substrate object (js/substrates.js).
export function fromSubstrate(sub) {
  return { h: sub.dielectric.h, er: sub.dielectric.er, tand: sub.dielectric.tand, t: sub.copper.t, sigma: sub.copper.sigma, rough: sub.copper.roughness || 0 };
}

function check({ W, h, t, er }) {
  if (!(W > 0)) throw new Error('width W must be > 0');
  if (!(h > 0)) throw new Error('substrate height h must be > 0');
  if (!(t >= 0)) throw new Error('thickness t must be ≥ 0');
  if (!(er >= 1)) throw new Error('εr must be ≥ 1');
}
