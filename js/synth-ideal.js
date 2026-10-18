// Ideal |S21| of the prototype after the standard band-pass mapping Ω = (f/f0 − f0/f)/FBW.
// For Butterworth, FBW is the 3 dB bandwidth; for Chebyshev, the ripple bandwidth.
export function idealS21(type, n, rippleDb, f0, fbw, f) {
  const W = Math.abs((f / f0 - f0 / f) / fbw);
  if (type === 'butterworth') return 1 / Math.sqrt(1 + W ** (2 * n));
  const e2 = 10 ** (rippleDb / 10) - 1;
  const T = W <= 1 ? Math.cos(n * Math.acos(W)) : Math.cosh(n * Math.acosh(W));
  return 1 / Math.sqrt(1 + e2 * T * T);
}

