// Microstrip T-junction (issue #15): Hammerstad's model as implemented in Qucsator (mstee.cpp,
// "Microstrip tee junction", Qucs technical documentation §11.x).
//
//   main arms a and b (widths Wa, Wb), side arm 2 (width W2); reference planes at the edges of the
//   crossing strip: the main-arm planes W2/2 either side of the side arm's centre line, the side-arm
//   plane at max(Wa, Wb)/2 from the main line's centre line (i.e. at its edge).
//
//   D_x  = Z_F0 / Z_x · h / √εeff_x          equivalent parallel-plate widths
//   fp_x = 0.4e6 · Z_x / h                    (h in metres) first higher-order mode
//   d_x  = 0.055 D2 (Z_x/Z2) [1 − 2 (Z_x/Z2)(f/fp_x)²]           main-arm plane shift, x = a, b
//   L_x  = W2/2 − d_x                                              main-arm line length
//   r = √(Za Zb)/Z2,  q = f²/(fpa fpb)
//   d2   = √(Da Db) [0.5 − r (0.05 + 0.7 e^{−1.6r} + 0.25 r q − 0.17 ln r)]
//   L2   = max(Wa, Wb)/2 − d2                                      side-arm line length (may be < 0)
//   T_x² = 1 − π (f/fp_x)² [(Z_x/Z2)²/12 + (0.5 − d2/D_x)²]        main-arm transformer ratios
//   B_T  = 5.5 √(Da Db/(λa λb)) (εr+2)/εr / Z2 / √(Ta² Tb²) · √(da db)/D2
//          · [1 + 0.9 ln r + 4.5 r q − 4.4 e^{−1.3r} − 20 (Z2/Z_F0)²]   shunt susceptance
//
// Equivalent circuit: a junction node X carrying B_T to ground; the side arm reaches X through its
// line L2; each main arm through its line L_x and an ideal transformer V_X = T_x V_x'. The transformer
// has no admittance matrix of its own, so it is folded into the arm line: with T = diag(1, 1/T_x),
// Y' = Tᵀ Y_line T between the arm's port node and X.
import { msline } from './microstrip.js';

const ZF0 = 376.730313668, C0 = 299792458;

/** All model quantities at frequency f (SI). */
export function teeParams({ Wa, Wb, W2, h, er, t = 0, f }) {
  const A = msline({ W: Wa, h, er, t, f }), B = msline({ W: Wb, h, er, t, f }), S = msline({ W: W2, h, er, t, f });
  const Za = A.Z0, Zb = B.Z0, Z2 = S.Z0;
  const Da = ZF0 / Za * h / Math.sqrt(A.epsEff), Db = ZF0 / Zb * h / Math.sqrt(B.epsEff), D2 = ZF0 / Z2 * h / Math.sqrt(S.epsEff);
  const fpa = 0.4e6 * Za / h, fpb = 0.4e6 * Zb / h;
  const lda = C0 / Math.sqrt(A.epsEff) / f, ldb = C0 / Math.sqrt(B.epsEff) / f;
  const da = 0.055 * D2 * Za / Z2 * (1 - 2 * Za / Z2 * (f / fpa) ** 2);
  const db = 0.055 * D2 * Zb / Z2 * (1 - 2 * Zb / Z2 * (f / fpb) ** 2);
  const La = 0.5 * W2 - da, Lb = 0.5 * W2 - db;
  const r = Math.sqrt(Za * Zb) / Z2, q = f * f / fpa / fpb;
  const d2 = Math.sqrt(Da * Db) * (0.5 - r * (0.05 + 0.7 * Math.exp(-1.6 * r) + 0.25 * r * q - 0.17 * Math.log(r)));
  const L2 = 0.5 * Math.max(Wa, Wb) - d2;
  const Ta2 = Math.max(1 - Math.PI * (f / fpa) ** 2 * ((Za / Z2) ** 2 / 12 + (0.5 - d2 / Da) ** 2), 1e-30);
  const Tb2 = Math.max(1 - Math.PI * (f / fpb) ** 2 * ((Zb / Z2) ** 2 / 12 + (0.5 - d2 / Db) ** 2), 1e-30);
  const Bt = 5.5 * Math.sqrt(Da * Db / lda / ldb) * (er + 2) / er / Z2 / Math.sqrt(Ta2 * Tb2) * Math.sqrt(Math.max(0, da * db)) / D2 *
    (1 + 0.9 * Math.log(r) + 4.5 * r * q - 4.4 * Math.exp(-1.3 * r) - 20 * (Z2 / ZF0) ** 2);
  return { Za, Zb, Z2, ea: A.epsEff, eb: B.epsEff, e2: S.epsEff, Da, Db, D2, fpa, fpb, da, db, La, Lb, d2, L2, Ta2, Tb2, Bt };
}

// lossless line two-port: Y = (1/Z)[[−j cot βL, j csc βL], [j csc βL, −j cot βL]]
function lineY(Z, eps, L, f) {
  let bl = 2 * Math.PI * f * Math.sqrt(eps) / C0 * L;
  if (Math.abs(bl) < 1e-9) bl = bl < 0 ? -1e-9 : 1e-9;
  return { y11: -1 / (Z * Math.tan(bl)), y12: 1 / (Z * Math.sin(bl)) };      // imaginary parts
}

/**
 * Admittance block over the nodes [a, b, side, X] (X internal), imaginary parts only (lossless).
 * Returns { re, im, n: 4 } row-major, as the solver's sections do.
 */
export function teeY(geo, f) {
  const p = teeParams({ ...geo, f });
  const n = 4, im = new Float64Array(16), re = new Float64Array(16);
  const add = (i, j, v) => { im[i * n + j] += v; };
  const arm = (port, Z, eps, L, T) => {          // port node index, transformer ratio T (=1: none)
    const { y11, y12 } = lineY(Z, eps, L, f);
    add(port, port, y11); add(port, 3, y12 / T); add(3, port, y12 / T); add(3, 3, y11 / (T * T));
  };
  arm(0, p.Za, p.ea, p.La, Math.sqrt(p.Ta2));
  arm(1, p.Zb, p.eb, p.Lb, Math.sqrt(p.Tb2));
  arm(2, p.Z2, p.e2, p.L2, 1);
  add(3, 3, p.Bt);
  return { re, im, n };
}
