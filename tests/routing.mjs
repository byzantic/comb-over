// Orthogonal routing and meanders (issue #37).  Run: node tests/routing.mjs
import { routeOrtho, meander } from '../js/routing.js';
import { polygonArea, pathLength } from '../js/layout.js';
import { makeSubstrate } from '../js/substrates.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { bendLC } from '../js/discontinuities.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) || (console.log('       ', e.message), false); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sub = makeSubstrate('jlc-ro4350b-1.524'), thin = makeSubstrate('jlc-ro4350b-0.762');

// ---- routeOrtho ----
{
  const pts = [[0, 0], [10, 0], [10, 8], [20, 8]], W = 3.3;
  const sq = routeOrtho(pts, { W, sub, name: 'R' }), mt = routeOrtho(pts, { W, mitre: 'opt', sub, name: 'R' });
  check('square corners: copper area = W × centre-line length', near(Math.abs(polygonArea(sq.poly)), W * pathLength(pts), 1e-9), polygonArea(sq.poly));
  const M = bendLC({ W: W / 1e3, h: sub.dielectric.h, er: sub.dielectric.er, mitre: 'opt' }).mitre, c = 2 * M * W;
  check('mitred corners: each cut removes a (2MW)²/2 triangle, M from Douville–James', near(Math.abs(polygonArea(mt.poly)), W * pathLength(pts) - 2 * c * c / 2, 1e-4) && near(mt.mitreCut, c, 1e-12));
  check('netlist: segments between the bend reference planes (W/2 off each corner) + a bend per corner',
    near(sq.segLen.reduce((a, b) => a + b, 0) + sq.bends * W, pathLength(pts), 1e-9) && sq.lines.filter(l => /^bend /.test(l)).length === 2 && mt.lines.every(l => !/^bend/.test(l) || / mitre=opt$/.test(l)));
  const d = parseNetlist(`.freq 1G 4G 4\n.substrate jlc-ro4350b-1.524\nport a\nport b\n${sq.lines.join('\n')}\n`);
  check('the netlist parses: 3 lines, 2 bend blocks', d.sections.length === 3 && d.blocks.filter(b => b.type === 'bend').length === 2);
  const col = routeOrtho([[0, 0], [5, 0], [10, 0], [10, 5]], { W: 1, sub });
  check('collinear points are merged (one bend)', col.bends === 1 && col.pts.length === 3);
  check('a 45° segment is refused', throws(() => routeOrtho([[0, 0], [5, 5]], { W: 1, sub }), /not horizontal or vertical/));
  check('a path that doubles back is refused', throws(() => routeOrtho([[0, 0], [5, 0], [2, 0]], { W: 1, sub }), /doubles back/));
  check('a segment shorter than its two bends need is refused', throws(() => routeOrtho([[0, 0], [5, 0], [5, 2], [10, 2]], { W: 3, sub }), /shorter than its bends need/));
  const z = routeOrtho([[0, 0], [5, 0], [5, 3], [10, 3]], { W: 3, sub });
  check('a segment exactly W long between two bends becomes a wire', z.lines.some(l => /^wire /.test(l)) && z.segLen[1] === 0);
}

// ---- meander ----
{
  const t0 = Date.now();
  const m = meander({ W: 3.3, theta: 180, f0: 2e9, sub, legs: 2 });
  check(`meander: electrical length at f0 = target, bends included (${m.theta.toFixed(6)}°, ${Date.now() - t0} ms)`, near(m.theta, 180, 1e-3));
  check('meander: matched (|S11| < 0.01 at f0) with the ports at the line impedance', m.s11 < 0.01, m.s11);
  check('meander: enters and leaves on y = 0, size = legs × pitch', m.pts[0][1] === 0 && m.pts.at(-1)[1] === 0 && near(m.size[0], 2 * (3.3 + 9.9), 1e-9));
  check('meander: leg coupling estimated (k ≈ 0.01 at a 3W gap), no warning', m.k > 0.001 && m.k < 0.03 && m.warnings.length === 0, m.k);
  // as built = netlist: an independent solve of the generated lines, against a straight line of the same electrical length
  const Z = m.Z0, body = m.lines.join('\n');
  const r = solve(parseNetlist(`.freq 1.6G 2.4G 3\n.ref 2G\n.substrate jlc-ro4350b-1.524\nport a ${Z}\nport b ${Z}\n${body}\n`));
  const s21 = r.S(2, 1), s11 = r.S(1, 1);
  check('meander netlist re-solved: phase 180° at f0 (−180° ≡ 180°); |S21| > 0.99 (line loss)', Math.hypot(s21.re[1], s21.im[1]) > 0.99 && near(Math.abs(Math.atan2(s21.im[1], s21.re[1])) * 180 / Math.PI, 180, 0.01));
  check('meander: |S11| < 0.05 (−26 dB) ±20 % around f0: four mitred bends on a 3.3 mm line', [0, 2].every(k => Math.hypot(s11.re[k], s11.im[k]) < 0.05));
  const tight = meander({ W: 1.7, theta: 180, f0: 2.4e9, sub: thin, legs: 2, gap: 1.7 });
  check('meander: a gap under 2W warns that leg coupling is not modelled', tight.warnings.some(w => /under 2W/.test(w)) && tight.k > m.k);
  check('meander: odd leg counts are refused', throws(() => meander({ W: 1, theta: 90, f0: 2e9, sub, legs: 3 }), /even/));
  check('meander: too many legs for the length is refused', throws(() => meander({ W: 3.3, theta: 90, f0: 2e9, sub, legs: 4 }), /use fewer legs/));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
