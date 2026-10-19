// mtl2d — quasi-static per-unit-length C and L of N coupled strips in a layered dielectric (issue #11).
//
// Self-contained ES module (no imports), so it can be lifted into its own package later.
//
// Structure: N zero-thickness strips side by side in one plane. Below the plane a stack of dielectric
// layers on a ground plane; above it either nothing (air), dielectric layers ending in air, or layers
// ending in a ground cover. That covers microstrip, covered and overlaid microstrip, (offset) stripline
// and suspended stripline.
//
// Method: Galerkin method of moments for the strip charge. On each strip of half-width a the charge
// is expanded in Chebyshev polynomials with the edge singularity built in, f_k = T_k(u)/√(1−u²),
// u = (x−c)/a, which makes the solution converge in a handful of terms per strip. The Green's
// function of the stack is known in the spectral domain,
//     G̃(β) = 1 / (Y_up(β) + Y_down(β)),
// with Y = ε β coth(βt) for a layer on a ground and the usual transmission-line recursion through
// layers. It is split as G̃ = G̃∞ + ΔG̃ with
//     G̃∞(β) = (1 − e^{−2βd}) / (β (ε_a + ε_b))   ↔   G∞(x) = [ln|x + 2jd| − ln|x|] / (π (ε_a + ε_b)),
// ε_a, ε_b the permittivities touching the strips and d the distance to the nearest interface. The
// Galerkin integrals of the logarithms are done with the Chebyshev expansion of ln|t − v| (exact inner
// integral, Gauss–Chebyshev outer quadrature sized to the gap), the self term in closed form. The
// remainder ΔG̃ decays as e^{−2βd} and is finite at β = 0, so its spectral integral converges fast:
//     P_s = π a_m a_n ∫₀^∞ ΔG̃(β) J_k(βa_m) J_l(βa_n) {±cos | ±sin}(β(c_m − c_n)) dβ.
//
// C = ε0 Bᵀ P⁻¹ B with B selecting the k = 0 (net charge) terms; C0 is the same with every ε set to
// 1, and L = μ0 ε0 C0⁻¹. C per unit length is scale-free in 2-D, so lengths are normalised internally.

export const EPS0 = 8.8541878128e-12;
export const MU0 = 1.25663706212e-6;
export const C_LIGHT = 299792458;

// ---------------------------------------------------------------- geometry helpers

/** Strips from widths W[0..N−1] and gaps S[0..N−2] (or one gap for all), left edge at x = 0 → [{x, w}] (x = centre). */
export function stripsFromWS(W, S) {
  const Ws = Array.isArray(W) ? W : [W];
  const Ss = Array.isArray(S) ? S : Array(Math.max(0, Ws.length - 1)).fill(S);
  if (Ss.length !== Ws.length - 1) throw new Error(`need ${Ws.length - 1} gaps for ${Ws.length} strips, got ${Ss.length}`);
  const out = []; let x = 0;
  Ws.forEach((w, i) => { out.push({ x: x + w / 2, w }); x += w + (Ss[i] ?? 0); });
  const mid = x / 2; return out.map(s => ({ x: s.x - mid, w: s.w }));
}

/** Microstrip: strips on a substrate of height h over ground; air (or `top` εr) above. */
export const microstrip = ({ h, er, top = 1 }) => ({ below: [{ t: h, er }], above: [], top, cover: false });
/** Centred or offset stripline: ground planes b apart, strips at height hb above the lower one (default b/2). */
export const stripline = ({ b, er, hb = b / 2 }) => ({ below: [{ t: hb, er }], above: [{ t: b - hb, er }], cover: true });
/** Covered microstrip: substrate h, air gap `hc` to a ground cover. */
export const coveredMicrostrip = ({ h, er, hc }) => ({ below: [{ t: h, er }], above: [{ t: hc, er: 1 }], cover: true });

function checkInput(strips, stack) {
  if (!Array.isArray(strips) || !strips.length) throw new Error('no strips');
  for (const s of strips) if (!(s.w > 0) || !Number.isFinite(s.x)) throw new Error('each strip needs a centre x and a width w > 0');
  const sorted = [...strips].sort((p, q) => p.x - q.x);
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].x - sorted[i].w / 2) - (sorted[i - 1].x + sorted[i - 1].w / 2);
    if (!(gap > 0)) throw new Error('strips overlap or touch');
  }
  if (!stack || !stack.below?.length) throw new Error('the stack needs at least one layer below the strips (on the ground plane)');
  for (const l of [...stack.below, ...(stack.above ?? [])]) if (!(l.t > 0) || !(l.er >= 1)) throw new Error('each layer needs t > 0 and er ≥ 1');
  if (stack.cover && !stack.above?.length) throw new Error('a cover needs at least one layer between the strips and it');
}

// ---------------------------------------------------------------- special functions

// J_0..J_{n−1}(x), x ≥ 0, into out (Miller's downward recurrence, normalised by J0 + 2ΣJ_2k = 1).
function besselJ(n, x, out) {
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
function gaussLegendre(n) {
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

// ---------------------------------------------------------------- spectral Green's function of the stack

// admittance looking into a list of layers (first one adjacent), ending in ground (cover = true) or a
// half-space of permittivity `end`
function stackY(beta, layers, cover, end) {
  let Y = cover ? Infinity : end * beta;
  for (let i = layers.length - 1; i >= 0; i--) {
    const { t, er } = layers[i], y0 = er * beta, th = Math.tanh(beta * t);
    Y = Y === Infinity ? y0 / th : y0 * (Y + y0 * th) / (y0 + Y * th);
  }
  return Y;
}

function greensSplit(stack) {
  const above = stack.above ?? [], top = stack.top ?? 1;
  const ea = above.length ? above[0].er : top, eb = stack.below[0].er;
  const d = Math.min(stack.below[0].t, above.length ? above[0].t : Infinity);
  const es = ea + eb;
  const Gt = (b) => 1 / (stackY(b, stack.below, true, 0) + stackY(b, above, !!stack.cover, top));
  // ΔG̃ = G̃ − (1 − e^{−2βd})/(β ε_s): finite at 0, ~e^{−2βd} at ∞
  const dG = (b) => Gt(b) + Math.expm1(-2 * b * d) / (b * es);
  return { es, d, dG, thickest: Math.max(...stack.below.map(l => l.t), ...above.map(l => l.t)) };
}

// ---------------------------------------------------------------- Galerkin blocks

// ∫∫ f_k(x) f_l(x') (−ln|x − x' + jY|) dx dx' for strips (cm, am) and (cn, an); K×K into out[k*K+l].
function logBlock(cm, am, cn, an, Y, K, self, out, fine = 1) {
  out.fill(0);
  if (self && Y === 0) {
    out[0] = am * am * Math.PI * Math.PI * (Math.LN2 - Math.log(am));
    for (let k = 1; k < K; k++) out[k * K + k] = am * am * Math.PI * Math.PI / (2 * k);
    return;
  }
  // quadrature size from the distance of the singular set to strip m, in strip-m units
  const gap = Math.max(0, Math.abs(cm - cn) - am - an);
  const e = Math.hypot(gap, Y) / am;
  const delta = self ? e : 0.7 * Math.sqrt(2 * e);
  const Nq = Math.min(20000, Math.max(4 * K + 8, Math.ceil(20 * fine / Math.min(delta, 1))));
  const inner = new Float64Array(K);
  const lnan = Math.log(an);
  for (let i = 0; i < Nq; i++) {
    const th = (i + 0.5) * Math.PI / Nq, u = Math.cos(th);
    // t = (cm + am u − cn + jY)/an; w with |w| < 1 and t = (w + 1/w)/2
    const tr = (cm + am * u - cn) / an, ti = Y / an;
    // s = sqrt(t² − 1)
    const zr = tr * tr - ti * ti - 1, zi = 2 * tr * ti;
    const mod = Math.hypot(zr, zi);
    let sr = Math.sqrt((mod + zr) / 2), si = Math.sqrt(Math.max(0, (mod - zr) / 2)); if (zi < 0) si = -si;
    // w = 1/(t ± s), taking the larger denominator
    let dr = tr + sr, di = ti + si;
    const d2 = tr - sr, d2i = ti - si;
    if (d2 * d2 + d2i * d2i > dr * dr + di * di) { dr = d2; di = d2i; }
    const dd = dr * dr + di * di, wr = dr / dd, wi = -di / dd;
    const lnabs2w = Math.log(2 * Math.sqrt(wr * wr + wi * wi));
    inner[0] = -Math.PI * lnan + Math.PI * lnabs2w;
    let pr = 1, pi = 0;
    for (let l = 1; l < K; l++) { const nr = pr * wr - pi * wi; pi = pr * wi + pi * wr; pr = nr; inner[l] = Math.PI * pr / l; }
    const wq = Math.PI / Nq * am * an;
    for (let k = 0; k < K; k++) { const ck = Math.cos(k * th) * wq; for (let l = 0; l < K; l++) out[k * K + l] += ck * inner[l]; }
  }
}

// ---------------------------------------------------------------- dense SPD solve

function cholSolve(A, n, B, m) {
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

// ---------------------------------------------------------------- the solver

const GL = gaussLegendre(12);

/** Default number of basis functions per strip, from the tightest gap-to-width ratio. */
export function defaultOrder(strips, stack) {
  const s = [...strips].sort((p, q) => p.x - q.x);
  // charge varies on the scale of the nearest gap and of the distance to the nearest interface
  const d = stack ? Math.min(stack.below[0].t, ...(stack.above ?? []).map(l => l.t)) : Infinity;
  let r = Math.max(...strips.map(x => x.w)) / (2 * d);
  for (let i = 1; i < s.length; i++) {
    const gap = (s[i].x - s[i].w / 2) - (s[i - 1].x + s[i - 1].w / 2);
    r = Math.max(r, Math.max(s[i].w, s[i - 1].w) / gap);
  }
  return Math.min(32, Math.max(6, 4 + Math.ceil(2 * Math.sqrt(r))));   // ≈ 1e−6 relative in C (see tests)
}

// normalised Maxwell matrix C/ε0 for one stack
function capMatrix(strips, stack, K, unit, fine = 1) {
  const N = strips.length, n = N * K;
  const c = strips.map(s => s.x / unit), a = strips.map(s => s.w / 2 / unit);
  const st = { ...stack, below: stack.below.map(l => ({ t: l.t / unit, er: l.er })), above: (stack.above ?? []).map(l => ({ t: l.t / unit, er: l.er })) };
  const { es, d, dG, thickest } = greensSplit(st);
  const P = new Float64Array(n * n);
  const blk = new Float64Array(K * K), blk2 = new Float64Array(K * K);
  // spatial part: (1/(π ε_s)) [ (−ln|X|) − (−ln|X + 2jd|) ]
  for (let m = 0; m < N; m++) for (let q = m; q < N; q++) {
    logBlock(c[m], a[m], c[q], a[q], 0, K, m === q, blk, fine);
    logBlock(c[m], a[m], c[q], a[q], 2 * d, K, m === q, blk2, fine);
    for (let k = 0; k < K; k++) for (let l = 0; l < K; l++) {
      const v = (blk[k * K + l] - blk2[k * K + l]) / (Math.PI * es);
      P[(m * K + k) * n + q * K + l] += v;
      if (q !== m) P[(q * K + l) * n + m * K + k] += v;
    }
  }
  // spectral remainder
  const span = Math.max(...c.map((x, i) => x + a[i])) - Math.min(...c.map((x, i) => x - a[i]));
  const B = 17 * Math.sqrt(fine) / d;                                   // e^{−2Bd} ≈ 2e−15 (relative to the β ≈ 0 value)
  const rate = span + 2 * a.reduce((p, q) => Math.max(p, q), 0) + 2 * d;
  const panel = Math.min(5 / rate, 0.6 / thickest, 0.6 / d) / fine;   // ≤ 5 rad of phase per 12-point panel
  const np = Math.ceil(B / panel), h = B / np;
  const aUniq = [...new Set(a)], ai = a.map(x => aUniq.indexOf(x));
  const J = aUniq.map(() => new Float64Array(K));
  const pairs = [];
  for (let m = 0; m < N; m++) for (let q = m; q < N; q++) pairs.push([m, q, c[m] - c[q]]);
  const acc = pairs.map(() => new Float64Array(K * K));
  // (k+l) even: (−1)^{(k−l)/2} cos;  odd: (−1)^{(k−l+1)/2} sin
  const sgC = new Float64Array(K * K), sgS = new Float64Array(K * K);
  for (let k = 0; k < K; k++) for (let l = 0; l < K; l++) {
    const kl = k - l;
    if ((kl & 1) === 0) sgC[k * K + l] = (kl / 2) & 1 ? -1 : 1; else sgS[k * K + l] = ((kl + 1) / 2) & 1 ? -1 : 1;
  }
  for (let p = 0; p < np; p++) for (let g = 0; g < GL.x.length; g++) {
    const beta = (p + 0.5 + 0.5 * GL.x[g]) * h, wgt = 0.5 * h * GL.w[g] * dG(beta);
    aUniq.forEach((x, i) => besselJ(K, beta * x, J[i]));
    for (let pi = 0; pi < pairs.length; pi++) {
      const [m, q, dd] = pairs[pi];
      const Jm = J[ai[m]], Jq = J[ai[q]], cs = Math.cos(beta * dd) * wgt, sn = Math.sin(beta * dd) * wgt, A = acc[pi];
      for (let k = 0; k < K; k++) {
        const jc = Jm[k] * cs, js = Jm[k] * sn, o = k * K;
        for (let l = 0; l < K; l++) A[o + l] += Jq[l] * (jc * sgC[o + l] + js * sgS[o + l]);
      }
    }
  }
  pairs.forEach(([m, q], pi) => {
    const A = acc[pi], f = Math.PI * a[m] * a[q];
    for (let k = 0; k < K; k++) for (let l = 0; l < K; l++) {
      const v = f * A[k * K + l];
      P[(m * K + k) * n + q * K + l] += v;
      if (q !== m) P[(q * K + l) * n + m * K + k] += v;
    }
  });
  // C/ε0 = Bᵀ P⁻¹ B, B[(m,0), m] = π a_m
  const Bm = new Float64Array(n * N);
  for (let m = 0; m < N; m++) Bm[(m * K) * N + m] = Math.PI * a[m];
  const X = Float64Array.from(Bm);
  cholSolve(P, n, X, N);
  const C = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) C[i][j] = Math.PI * a[i] * X[(i * K) * N + j];
  // symmetrise (round-off)
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const v = (C[i][j] + C[j][i]) / 2; C[i][j] = C[j][i] = v; }
  return { C, nodes: np * GL.x.length };
}

const airStack = (stack) => ({ ...stack, top: 1, below: stack.below.map(l => ({ ...l, er: 1 })), above: (stack.above ?? []).map(l => ({ ...l, er: 1 })) });

// ---------------------------------------------------------------- small dense helpers

function invSym(A) {
  const n = A.length, M = new Float64Array(n * n), X = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { M[i * n + j] = A[i][j]; X[i * n + j] = i === j ? 1 : 0; }
  cholSolve(M, n, X, n);
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => X[i * n + j]));
}
// eigen-decomposition of a symmetric matrix (cyclic Jacobi) → { values, vectors (columns) }
function eigSym(A) {
  const n = A.length, a = A.map(r => [...r]), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-30 * a.reduce((s, r, i) => s + r[i] ** 2, 0)) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < n; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = cs * x - sn * y; a[k][q] = sn * x + cs * y; }
      for (let k = 0; k < n; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = cs * x - sn * y; a[q][k] = sn * x + cs * y; }
      for (let k = 0; k < n; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = cs * x - sn * y; V[k][q] = sn * x + cs * y; }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: V };
}

/**
 * Per-unit-length matrices of N strips in a stack.
 *   strips: [{x, w}] (metres, x = strip centre)   stack: microstrip({h, er}) etc.
 *   opts.order: basis functions per strip (default from the tightest gap)
 * Returns { C, C0, L (SI), epsEff (modal, ascending), order, ms }.
 */
export function solve(strips, stack, opts = {}) {
  checkInput(strips, stack);
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const K = opts.order ?? defaultOrder(strips, stack);
  const unit = Math.min(stack.below[0].t, ...(stack.above ?? []).map(l => l.t));
  const r = capMatrix(strips, stack, K, unit, opts.fine);
  const homogeneous = [...stack.below, ...(stack.above ?? [])].every(l => l.er === stack.below[0].er) && (stack.cover || (stack.top ?? 1) === stack.below[0].er);
  let C0n;
  if (homogeneous) C0n = r.C.map(row => row.map(v => v / stack.below[0].er));
  else C0n = capMatrix(strips, airStack(stack), K, unit, opts.fine).C;
  const C = r.C.map(row => row.map(v => v * EPS0)), C0 = C0n.map(row => row.map(v => v * EPS0));
  const L = invSym(C0n).map(row => row.map(v => v * MU0));
  // modal εeff: eigenvalues of C0⁻¹C, via the symmetric C0^{-1/2} C C0^{-1/2}
  const e0 = eigSym(C0n), N = C.length;
  const S = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => e0.vectors.reduce((s, _, k) => s + e0.vectors[i][k] * e0.vectors[j][k] / Math.sqrt(e0.values[k]), 0)));
  const M = S.map(row => S[0].map((_, j) => row.reduce((s, x, k) => s + x * r.C[k].reduce((t, y, l) => t + y * S[l][j], 0), 0)));
  const epsEff = eigSym(M).values.sort((p, q) => p - q);
  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  return { C, C0, L, epsEff, order: K, nodes: r.nodes, ms };
}

/** Even/odd impedances and εeff of a symmetric pair (from solve() of two equal strips). */
export function evenOdd(res) {
  const { C, C0 } = res;
  const Ce = C[0][0] + C[0][1], Co = C[0][0] - C[0][1], C0e = C0[0][0] + C0[0][1], C0o = C0[0][0] - C0[0][1];
  return {
    Ze: 1 / (C_LIGHT * Math.sqrt(Ce * C0e)), Zo: 1 / (C_LIGHT * Math.sqrt(Co * C0o)),
    epse: Ce / C0e, epso: Co / C0o,
  };
}

/** Single-line Z0 and εeff (from solve() of one strip). */
export function single(res) {
  const c = res.C[0][0], c0 = res.C0[0][0];
  return { Z0: 1 / (C_LIGHT * Math.sqrt(c * c0)), epsEff: c / c0 };
}

const fmtM = (A, unit, scale) => `[${A.map(r => r.map(v => `${+(v * scale).toPrecision(8)}${unit}`).join(' ')).join('; ')}]`;
/** comb-over `cline` body lines: C [...] (pF/m → "p") and L [...] ("n"). */
export function netlistSnippet(res) {
  return `  C ${fmtM(res.C, 'p', 1e12)}      # F/m (Maxwell matrix, field solver)\n  L ${fmtM(res.L, 'n', 1e9)}      # H/m`;
}
