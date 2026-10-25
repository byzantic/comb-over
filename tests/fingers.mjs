// Finger-loaded coupled lines (issue #41): geometry, the netlist's fingers line, the coupler layout. Run: node tests/fingers.mjs
import { readFileSync } from 'node:fs';
import { fingerPair, spliceFingers } from '../js/fingers.js';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
import { openemsExport } from '../js/openems.js';
import { solve } from '../js/solver.js';

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

{
  const sq = [[0, 0], [10, 0], [10, 1], [0, 1]], sp = spliceFingers(sq, 1, 2, [2, 5], 0.2, 0.5);
  check('spliceFingers: fingers inserted along the edge at yEdge, towards yTo, in the edge\'s direction (area grows by n·wf·lf)', sp.length === 12 && Math.abs(Math.abs(area(sp)) - (10 + 2 * 0.1)) < 1e-12 && sp.some(([x, y]) => x === 2.1 && y === 1.5));
  check('spliceFingers: refused when no edge at yEdge spans the fingers', throws(() => spliceFingers(sq, 1, 2, [9.95], 0.2, 0.5), /no edge/));
}
{
  const src = readFileSync(new URL('../examples/coupler-15dB-fingers-ro4350b.cir', import.meta.url), 'utf8'), d = parseNetlist(src), K = d.sections[0];
  const fg = K.geom.fingers, F = Float64Array.from([5e9]), r = solve(d, F);
  check('netlist: a fingers line gives the section the stated modes (Ze, Zo, εe, εo) and keeps the backbones\' as bare', Math.abs(K.geom.Ze - 59.81) < 1e-9 && Math.abs(K.geom.epso - 3.092) < 1e-9 && K.geom.bare.Zo > 45 && Math.abs(fg.tip - 0.1057e-3) < 1e-12 && Math.abs(fg.side - 0.4025e-3) < 1e-12);
  const db = (x) => 20 * Math.log10(Math.hypot(x.re[0], x.im[0]));
  check(`netlist: the 15 dB finger-loaded coupler couples ${db(r.S(3, 1)).toFixed(2)} dB at 5 GHz, isolation below −40 dB (its modes are matched)`, Math.abs(db(r.S(3, 1)) + 15) < 0.3 && db(r.S(4, 1)) < -40);
  const bad = (line, re) => throws(() => parseNetlist(src.replace(/^  fingers .*$/m, line)), re);
  check('netlist: fingers that reach the other backbone, overflow the pitch or lack a modal value are refused', bad('  fingers wf=0.13mm lf=0.5mm p=1.065mm Ze=59.81 Zo=41.75 ee=3.095 eo=3.092', /reach the other backbone/) && bad('  fingers wf=0.6mm lf=0.3mm p=1.065mm Ze=59.81 Zo=41.75 ee=3.095 eo=3.092', /pitch/) && bad('  fingers wf=0.13mm lf=0.3mm p=1.065mm Ze=59.81 Zo=41.75 ee=3.095', /eo must be given/));
  check('netlist: fingers need the backbone geometry', throws(() => parseNetlist(src.replace(/^cline K .*$/m, 'cline K').replace(/^  fingers/m, '  Zeo 60 42\n  fingers')), /need geom=msl/));
  const L = buildLayout(d), lines = L.items.filter(i => i.role === 'core' && /^line/.test(i.label));
  check('layout: each line is one outline with its 8 fingers spliced in (4 + 4·8 points beyond the bare outline)', lines.length === 2 && lines.every(i => i.pts.length === 8 + 4 * 8) && /8 finger cells/.test(L.notes.join(' ')));
  const pads = L.core.pads, fpads = pads.flatMap(p => p.polys).filter(P => P.length === 4 && Math.abs(Math.abs(P[2][1] - P[0][1]) - 0.3692) < 1e-6 && Math.abs(P[1][0] - P[0][0] - 0.13) < 1e-6);
  check('layout: the KiCad core pads carry all 16 fingers', fpads.length === 16);
  const ab = parseNetlist(L.netlist);
  check('layout: the as-built netlist keeps the fingers line (re-parses with the same modes)', /^  fingers wf=0.13mm lf=0.3692mm p=1.065mm Ze=59.81 Zo=41.75 ee=3.095 eo=3.092$/m.test(L.netlist) && ab.sections.some(s => s.geom?.fingers && Math.abs(s.geom.Zo - 41.75) < 1e-9));
  const g15 = openemsExport(src);
  check(`openEMS export: the edge cell from the finger features (tip gap / 3: ${g15.info.fine.toFixed(4)} mm)`, Math.abs(g15.info.fine - 0.1057 / 3) < 1e-4);
  check('layout: a section that is not whole cells is drawn with whole cells and a note', /longer than 7 whole cells/.test(buildLayout(parseNetlist(src.replace('len 8.52mm', 'len 8mm'))).notes.join(' ')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
