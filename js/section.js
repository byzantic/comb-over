// Uniform N-conductor coupled TEM / quasi-TEM line section → 2N-port admittance matrix.
//
// Per-unit-length Maxwell capacitance C and inductance L (both symmetric, N×N, SI).
// Modes: with M = C^½ L C^½ = P Λ P^T (P orthonormal), the voltage eigenvectors of LC are
// Tv = C^-½ P and the modal velocities are v_i = 1/√λ_i. Writing W = C^½ P, the section's
// admittance matrix (terminals ordered A1..AN, B1..BN, currents into the section) is
//
//   Y11 = Y22 =  W diag(v_i coth γ_i ℓ) W^T,   Y12 = Y21 = −W diag(v_i csch γ_i ℓ) W^T
//
// which reduces to Y11 = v C coth(γℓ) in a homogeneous medium. Loss is modelled per mode with a
// frequency-independent unloaded Q: γ_i = β_i (1/(2Q) + j). Characteristic admittances are kept
// real (low-loss approximation).

import { rMul, rSymFunc, jacobiEig } from './linalg.js';

export const C0 = 299792458;
export const MU0 = 4e-7 * Math.PI;
export const EPS0 = 1 / (MU0 * C0 * C0);
export const ETA0 = MU0 * C0;

export class Section {
  // C, L: arrays of arrays (F/m, H/m).
  constructor({ name, C, L, len, Q = Infinity, ends }) {
    this.name = name;
    this.N = C.length;
    this.C = C; this.L = L; this.Q = Q; this.ends = ends;
    const Ch = rSymFunc(C, x => {
      if (!(x > 0)) throw new Error(`${name}: capacitance matrix is not positive definite (eigenvalue ${x.toExponential(3)})`);
      return Math.sqrt(x);
    });
    const M = rMul(rMul(Ch, L), Ch);
    for (let i = 0; i < this.N; i++) for (let j = 0; j < i; j++) { const a = (M[i][j] + M[j][i]) / 2; M[i][j] = M[j][i] = a; }
    let { d, V: P } = jacobiEig(M);
    if (d.some(x => !(x > 0))) throw new Error(`${name}: L·C has a non-positive eigenvalue; check the L matrix`);
    // Homogeneous medium: all modes degenerate, so any orthonormal P works. Use the eigenvectors of C
    // (the characteristic-admittance eigenmodes) so the reported modes are meaningful.
    if ((Math.max(...d) - Math.min(...d)) <= 1e-9 * Math.max(...d)) {
      P = jacobiEig(C).V;
      const lam = d.reduce((a, b) => a + b) / d.length;
      d = d.map(() => lam);
    }
    this.homogeneous = d.every(x => x === d[0]);
    // sort modes by velocity (descending eps_eff)
    const order = d.map((_, i) => i).sort((a, b) => d[b] - d[a]);
    this.v = order.map(i => 1 / Math.sqrt(d[i]));
    const W = rMul(Ch, P);
    this.W = W.map(r => order.map(i => r[i]));
    this.Tv = rMul(rSymFunc(C, x => 1 / Math.sqrt(x)), P).map(r => order.map(i => r[i]));
    this.len = typeof len === 'function' ? len(this) : len;
    if (!(this.len > 0)) throw new Error(`${name}: length must be > 0`);
  }

  get epsEff() { return this.v.map(v => (C0 / v) ** 2); }

  // Characteristic admittance matrix Yc = W diag(v) W^T (S)
  get Yc() {
    const N = this.N, W = this.W;
    return Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => {
      let s = 0; for (let k = 0; k < N; k++) s += W[i][k] * this.v[k] * W[j][k]; return s;
    }));
  }

  // Modal characteristic impedances (power-normalised modal voltage vectors): Z_i = 1/(v_i · tv_i^T C tv_i) with tv normalised to |tv|=1
  modalInfo() {
    const N = this.N;
    return this.v.map((v, k) => {
      let tv = this.Tv.map(r => r[k]);
      const nrm = Math.hypot(...tv); tv = tv.map(x => x / nrm);
      const imax = tv.reduce((b, x, i) => (Math.abs(x) > Math.abs(tv[b]) ? i : b), 0);
      if (tv[imax] < 0) tv = tv.map(x => -x);
      let q = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) q += tv[i] * this.C[i][j] * tv[j];
      return { v, epsEff: (C0 / v) ** 2, vector: tv, Z: 1 / (v * q) };
    });
  }

  // Fill the 2N×2N admittance matrix at frequency f (Hz). Returns {re, im} Float64Arrays (row-major 2N×2N).
  admittance(f) {
    const N = this.N, n2 = 2 * N, W = this.W, w = 2 * Math.PI * f;
    const cr = new Float64Array(N), ci = new Float64Array(N), sr = new Float64Array(N), si = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const beta = w / this.v[k];
      const x = (isFinite(this.Q) ? beta / (2 * this.Q) : 0) * this.len, y = beta * this.len;
      // coth(x+jy) = [sinh 2x − j sin 2y] / [cosh 2x − cos 2y]
      const den = Math.cosh(2 * x) - Math.cos(2 * y);
      cr[k] = this.v[k] * Math.sinh(2 * x) / den;
      ci[k] = -this.v[k] * Math.sin(2 * y) / den;
      // csch(x+jy) = 1/sinh(x+jy),  sinh(x+jy) = sinh x cos y + j cosh x sin y
      const a = Math.sinh(x) * Math.cos(y), b = Math.cosh(x) * Math.sin(y), d2 = a * a + b * b;
      sr[k] = this.v[k] * a / d2; si[k] = -this.v[k] * b / d2;
    }
    const re = new Float64Array(n2 * n2), im = new Float64Array(n2 * n2);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      let r11 = 0, i11 = 0, r12 = 0, i12 = 0;
      for (let k = 0; k < N; k++) {
        const ww = W[i][k] * W[j][k];
        r11 += ww * cr[k]; i11 += ww * ci[k];
        r12 -= ww * sr[k]; i12 -= ww * si[k];
      }
      re[i * n2 + j] = r11; im[i * n2 + j] = i11;
      re[(i + N) * n2 + j + N] = r11; im[(i + N) * n2 + j + N] = i11;
      re[i * n2 + j + N] = r12; im[i * n2 + j + N] = i12;
      re[(i + N) * n2 + j] = r12; im[(i + N) * n2 + j] = i12;
    }
    return { re, im, n: n2 };
  }
}

// ---------- constructors from common parameterisations ----------

// Homogeneous medium from a characteristic admittance matrix Y0 (S) and relative permittivity.
export function fromY0(Y0, er) {
  const v = C0 / Math.sqrt(er);
  const C = Y0.map(r => r.map(x => x / v));
  const Cinv = rSymFunc(C, x => 1 / x);
  const L = Cinv.map(r => r.map(x => x / (v * v)));
  return { C, L };
}

// Homogeneous medium from normalised Maxwell capacitance matrix C/ε (Matthaei/Getsinger convention).
export function fromCnorm(Cn, er) {
  const eps = EPS0 * er;
  const C = Cn.map(r => r.map(x => x * eps));
  const v = C0 / Math.sqrt(er);
  const L = rSymFunc(C, x => 1 / x).map(r => r.map(x => x / (v * v)));
  return { C, L };
}

// Ground + mutual (positive) capacitances → Maxwell matrix.
export function maxwellFromGroundMutual(Cg, Cm /* N×N symmetric, diag ignored */) {
  const N = Cg.length;
  return Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => {
    if (i !== j) return -Cm[i][j];
    let s = Cg[i]; for (let k = 0; k < N; k++) if (k !== i) s += Cm[i][k]; return s;
  }));
}

// Symmetric pair from even/odd impedances and effective permittivities.
export function fromEvenOdd(Ze, Zo, ee, eo) {
  const Ce = Math.sqrt(ee) / (C0 * Ze), Co = Math.sqrt(eo) / (C0 * Zo);
  const Le = Ze * Math.sqrt(ee) / C0, Lo = Zo * Math.sqrt(eo) / C0;
  return {
    C: [[(Ce + Co) / 2, (Ce - Co) / 2], [(Ce - Co) / 2, (Ce + Co) / 2]],
    L: [[(Le + Lo) / 2, (Le - Lo) / 2], [(Le - Lo) / 2, (Le + Lo) / 2]],
  };
}
