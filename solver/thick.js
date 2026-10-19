// Finite-thickness strips for mtl2d (rectangular cross-section).
//
// Each strip of width w and thickness t is the boundary of a rectangle standing on the strip plane:
// bottom face (z = 0), top face (z = t) and two side walls. The rectangle grows upward into the
// "host" layer, i.e. the first layer above the strip plane (or the top half-space). Every face
// carries the edge-singular Chebyshev basis T_k(u)/√(1−u²) along its length.
//
// Green's function in the host layer (permittivity ε_h, thickness d, z measured from the strip plane):
// in the spectral domain it is exact,
//     G̃ = e^{−β|z−z'|}/(2ε_hβ) + (s/D)[Γd E1E1' + ΓdΓu e²(E1E2' + E2E1') + Γu e² E2E2'],
// s = 1/(2ε_hβ), E1 = e^{−βz}, E2 = e^{βz}, e = e^{−βd}, D = 1 − ΓdΓu e², with Γd, Γu the reflection
// coefficients of the stacks below and above the host layer. It is split into
//   · log terms, done in space: the free-space term, single images across z = 0 (Γd∞) and z = d (Γu∞)
//     with the β → ∞ reflection coefficients, and a ground-like image across z = −t_b with coefficient
//     cg = −(1 + Γd∞ + Γu∞) so that the logs' total charge is zero (G̃ is finite at β = 0);
//   · a remainder that is finite at β = 0, decays at least as e^{−2β·min(t_b, d − t)} and is separable
//     in z and z', so its Galerkin integrals reduce to 1-D transforms of each basis: J_k for a face,
//     e^{∓βz}·I_l for a wall.
// The log Galerkin integrals use the same exact inner integral as the planar solver (the Chebyshev
// expansion of ln|t − v|, now for complex t, i.e. any relative position and orientation) and
// composite Gauss–Legendre quadrature in θ (u = cos θ) outside; a face that touches another at a
// corner gives an integrand that is analytic in θ.
import { besselJ, gaussLegendre, stackY, cholSolve } from './numeric.js';

const GL = gaussLegendre(12);

// e^{−x} I_0..I_{n−1}(x), x ≥ 0 (Miller's downward recurrence, normalised by e^{−x}(I0 + 2ΣI_k) = 1)
function besselIe(n, x, out) {
  if (x < 1e-300) { out.fill(0, 0, n); out[0] = 1; return; }
  const top = Math.max(n, x);
  const m = 2 * Math.floor((top + 20 + Math.sqrt(40 * top)) / 2);
  let bip = 0, bi = 1, sum = 0;
  const tox = 2 / x;
  for (let j = m; j > 0; j--) {
    const bim = bip + j * tox * bi; bip = bi; bi = bim;
    if (Math.abs(bi) > 1e250) { bi *= 1e-250; bip *= 1e-250; sum *= 1e-250; for (let i = j - 1; i < n; i++) out[i] *= 1e-250; }
    if (j - 1 > 0) sum += bi;
    if (j - 1 < n) out[j - 1] = bi;
  }
  const norm = bi + 2 * sum;            // I0 + 2ΣI_k  (∝ e^x)
  for (let i = 0; i < n; i++) out[i] /= norm;
}

// ---------------------------------------------------------------- segments

function segmentsOf(strips, unit, Kh, Kv) {
  const segs = [];
  strips.forEach((s, m) => {
    const x = s.x / unit, a = s.w / 2 / unit, t = s.t / unit;
    segs.push({ m, kind: 'h', cx: x, cz: 0, a, dx: 1, dz: 0, K: Kh });
    if (!(t > 0)) return;                               // a zero-thickness strip is its bottom face
    segs.push({ m, kind: 'h', cx: x, cz: t, a, dx: 1, dz: 0, K: Kh });
    segs.push({ m, kind: 'v', cx: x - a, cz: t / 2, a: t / 2, dx: 0, dz: 1, K: Kv });
    segs.push({ m, kind: 'v', cx: x + a, cz: t / 2, a: t / 2, dx: 0, dz: 1, K: Kv });
  });
  let o = 0; for (const g of segs) { g.off = o; o += g.K; }
  return { segs, n: o };
}

const mirror = (g, z0) => ({ ...g, cz: 2 * z0 - g.cz, dz: -g.dz });

// distance between two segments (they never cross)
function segDist(A, B) {
  const ends = (g) => [[g.cx - g.a * g.dx, g.cz - g.a * g.dz], [g.cx + g.a * g.dx, g.cz + g.a * g.dz]];
  const pt = (p, g) => { // point to segment
    const u = Math.max(-1, Math.min(1, ((p[0] - g.cx) * g.dx + (p[1] - g.cz) * g.dz) / g.a));
    return Math.hypot(p[0] - g.cx - g.a * u * g.dx, p[1] - g.cz - g.a * u * g.dz);
  };
  return Math.min(...ends(A).map(p => pt(p, B)), ...ends(B).map(p => pt(p, A)));
}

// ∫∫ f_k^A f_l^B (−ln|p − q|) over segments A and B → out[k*KB + l]
function logPair(A, B, out, fine) {
  const KA = A.K, KB = B.K;
  out.fill(0, 0, KA * KB);
  const tol = 1e-12 * Math.max(A.a, B.a);
  const cross = A.dx * B.dz - A.dz * B.dx, dot = A.dx * B.dx + A.dz * B.dz;
  if (Math.abs(A.cx - B.cx) < tol && Math.abs(A.cz - B.cz) < tol && Math.abs(A.a - B.a) < tol && Math.abs(cross) < 1e-12) {
    // the same segment (possibly reversed): closed form
    const a = A.a;
    out[0] = a * a * Math.PI * Math.PI * (Math.LN2 - Math.log(a));
    for (let k = 1; k < Math.min(KA, KB); k++) out[k * KB + k] = (dot < 0 && k % 2 ? -1 : 1) * a * a * Math.PI * Math.PI / (2 * k);
    return;
  }
  const dist = segDist(A, B);
  let overlap = false;
  if (Math.abs(cross) < 1e-12) {
    const u1 = ((B.cx - B.a * B.dx - A.cx) * A.dx + (B.cz - B.a * B.dz - A.cz) * A.dz) / A.a;
    const u2 = ((B.cx + B.a * B.dx - A.cx) * A.dx + (B.cz + B.a * B.dz - A.cz) * A.dz) / A.a;
    overlap = Math.min(Math.max(u1, u2), 1) - Math.max(Math.min(u1, u2), -1) > 0;
  }
  let h;
  if (dist < tol) h = 0.25;                                   // touching at a corner: analytic in θ
  else { const e = dist / A.a; h = Math.min(0.3, overlap ? e : 0.5 * Math.sqrt(2 * e)); }
  const np = Math.min(4000, Math.ceil(Math.PI / (h / fine)));
  const hp = Math.PI / np;
  const inner = new Float64Array(KB);
  const lnaB = Math.log(B.a);
  for (let p = 0; p < np; p++) for (let g = 0; g < GL.x.length; g++) {
    const th = (p + 0.5 + 0.5 * GL.x[g]) * hp, u = Math.cos(th);
    const X = A.cx + A.a * A.dx * u - B.cx, Z = A.cz + A.a * A.dz * u - B.cz;
    const tr = (X * B.dx + Z * B.dz) / B.a, ti = (Z * B.dx - X * B.dz) / B.a;
    const zr = tr * tr - ti * ti - 1, zi = 2 * tr * ti, mod = Math.hypot(zr, zi);
    let sr = Math.sqrt((mod + zr) / 2), si = Math.sqrt(Math.max(0, (mod - zr) / 2)); if (zi < 0) si = -si;
    let dr = tr + sr, di = ti + si;
    const d2 = tr - sr, d2i = ti - si;
    if (d2 * d2 + d2i * d2i > dr * dr + di * di) { dr = d2; di = d2i; }
    const dd = dr * dr + di * di, wr = dr / dd, wi = -di / dd;
    inner[0] = -Math.PI * lnaB + Math.PI * Math.log(2 * Math.sqrt(wr * wr + wi * wi));
    let pr = 1, pi = 0;
    for (let l = 1; l < KB; l++) { const nr = pr * wr - pi * wi; pi = pr * wi + pi * wr; pr = nr; inner[l] = Math.PI * pr / l; }
    const wq = 0.5 * hp * GL.w[g] * A.a * B.a;
    for (let k = 0; k < KA; k++) { const ck = Math.cos(k * th) * wq; for (let l = 0; l < KB; l++) out[k * KB + l] += ck * inner[l]; }
  }
}

// ---------------------------------------------------------------- the moment matrix

/** Normalised Maxwell matrix C/ε0 of strips {x, w, t} (metres) in a stack; Kh, Kv basis functions per face/wall. */
export function capMatrixThick(strips, stack, Kh, Kv, fine = 1, logCache = new Map()) {
  const below = stack.below, aboveAll = stack.above ?? [], top = stack.top ?? 1;
  const unit = below[0].t;
  const tb = 1;                                          // below[0].t in units of itself
  const host = aboveAll.length ? aboveAll[0] : { t: Infinity, er: top };
  const upper = aboveAll.slice(1);
  const eh = host.er, d = host.t / unit;
  const tmax = Math.max(...strips.map(s => s.t)) / unit;
  if (!(tmax < d)) throw new Error('strip thickness reaches the next layer or the cover');
  const belowN = below.map(l => ({ t: l.t / unit, er: l.er })), upperN = upper.map(l => ({ t: l.t / unit, er: l.er }));
  const eb = below[0].er;
  const Gd8 = (eh - eb) / (eh + eb);
  let Gu8 = 0;
  if (Number.isFinite(d)) {
    if (upper.length) Gu8 = (eh - upper[0].er) / (eh + upper[0].er);
    else if (stack.cover) Gu8 = -1;
    else Gu8 = (eh - top) / (eh + top);
  }
  const cg = -(1 + Gd8 + Gu8);
  const images = [{ z0: null, c: 1 }, { z0: 0, c: Gd8 }, { z0: -tb, c: cg }, ...(Number.isFinite(d) ? [{ z0: d, c: Gu8 }] : [])].filter(i => Math.abs(i.c) > 1e-15);

  const { segs, n } = segmentsOf(strips, unit, Kh, Kv);
  const P = new Float64Array(n * n);

  // ---- log part
  const blk = new Float64Array(Math.max(Kh, Kv) ** 2);
  for (let i = 0; i < segs.length; i++) for (let j = i; j < segs.length; j++) {
    const A = segs[i], B = segs[j];
    for (const im of images) {
      const Bi = im.z0 === null ? B : mirror(B, im.z0);
      // the integral depends only on the relative geometry: arrays of equal strips repeat it, and the
      // dielectric and air solves share it
      const key = `${A.kind}${A.K}|${B.kind}${B.K}|${A.a.toPrecision(12)}|${B.a.toPrecision(12)}|${(Bi.cx - A.cx).toPrecision(12)}|${A.cz.toPrecision(12)}|${Bi.cz.toPrecision(12)}|${Bi.dz}|${fine}`;
      let v = logCache.get(key);
      if (!v) { logPair(A, Bi, blk, fine); v = blk.slice(0, A.K * B.K); logCache.set(key, v); }
      blk.set(v);
      const f = im.c / (2 * Math.PI * eh);
      for (let k = 0; k < A.K; k++) for (let l = 0; l < B.K; l++) {
        const v = f * blk[k * B.K + l];
        P[(A.off + k) * n + B.off + l] += v;
        if (j !== i) P[(B.off + l) * n + A.off + k] += v;
      }
    }
  }

  // ---- spectral remainder
  const xs = segs.map(g => g.cx);
  const span = Math.max(...xs) - Math.min(...xs) + 2 * Math.max(...segs.map(g => g.kind === 'h' ? g.a : 0));
  const dmin = Math.min(tb, Number.isFinite(d) ? d - tmax : Infinity);
  const thickest = Math.max(...belowN.map(l => l.t), ...upperN.map(l => l.t), Number.isFinite(d) ? d : 0);
  const Bmax = 17 * Math.sqrt(fine) / dmin;
  const panel = Math.min(5 / (span + 2 * dmin), 0.6 / thickest, 0.6 / dmin) / fine;
  const np = Math.ceil(Bmax / panel), hb = Bmax / np;
  const XR = new Float64Array(n), XI = new Float64Array(n), Z1 = new Float64Array(n), Z2 = new Float64Array(n);
  const yR = new Float64Array(n), yI = new Float64Array(n);
  const aH = [...new Set(segs.filter(g => g.kind === 'h').map(g => g.a))], Jh = aH.map(() => new Float64Array(Kh));
  const aV = [...new Set(segs.filter(g => g.kind === 'v').map(g => g.a))], Iv = aV.map(() => new Float64Array(Kv));
  const R = new Float64Array(n * n);                    // remainder, upper triangle
  const rank1 = (lam) => {
    for (let i = 0; i < n; i++) {
      const ri = lam * yR[i], ii = lam * yI[i], row = i * n;
      if (ri === 0 && ii === 0) continue;
      for (let j = i; j < n; j++) R[row + j] += ri * yR[j] + ii * yI[j];
    }
  };
  for (let p = 0; p < np; p++) for (let g = 0; g < GL.x.length; g++) {
    const beta = (p + 0.5 + 0.5 * GL.x[g]) * hb, wq = 0.5 * hb * GL.w[g] / Math.PI;
    const yd = stackY(beta, belowN, true, 0) / (eh * beta), Gd = (1 - yd) / (1 + yd);
    let Gu = 0, e = 0;
    if (Number.isFinite(d)) {
      const Yu = stackY(beta, upperN, !!stack.cover, top);
      Gu = Yu === Infinity ? -1 : (1 - Yu / (eh * beta)) / (1 + Yu / (eh * beta));
      e = Math.exp(-beta * d);
    }
    const D = 1 - Gd * Gu * e * e, s = 1 / (2 * eh * beta);
    const c11 = s * (Gd / D - Gd8 - cg * Math.exp(-2 * beta * tb));
    const c12 = s * Gd * Gu * e * e / D;
    const c22 = s * (Gu / D - Gu8) * e * e;
    aH.forEach((a, i) => besselJ(Kh, beta * a, Jh[i]));
    aV.forEach((a, i) => besselIe(Kv, beta * a, Iv[i]));
    for (const sg of segs) {
      const cr = Math.cos(beta * sg.cx), ci = -Math.sin(beta * sg.cx);
      if (sg.kind === 'h') {
        const J = Jh[aH.indexOf(sg.a)], f = Math.PI * sg.a, z1 = Math.exp(-beta * sg.cz), z2 = 1 / z1;
        for (let k = 0; k < sg.K; k++) {
          const q = sg.off + k, m = k & 3, jj = f * J[k];
          // (−j)^k (cr + j ci)
          XR[q] = jj * (m === 0 ? cr : m === 1 ? ci : m === 2 ? -cr : -ci);
          XI[q] = jj * (m === 0 ? ci : m === 1 ? -cr : m === 2 ? -ci : cr);
          Z1[q] = z1; Z2[q] = z2;
        }
      } else {
        const I = Iv[aV.indexOf(sg.a)], f = Math.PI * sg.a;
        const z1 = Math.exp(-beta * (sg.cz - sg.a)), z2 = Math.exp(beta * (sg.cz + sg.a));
        for (let l = 0; l < sg.K; l++) {
          const q = sg.off + l;
          XR[q] = cr; XI[q] = ci;
          Z1[q] = f * z1 * (l & 1 ? -1 : 1) * I[l]; Z2[q] = f * z2 * I[l];
        }
      }
    }
    if (c12 === 0 && c22 === 0) {
      for (let q = 0; q < n; q++) { yR[q] = Z1[q] * XR[q]; yI[q] = Z1[q] * XI[q]; }
      rank1(wq * c11);
    } else {
      // eigen-decomposition of [[c11, c12], [c12, c22]]
      const tr = (c11 + c22) / 2, df = (c11 - c22) / 2, r = Math.hypot(df, c12);
      const l1 = tr + r, l2 = tr - r;
      const th = 0.5 * Math.atan2(2 * c12, c11 - c22), cs = Math.cos(th), sn = Math.sin(th);
      for (const [lam, p1, q1] of [[l1, cs, sn], [l2, -sn, cs]]) {
        for (let q = 0; q < n; q++) { const zz = p1 * Z1[q] + q1 * Z2[q]; yR[q] = zz * XR[q]; yI[q] = zz * XI[q]; }
        rank1(wq * lam);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    P[i * n + i] += R[i * n + i];
    for (let j = i + 1; j < n; j++) { P[i * n + j] += R[i * n + j]; P[j * n + i] += R[i * n + j]; }
  }
  // C/ε0 = Bᵀ P⁻¹ B: every face of strip m at potential 1; B[(face, 0), m] = π a_face
  const N = strips.length, X = new Float64Array(n * N);
  for (const g of segs) X[g.off * N + g.m] = Math.PI * g.a;
  const Bm = Float64Array.from(X);
  cholSolve(P, n, X, N);
  const C = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const g of segs) for (let j = 0; j < N; j++) C[g.m][j] += Bm[g.off * N + g.m] * X[g.off * N + j];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const v = (C[i][j] + C[j][i]) / 2; C[i][j] = C[j][i] = v; }
  return { C, nodes: np * GL.x.length, n };
}
