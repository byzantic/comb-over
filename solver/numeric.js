// Numerical helpers shared by the planar (mtl2d.js) and thick-strip (thick.js) solvers.

// J_0..J_{n−1}(x), x ≥ 0, into out (Miller's downward recurrence, normalised by J0 + 2ΣJ_2k = 1).
export function besselJ(n, x, out) {
  if (x < 1e-300) { out.fill(0, 0, n); out[0] = 1; return; }
  const top = Math.max(n, x);
  const m = 2 * Math.floor((top + 20 + Math.sqrt(40 * top)) / 2);
  let bjp = 0, bj = 1, sum = 0, even = false;
  const tox = 2 / x;
  for (let j = m; j > 0; j--) {
    const bjm = j * tox * bj - bjp; bjp = bj; bj = bjm;
    if (Math.abs(bj) > 1e250) { bj *= 1e-250; bjp *= 1e-250; sum *= 1e-250; for (let i = j - 1; i < n; i++) out[i] *= 1e-250; }
    if (even) sum += bj;
    even = !even;
    if (j - 1 < n) out[j - 1] = bj;
  }
  const norm = 2 * sum - bj;
  for (let i = 0; i < n; i++) out[i] /= norm;
}

// Gauss–Legendre nodes/weights on [−1, 1] (Newton on P_n).
export function gaussLegendre(n) {
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), pp = 0;
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0;
      for (let j = 1; j <= n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
      pp = n * (z * p1 - p2) / (z * z - 1);
      const dz = p1 / pp; z -= dz; if (Math.abs(dz) < 1e-16) break;
    }
    x[i] = z; w[i] = 2 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
}

// admittance looking into a list of layers (first one adjacent), ending in ground (cover = true) or a
// half-space of permittivity `end`
export function stackY(beta, layers, cover, end) {
  let Y = cover ? Infinity : end * beta;
  for (let i = layers.length - 1; i >= 0; i--) {
    const { t, er } = layers[i], y0 = er * beta, th = Math.tanh(beta * t);
    Y = Y === Infinity ? y0 / th : y0 * (Y + y0 * th) / (y0 + Y * th);
  }
  return Y;
}

export function cholSolve(A, n, B, m) {
  // A n×n SPD (row-major, overwritten), B n×m (overwritten with the solution)
  for (let j = 0; j < n; j++) {
    let s = A[j * n + j];
    for (let k = 0; k < j; k++) s -= A[j * n + k] * A[j * n + k];
    if (!(s > 0)) throw new Error('moment matrix is not positive definite (geometry too extreme, or too many basis functions)');
    const d = Math.sqrt(s); A[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = A[i * n + j];
      for (let k = 0; k < j; k++) t -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = t / d;
    }
  }
  for (let c = 0; c < m; c++) {
    for (let i = 0; i < n; i++) { let t = B[i * m + c]; for (let k = 0; k < i; k++) t -= A[i * n + k] * B[k * m + c]; B[i * m + c] = t / A[i * n + i]; }
    for (let i = n - 1; i >= 0; i--) { let t = B[i * m + c]; for (let k = i + 1; k < n; k++) t -= A[k * n + i] * B[k * m + c]; B[i * m + c] = t / A[i * n + i]; }
  }
}

