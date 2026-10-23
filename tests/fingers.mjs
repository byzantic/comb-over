// Finger-loaded coupled lines (issue #41): geometry. Run: node tests/fingers.mjs
import { fingerPair } from '../js/fingers.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const area = (P) => P.reduce((s, q, k) => { const r = P[(k + 1) % P.length]; return s + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;

const g = fingerPair({ W: 0.6, G: 1, wf: 0.2, lf: 0.7, p: 0.8, n: 12 });
check('derived gaps: overlap 2 lf − G, side gap p/2 − wf, tip gap G − lf', Math.abs(g.overlap - 0.4) < 1e-12 && Math.abs(g.side - 0.2) < 1e-12 && Math.abs(g.tip - 0.3) < 1e-12);
check('section length n·p', Math.abs(g.len - 9.6) < 1e-12);
check('each comb is one counter-clockwise polygon: backbone + n fingers (area W·len + n·wf·lf)', g.polys.every(P => area(P) > 0 && Math.abs(area(P) - (0.6 * 9.6 + 12 * 0.2 * 0.7)) < 1e-9 && P.length === 4 + 4 * 12));
const tips = (P, sgn) => P.filter(([, y]) => Math.abs(y - sgn * (-0.5 + 0.7)) < 1e-12).map(([x]) => x);
const x1 = tips(g.polys[0], 1), x2 = tips(g.polys[1], -1);
check('fingers intermesh: line 1 at (k + ¼)p, line 2 at (k + ¾)p, no finger of one line within the other\'s', x1.length === 24 && x2.length === 24 && Math.min(...x1) > 0 && Math.abs(Math.min(...x1) - 0.1) < 1e-12 && Math.abs(Math.min(...x2) - 0.5) < 1e-12);
check('mirror image: line 2 is line 1 reflected in y and shifted half a pitch', Math.abs(area(g.polys[1]) - area(g.polys[0])) < 1e-12);
check('fingers that do not fit the pitch, or reach the other backbone, are refused', throws(() => fingerPair({ W: 0.6, G: 1, wf: 0.4, lf: 0.7, p: 0.8, n: 2 }), /pitch/) && throws(() => fingerPair({ W: 0.6, G: 1, wf: 0.2, lf: 1, p: 0.8, n: 2 }), /other backbone/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
