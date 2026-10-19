// 2-D field solver (issue #11).  Run: node tests/solver.mjs
import { solve, microstrip, stripline, coveredMicrostrip, stripsFromWS, evenOdd, single, netlistSnippet, defaultOrder, EPS0, MU0 } from '../solver/mtl2d.js';
import { msline, mscoupled, ETA0 } from '../js/microstrip.js';
import { parseNetlist } from '../js/netlist.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const rel = (a, b) => Math.abs(a / b - 1);
// worst entry difference, relative to the diagonal of its row
const mdiff = (A, B) => Math.max(...A.flatMap((r, i) => r.map((v, j) => Math.abs(v - B[i][j]) / Math.abs(A[i][i]))));
const Kell = (k) => { let a = 1, b = Math.sqrt(1 - k * k); for (let i = 0; i < 60 && Math.abs(a - b) > 1e-16 * a; i++) { const t = (a + b) / 2; b = Math.sqrt(a * b); a = t; } return Math.PI / (2 * a); };
const kp = (k) => Math.sqrt(1 - k * k);

// ---- exact: zero-thickness centred stripline (Cohn 1954, 1955, conformal mapping) ----
{
  const b = 1e-3, er = 2.2, Zs = ETA0 / 4 / Math.sqrt(er);
  let worst = 0, hi = 0;
  for (const W of [0.1e-3, 0.5e-3, 1e-3, 3e-3]) {
    const Z = Zs * Kell(1 / Math.cosh(Math.PI * W / (2 * b))) / Kell(Math.tanh(Math.PI * W / (2 * b)));
    worst = Math.max(worst, rel(single(solve([{ x: 0, w: W }], stripline({ b, er }))).Z0, Z));
    hi = Math.max(hi, rel(single(solve([{ x: 0, w: W }], stripline({ b, er }), { order: 24 })).Z0, Z));
  }
  check('single stripline Z0 = exact conformal-mapping value (W/b 0.1–3): 1e-6 at the default order', worst < 1e-6, worst);
  check('… and 1e-11 at order 24 (the method converges to the exact answer)', hi < 1e-11, hi);
  worst = 0;
  for (const [W, S] of [[1e-3, 0.05e-3], [1e-3, 0.2e-3], [0.5e-3, 0.5e-3], [0.2e-3, 1e-3], [2e-3, 0.1e-3]]) {
    const kw = Math.tanh(Math.PI * W / (2 * b)), kws = Math.tanh(Math.PI * (W + S) / (2 * b)), ke = kw * kws, ko = kw / kws;
    const eo = evenOdd(solve(stripsFromWS([W, W], S), stripline({ b, er })));
    worst = Math.max(worst, rel(eo.Ze, Zs * Kell(kp(ke)) / Kell(ke)), rel(eo.Zo, Zs * Kell(kp(ko)) / Kell(ko)));
  }
  check('coupled stripline Z0e, Z0o = Cohn\'s exact values (S/b 0.05–1)', worst < 1e-6, worst);
}

// ---- microstrip: closed forms (their own accuracy is the limit) ----
{
  const h = 1e-3;
  let za = 0, ze = 0;
  for (const er of [2.2, 3.66, 9.8]) for (const u of [0.1, 0.3, 1, 3, 10]) {
    const r = single(solve([{ x: 0, w: u * h }], microstrip({ h, er }))), hj = msline({ W: u * h, h, er });
    const ra = single(solve([{ x: 0, w: u * h }], microstrip({ h, er: 1 })));
    za = Math.max(za, rel(ra.Z0, msline({ W: u * h, h, er: 1 }).Z0)); ze = Math.max(ze, rel(r.epsEff, hj.epsEff));
  }
  check('single microstrip in air: Z0 within 0.01 % of Hammerstad–Jensen (their stated accuracy)', za < 1e-4, za);
  check('single microstrip εeff within 0.2 % of Hammerstad–Jensen (their stated accuracy)', ze < 2e-3, ze);
  let w = 0;
  for (const er of [3.66, 9.8]) for (const [u, g] of [[0.5, 0.1], [1, 0.2], [1, 1], [3, 0.5], [0.2, 2], [2, 3]]) {
    const eo = evenOdd(solve(stripsFromWS([u * h, u * h], g * h), microstrip({ h, er }))), kj = mscoupled({ W: u * h, S: g * h, h, er });
    w = Math.max(w, rel(eo.Ze, kj.Ze), rel(eo.Zo, kj.Zo), rel(eo.epse, kj.epse), rel(eo.epso, kj.epso));
  }
  check('coupled microstrip Z0e/Z0o/εe/εo within 1 % of Kirschning–Jansen', w < 0.01, w);
}

// ---- independent N-line check: pulse-basis point matching with the spatial image series ----
function imageMoM(strips, h, er, Ns) {
  const Kc = (er - 1) / (er + 1), terms = [[0, -1]];
  for (let m = 1; Math.abs(Kc) ** (m - 1) > 1e-14 && m < 2000; m++) terms.push([2 * m * h, (-Kc) ** (m - 1) * (1 + Kc)]);
  const segs = [];
  strips.forEach((s, si) => { for (let i = 0; i < Ns; i++) { const a = s.x - s.w / 2 * Math.cos(Math.PI * i / Ns), b = s.x - s.w / 2 * Math.cos(Math.PI * (i + 1) / Ns); segs.push({ a, b, m: (a + b) / 2, si }); } });
  const F = (u, Y) => (Y === 0 ? (u === 0 ? 0 : u * Math.log(Math.abs(u)) - u) : 0.5 * (u * Math.log(u * u + Y * Y) - 2 * u + 2 * Y * Math.atan(u / Y)));
  const n = segs.length, N = strips.length, A = segs.map(si => segs.map(s => { let v = 0; for (const [Y, c] of terms) v += c * (F(s.b - si.m, Y) - F(s.a - si.m, Y)); return v / (Math.PI * (1 + er) * (s.b - s.a)); }));
  const B = segs.map(s => strips.map((_, k) => (s.si === k ? 1 : 0)));
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i;
    [A[k], A[p]] = [A[p], A[k]]; [B[k], B[p]] = [B[p], B[k]];
    for (let i = k + 1; i < n; i++) { const f = A[i][k] / A[k][k]; for (let j = k; j < n; j++) A[i][j] -= f * A[k][j]; for (let j = 0; j < N; j++) B[i][j] -= f * B[k][j]; }
  }
  for (let k = n - 1; k >= 0; k--) for (let j = 0; j < N; j++) { let t = B[k][j]; for (let i = k + 1; i < n; i++) t -= A[k][i] * B[i][j]; B[k][j] = t / A[k][k]; }
  const C = strips.map(() => new Array(N).fill(0));
  segs.forEach((s, i) => { for (let j = 0; j < N; j++) C[s.si][j] += B[i][j] * EPS0; });
  return C;
}
{
  const s = stripsFromWS([0.8e-3, 1.2e-3, 0.8e-3], [0.2e-3, 0.3e-3]), h = 0.508e-3, er = 3.66;
  const C = solve(s, microstrip({ h, er })).C;
  const c1 = imageMoM(s, h, er, 40), c2 = imageMoM(s, h, er, 80);
  const rich = c2.map((r, i) => r.map((v, j) => (4 * v - c1[i][j]) / 3));
  const e = Math.max(...rich.flatMap((r, i) => r.map((v, j) => rel(v, C[i][j]))));
  check('3 unequal lines: every C entry (incl. the small C13) agrees with an independent image-series MoM (Richardson) to 1e-5', e < 1e-5, e);
}

// ---- convergence and numerical hygiene ----
{
  const cases = [
    [stripsFromWS([1e-3, 1e-3, 1e-3], 0.05e-3), microstrip({ h: 0.508e-3, er: 3.66 })],
    [stripsFromWS([5e-3, 5e-3], 0.1e-3), microstrip({ h: 0.1e-3, er: 4.3 })],
    [stripsFromWS([0.3e-3, 2e-3, 0.7e-3], [0.15e-3, 0.4e-3]), microstrip({ h: 0.762e-3, er: 3.48 })],
    [stripsFromWS([1e-3, 1e-3], 0.2e-3), coveredMicrostrip({ h: 0.5e-3, er: 6, hc: 0.3e-3 })],
    [stripsFromWS([0.4e-3, 0.4e-3, 0.4e-3], 0.2e-3), stripline({ b: 1e-3, er: 3, hb: 0.3e-3 })],
  ];
  let eo = 0, eq = 0;
  for (const [s, st] of cases) {
    const r = solve(s, st);
    eo = Math.max(eo, mdiff(solve(s, st, { order: 32 }).C, r.C), mdiff(solve(s, st, { order: 32 }).C0, r.C0));
    eq = Math.max(eq, mdiff(solve(s, st, { fine: 4 }).C, r.C));
  }
  check('default basis order is converged to 2e-6 (vs order 32)', eo < 2e-6, eo);
  check('spectral and spatial quadrature converged to 1e-12 (vs 4× finer)', eq < 1e-12, eq);
  check('default order grows with width/gap', defaultOrder(stripsFromWS([1e-3, 1e-3], 1e-3)) === 6 && defaultOrder(stripsFromWS([1e-3, 1e-3], 0.01e-3)) === 24);
}
{
  const st = microstrip({ h: 0.508e-3, er: 3.66 });
  const s = stripsFromWS([0.6e-3, 1e-3, 0.6e-3], 0.25e-3), r = solve(s, st);
  const mir = solve(s.map(x => ({ x: -x.x, w: x.w })).reverse(), st);
  const shifted = solve(s.map(x => ({ x: x.x + 3e-3, w: x.w })), st);
  check('symmetric geometry gives a centro-symmetric C', Math.abs(r.C[0][0] - r.C[2][2]) < 1e-12 * r.C[0][0] && Math.abs(r.C[0][1] - r.C[1][2]) < 1e-12 * r.C[0][0]);
  check('mirroring and translation leave C unchanged', mdiff(r.C, mir.C) < 1e-12 && mdiff(r.C, shifted.C) < 1e-12);
  check('Maxwell matrix signs: diagonal > 0, off-diagonal < 0, row sums > 0', r.C.every((row, i) => row[i] > 0 && row.every((v, j) => i === j || v < 0) && row.reduce((a, b) => a + b, 0) > 0));
  check('C0 ≤ C entrywise on the diagonal, and modal εeff between 1 and εr', r.C.every((row, i) => row[i] > r.C0[i][i]) && r.epsEff.every(x => x > 1 && x < 3.66));
  const far = solve(stripsFromWS([1e-3, 1e-3], 40e-3), st), one = solve([{ x: 0, w: 1e-3 }], st);
  check('widely spaced lines decouple (C12/C11 < 1e-3, C11 → single line)', -far.C[0][1] / far.C[0][0] < 1e-3 && rel(far.C[0][0], one.C[0][0]) < 1e-3);
  const strip = solve(stripsFromWS([0.4e-3, 0.4e-3, 0.4e-3], 0.2e-3), stripline({ b: 1e-3, er: 3 }));
  const LC = strip.L.map(row => strip.C[0].map((_, j) => row.reduce((a, x, k) => a + x * strip.C[k][j], 0)));
  check('homogeneous stripline: L·C = μ0ε0εr·I', mdiff(LC, LC.map((r, i) => r.map((_, j) => (i === j ? MU0 * EPS0 * 3 : 0)))) < 1e-12);
}

// ---- speed: 10 lines ----
{
  const s = stripsFromWS(Array(10).fill(1e-3), 0.2e-3);
  solve(s, microstrip({ h: 0.508e-3, er: 3.66 }));                   // warm up
  const r = solve(s, microstrip({ h: 0.508e-3, er: 3.66 }));
  console.log(`       (10 lines on 0.508 mm: ${r.ms.toFixed(0)} ms, order ${r.order})`);
  check('10 lines solve in well under a second', r.ms < 1000, r.ms);
}

// ---- into comb-over ----
{
  const r = solve(stripsFromWS([0.8e-3, 1.2e-3, 0.8e-3], [0.2e-3, 0.3e-3]), microstrip({ h: 0.508e-3, er: 3.66 }));
  const text = `.freq 1G 3G 3\nport a\nport b\nport c\nport d\nport e\nport f\ncline T\n${netlistSnippet(r)}\n  len 20mm\n  A a b c\n  B d e f\nend\n`;
  const d = parseNetlist(text), eps = [...d.sections[0].epsEff].sort((p, q) => p - q);
  check('netlist snippet parses as a cline and gives the same modal εeff (6 digits)', eps.every((x, i) => rel(x, r.epsEff[i]) < 2e-6), eps.join() + ' / ' + r.epsEff.join());
}

// ---- input checking ----
{
  const st = microstrip({ h: 1e-3, er: 4 });
  check('overlapping strips are refused', throws(() => solve([{ x: 0, w: 1e-3 }, { x: 0.5e-3, w: 1e-3 }], st), /overlap/));
  check('a stack without a layer on the ground is refused', throws(() => solve([{ x: 0, w: 1e-3 }], { below: [] }), /at least one layer/));
  check('gap count must match', throws(() => stripsFromWS([1, 1, 1], [1]), /need 2 gaps/));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
