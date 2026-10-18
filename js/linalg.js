// Dense linear algebra: complex (split re/im Float64Array, row-major) and real symmetric.

export class CMat {
  constructor(rows, cols = rows) {
    this.rows = rows; this.cols = cols;
    this.re = new Float64Array(rows * cols);
    this.im = new Float64Array(rows * cols);
  }
  static identity(n) { const m = new CMat(n); for (let i = 0; i < n; i++) m.re[i * n + i] = 1; return m; }
  get(i, j) { const k = i * this.cols + j; return [this.re[k], this.im[k]]; }
  set(i, j, re, im = 0) { const k = i * this.cols + j; this.re[k] = re; this.im[k] = im; }
  add(i, j, re, im = 0) { const k = i * this.cols + j; this.re[k] += re; this.im[k] += im; }
  clone() { const m = new CMat(this.rows, this.cols); m.re.set(this.re); m.im.set(this.im); return m; }
}

// Solve A X = B (A n×n, B n×m). A and B are not modified. Gaussian elimination, partial pivoting.
export function csolve(A, B) {
  const n = A.rows, m = B.cols;
  if (A.cols !== n || B.rows !== n) throw new Error('csolve: dimension mismatch');
  const ar = Float64Array.from(A.re), ai = Float64Array.from(A.im);
  const br = Float64Array.from(B.re), bi = Float64Array.from(B.im);
  let scale = 0; for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.hypot(ar[i], ai[i]));
  const tiny = scale * 1e-14;
  for (let k = 0; k < n; k++) {
    // pivot
    let p = k, best = -1;
    for (let i = k; i < n; i++) {
      const v = Math.hypot(ar[i * n + k], ai[i * n + k]);
      if (v > best) { best = v; p = i; }
    }
    if (!(best > tiny) || !isFinite(best)) throw new Error('singular matrix');
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        let t = ar[k * n + j]; ar[k * n + j] = ar[p * n + j]; ar[p * n + j] = t;
        t = ai[k * n + j]; ai[k * n + j] = ai[p * n + j]; ai[p * n + j] = t;
      }
      for (let j = 0; j < m; j++) {
        let t = br[k * m + j]; br[k * m + j] = br[p * m + j]; br[p * m + j] = t;
        t = bi[k * m + j]; bi[k * m + j] = bi[p * m + j]; bi[p * m + j] = t;
      }
    }
    const pr = ar[k * n + k], pi = ai[k * n + k], pd = pr * pr + pi * pi;
    const ivr = pr / pd, ivi = -pi / pd; // 1/pivot
    for (let i = k + 1; i < n; i++) {
      const xr = ar[i * n + k], xi = ai[i * n + k];
      if (xr === 0 && xi === 0) continue;
      const fr = xr * ivr - xi * ivi, fi = xr * ivi + xi * ivr;
      for (let j = k; j < n; j++) {
        const yr = ar[k * n + j], yi = ai[k * n + j];
        ar[i * n + j] -= fr * yr - fi * yi; ai[i * n + j] -= fr * yi + fi * yr;
      }
      for (let j = 0; j < m; j++) {
        const yr = br[k * m + j], yi = bi[k * m + j];
        br[i * m + j] -= fr * yr - fi * yi; bi[i * m + j] -= fr * yi + fi * yr;
      }
    }
  }
  // back substitution
  const X = new CMat(n, m);
  for (let j = 0; j < m; j++) {
    for (let i = n - 1; i >= 0; i--) {
      let sr = br[i * m + j], si = bi[i * m + j];
      for (let k = i + 1; k < n; k++) {
        const ur = ar[i * n + k], ui = ai[i * n + k];
        const xr = X.re[k * m + j], xi = X.im[k * m + j];
        sr -= ur * xr - ui * xi; si -= ur * xi + ui * xr;
      }
      const pr = ar[i * n + i], pi = ai[i * n + i], pd = pr * pr + pi * pi;
      X.re[i * m + j] = (sr * pr + si * pi) / pd;
      X.im[i * m + j] = (si * pr - sr * pi) / pd;
    }
  }
  return X;
}

// C = A·B
export function cmul(A, B) {
  const n = A.rows, p = A.cols, m = B.cols;
  const C = new CMat(n, m);
  for (let i = 0; i < n; i++) for (let k = 0; k < p; k++) {
    const ar = A.re[i * p + k], ai = A.im[i * p + k];
    if (ar === 0 && ai === 0) continue;
    for (let j = 0; j < m; j++) {
      const br = B.re[k * m + j], bi = B.im[k * m + j];
      C.re[i * m + j] += ar * br - ai * bi; C.im[i * m + j] += ar * bi + ai * br;
    }
  }
  return C;
}

// ---------- real symmetric ----------
// Matrices as arrays of arrays (small N).

export function rIdentity(n) { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))); }
export function rMul(A, B) {
  const n = A.length, p = B.length, m = B[0].length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let k = 0; k < p; k++) { const a = A[i][k]; if (a) for (let j = 0; j < m; j++) C[i][j] += a * B[k][j]; }
  return C;
}
export function rT(A) { return A[0].map((_, j) => A.map(r => r[j])); }

// Cyclic Jacobi eigen-decomposition of a symmetric matrix: A = V diag(d) V^T.
export function jacobiEig(Ain) {
  const n = Ain.length;
  const A = Ain.map(r => r.slice());
  const V = rIdentity(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, scale = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if (i !== j) off += A[i][j] ** 2; scale += A[i][j] ** 2; }
    if (off <= 1e-30 * scale || off === 0) break;
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p][q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { // columns
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) { // rows
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { d: A.map((r, i) => r[i]), V };
}

// f(A) for symmetric A via eigen-decomposition.
export function rSymFunc(A, f) {
  const { d, V } = jacobiEig(A);
  const n = A.length;
  const R = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let k = 0; k < n; k++) { const fk = f(d[k]); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) R[i][j] += V[i][k] * fk * V[j][k]; }
  return R;
}
export function rInvSym(A) { return rSymFunc(A, x => 1 / x); }
