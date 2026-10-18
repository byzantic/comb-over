// Engine tests against closed-form results.  Run: node tests/run.mjs
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { jacobiEig, rMul, rT } from '../js/linalg.js';
import { C0 } from '../js/section.js';

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${info}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const cabs = (r, i) => Math.hypot(r, i);
const run = (txt, ov) => { const d = parseNetlist(txt, ov); return { d, r: solve(d) }; };
const at = (r, i, j, k) => { const s = r.S(i, j); return [s.re[k], s.im[k]]; };

// ---- Jacobi ----
{
  const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]];
  const { d, V } = jacobiEig(A);
  const R = rMul(rMul(V, d.map((x, i) => d.map((_, j) => (i === j ? x : 0)))), rT(V));
  check('jacobi reconstructs A', R.every((r, i) => r.every((x, j) => near(x, A[i][j], 1e-12))));
}

// ---- quarter-wave transformer ----
{
  const { r } = run(`.freq 0.5G 1.5G 3\n.ref 1G\nport a 50\nport b 100\nT1 a b Z0=sqrt(5000) len=90deg`);
  check('λ/4 transformer matched at f0', cabs(...at(r, 1, 1, 1)) < 1e-12);
  check('λ/4 transformer S21 = -j·1 (power)', near(cabs(...at(r, 2, 1, 1)), 1, 1e-12) && near(at(r, 2, 1, 1)[1], -1, 1e-9));
}

// ---- 3 dB coupled-line coupler (homogeneous) ----
{
  const k = Math.SQRT1_2, Ze = 50 * Math.sqrt((1 + k) / (1 - k)), Zo = 50 * Math.sqrt((1 - k) / (1 + k));
  const { r } = run(`.freq 1G 3G 3\nport p1 50\nport p2 50\nport p3 50\nport p4 50
cline K
  Zeo ${Ze} ${Zo}
  er 2.2
  len 90deg
  A p1 p3
  B p2 p4
end`);
  const S = (i, j) => at(r, i, j, 1);
  check('coupler S11 = 0', cabs(...S(1, 1)) < 1e-12);
  check('coupler |S31| = 1/√2', near(cabs(...S(3, 1)), k, 1e-12));
  check('coupler |S21| = 1/√2', near(cabs(...S(2, 1)), k, 1e-12));
  check('coupler isolation S41 = 0', cabs(...S(4, 1)) < 1e-12);
  const ph = (Math.atan2(S(3, 1)[1], S(3, 1)[0]) - Math.atan2(S(2, 1)[1], S(2, 1)[0])) * 180 / Math.PI;
  check('coupler quadrature (90°)', near(((ph % 360) + 360) % 360, 90, 1e-9), ph);
}

// ---- inhomogeneous pair vs even/odd closed form ----
{
  const Ze = 70, Zo = 35, ee = 7.0, eo = 5.5, len = 0.012, Z0 = 50;
  const { r } = run(`.freq 0.3G 6G 41\nport a1\nport b1\nport a2\nport b2
cline P
  Zeo ${Ze} ${Zo} ${ee} ${eo}
  len ${len}
  A a1 a2
  B b1 b2
end`);
  const two = (Z, ef, f) => {
    const th = 2 * Math.PI * f * Math.sqrt(ef) / C0 * len, z = Z / Z0;
    const c = Math.cos(th), s = Math.sin(th);
    // D = 2cos + j(z+1/z) sin
    const Dr = 2 * c, Di = (z + 1 / z) * s, dd = Dr * Dr + Di * Di;
    const s11 = [(0 * Dr + (z - 1 / z) * s * Di) / dd, ((z - 1 / z) * s * Dr - 0 * Di) / dd];
    const s21 = [2 * Dr / dd, -2 * Di / dd];
    return { s11, s21 };
  };
  let maxErr = 0;
  for (let k = 0; k < r.freq.length; k++) {
    const e = two(Ze, ee, r.freq[k]), o = two(Zo, eo, r.freq[k]);
    const want = {
      '11': [(e.s11[0] + o.s11[0]) / 2, (e.s11[1] + o.s11[1]) / 2],
      '21': [(e.s21[0] + o.s21[0]) / 2, (e.s21[1] + o.s21[1]) / 2],
      '31': [(e.s11[0] - o.s11[0]) / 2, (e.s11[1] - o.s11[1]) / 2],
      '41': [(e.s21[0] - o.s21[0]) / 2, (e.s21[1] - o.s21[1]) / 2],
    };
    for (const key of Object.keys(want)) {
      const g = at(r, +key[0], +key[1], k);
      maxErr = Math.max(maxErr, cabs(g[0] - want[key][0], g[1] - want[key][1]));
    }
  }
  check('inhomogeneous pair matches even/odd analysis', maxErr < 1e-8, maxErr);
}

// ---- 3-line general C/L: reciprocity & losslessness; homogeneous parameterisations agree ----
{
  const txt = `.freq 0.1G 5G 25\nport a1\nport b1 30\nport a2 75\nport b2\nport a3\nport b3 100
cline G
  C [150p -40p -8p; -40p 170p -35p; -8p -35p 140p]
  L [380n 110n 50n; 110n 360n 100n; 50n 100n 400n]
  len 23mm
  A a1 a2 a3
  B b1 b2 b3
end`;
  const { r } = run(txt);
  let recip = 0, unit = 0;
  const P = r.P;
  for (let k = 0; k < r.freq.length; k++) {
    for (let i = 1; i <= P; i++) for (let j = 1; j <= P; j++) {
      const a = at(r, i, j, k), b = at(r, j, i, k);
      recip = Math.max(recip, cabs(a[0] - b[0], a[1] - b[1]));
      // (S^H S)_ij
      let sr = 0, si = 0;
      for (let q = 1; q <= P; q++) { const x = at(r, q, i, k), y = at(r, q, j, k); sr += x[0] * y[0] + x[1] * y[1]; si += x[0] * y[1] - x[1] * y[0]; }
      unit = Math.max(unit, cabs(sr - (i === j ? 1 : 0), si));
    }
  }
  check('general 3-line reciprocal', recip < 1e-10, recip);
  check('general 3-line lossless (S^H S = I)', unit < 1e-10, unit);
  const d = parseNetlist(txt);
  check('3 distinct modal velocities', new Set(d.sections[0].v.map(v => v.toPrecision(6))).size === 3);
}
{
  const er = 2.2, eta = 376.730313668 / Math.sqrt(er);
  const cg = [5.1, 4.0, 5.1], cm = [0.9, 0.9];
  const Cn = [[cg[0] + cm[0], -cm[0], 0], [-cm[0], cg[1] + cm[0] + cm[1], -cm[1]], [0, -cm[1], cg[2] + cm[1]]];
  const Y0 = Cn.map(rw => rw.map(x => x / eta));
  const tail = `  er ${er}\n  len 60deg\n  A 0 0 0\n  B p1 p2 p3\nend`;
  const hdr = `.freq 0.5G 2G 7\n.ref 1G\nport p1\nport p2\nport p3\n`;
  const r1 = run(hdr + `cline X\n  Cg ${cg.join(' ')}\n  Cm ${cm.join(' ')}\n${tail}`).r;
  const r2 = run(hdr + `cline X\n  Cn [${Cn.map(r => r.join(' ')).join(';')}]\n${tail}`).r;
  const r3 = run(hdr + `cline X\n  Y0 [${Y0.map(r => r.join(' ')).join(';')}]\n${tail}`).r;
  let e = 0;
  for (let k = 0; k < 7; k++) for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
    const a = at(r1, i, j, k), b = at(r2, i, j, k), c = at(r3, i, j, k);
    e = Math.max(e, cabs(a[0] - b[0], a[1] - b[1]), cabs(a[0] - c[0], a[1] - c[1]));
  }
  check('Cg/Cm, Cn and Y0 forms agree', e < 1e-9, e);
}

// ---- cascade: two half sections == one full section ----
{
  const body = (secs) => `.freq 0.2G 3G 15\nport a1\nport b1\nport a2\nport b2\n` + secs;
  const M = `C [120p -30p; -30p 120p]\n  L [420n 90n; 90n 420n]`;
  const one = run(body(`cline S\n  ${M}\n  len 40mm\n  A a1 a2\n  B b1 b2\nend`)).r;
  const two = run(body(`cline S1\n  ${M}\n  len 15mm\n  A a1 a2\n  B m1 m2\nend\ncline S2\n  ${M}\n  len 25mm\n  A m1 m2\n  B b1 b2\nend`)).r;
  let e = 0;
  for (let k = 0; k < 15; k++) for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) { const a = at(one, i, j, k), b = at(two, i, j, k); e = Math.max(e, cabs(a[0] - b[0], a[1] - b[1])); }
  check('cascaded sections == single section', e < 1e-10, e);
}

// ---- lossy line: attenuation from Q ----
{
  const Q = 200, { r } = run(`.freq 1G 1G 1\n.ref 1G\nport a 50\nport b 50\nT1 a b Z0=50 len=720deg Q=${Q}`);
  const want = Math.exp(-4 * Math.PI / (2 * Q)); // alpha*l = beta*l/(2Q), beta*l = 4π
  check('Q loss: |S21| = exp(-βℓ/2Q)', near(cabs(...at(r, 2, 1, 0)), want, 1e-10));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
