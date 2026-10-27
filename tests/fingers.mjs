// Finger-loaded coupled lines (issue #41): geometry, the netlist's fingers line, the coupler layout. Run: node tests/fingers.mjs
import { readFileSync } from 'node:fs';
import { fingerPair, spliceFingers, fingerArray } from '../js/fingers.js';
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

{
  // stage 3: N lines, fingers on every edge that faces a neighbour
  const a = fingerArray({ W: [0.8, 1, 0.8], G: [0.6, 0.6], wf: 0.13, lf: 0.4, p: 1, n: 3 });
  check('fingerArray: 3 lines, outer lines with fingers on the inner edge only, the centre line on both (4 + 4n, 4 + 8n points)', a.polys.map(P => P.length).join() === '16,28,16');
  check('fingerArray: each outline\'s area is its strip plus its fingers', [2.4 + 3 * 0.052, 3 + 6 * 0.052, 2.4 + 3 * 0.052].every((v, i) => Math.abs(Math.abs(area(a.polys[i])) - v) < 1e-9) && a.polys.every(P => area(P) > 0));
  const tipsUp = (P, y) => P.filter(([, yy]) => Math.abs(yy - y) < 1e-9).map(([x]) => +x.toFixed(6));
  const lo2 = a.ybands[1][0], hi2 = a.ybands[1][1];
  check('fingerArray: odd lines at (k + ¼)p, even lines at (k + ¾)p, so both gaps intermesh', Math.min(...tipsUp(a.polys[0], a.ybands[0][1] + 0.4)) === 0.185 && Math.min(...tipsUp(a.polys[1], lo2 - 0.4)) === 0.685 && Math.min(...tipsUp(a.polys[1], hi2 + 0.4)) === 0.685 && Math.min(...tipsUp(a.polys[2], a.ybands[2][0] - 0.4)) === 0.185);
  check('fingerArray: mirror-symmetric about y = 0 (line 1 ↔ line 3)', a.polys[0].every(([x, y]) => a.polys[2].some(([u, v]) => Math.abs(u - x) < 1e-9 && Math.abs(v + y) < 1e-9)));
  check('fingerArray: fingers reaching across a gap are refused, per gap', throws(() => fingerArray({ W: [1, 1, 1], G: [0.6, 0.3], wf: 0.13, lf: [0.4, 0.35], p: 1, n: 2 }), /gap 2/));
}

{
  // stage 3 in the netlist and the coupler3 layout
  const src = readFileSync(new URL('../examples/coupler3-20dB-fingers-ro4350b.cir', import.meta.url), 'utf8'), d = parseNetlist(src), K = d.sections[0];
  check('netlist: three finger-loaded lines take the section\'s C and L as given, the geometry for the layout', K.N === 3 && K.geom.kind === 'mslN' && K.geom.fingers.lfo > 0 && K.C[0][1] < 0 && K.L[0][1] > 0);
  const bad = (from, to, re) => throws(() => parseNetlist(src.replace(from, to)), re);
  check('netlist: N-line fingers without C and L, or reaching across a gap, are refused', bad(/^  C .*\n  L .*\n/m, '', /need the section's C and L/) && bad('lf=0.5423mm', 'lf=0.95mm', /across gap 1/));
  const L = buildLayout(d), lines = L.items.filter(i => i.role === 'core' && /^line/.test(i.label));
  check('coupler3 layout: three outlines with their fingers (6 cells: 6 per facing edge, and with lfo 6 on each outer line\'s outer edge: 12 on every line), no design-rule errors', lines.map(i => i.pts.length).join() === [52, 52, 52].join() && L.errors.length === 0);
  check('coupler3 layout: six ports, the KiCad core carries every finger (36) on six pads in three tie groups', L.items.filter(i => i.type === 'port').length === 6 && L.core.pads.length === 6 && L.core.ties.length === 3 && L.core.pads.flatMap(p => p.polys).filter(P => P.length === 4 && Math.abs(Math.abs(P[1][0] - P[0][0]) - 0.13) < 1e-6).length === 36);
  const ab = parseNetlist(L.netlist);
  check('coupler3 layout: the as-built netlist keeps the section (fingers, C, L) and models the side-by-side run at each end as a coupled 3-line', ab.sections.filter(s => s.N === 3).length === 3 && /fingers wf=0.13mm/.test(L.netlist) && /cline K_ea geom=msl model=field/.test(L.netlist));
  const plain = buildLayout(parseNetlist(readFileSync(new URL('../examples/coupler3-20dB-ro4350b.cir', import.meta.url), 'utf8')));
  check('coupler3 layout: the plain 3-line coupler lays out without fingers or errors', plain.errors.length === 0 && plain.items.filter(i => /^line/.test(i.label ?? '')).every(i => i.pts.length === 4));
  // #61: the outer lines' turns are bends in both netlists and part of the core (so KiCad keeps their shape); square by
  // default, optimally mitred with mitre=opt
  const turnsOf = (Lx) => Lx.items.filter(i => /^turns /.test(i.label ?? ''));
  const inCore = (Lx) => Lx.core.pads.every(p => p.node === 'c' || p.node === 'cb' || p.polys.some(P => turnsOf(Lx).some(t => t.pts === P)));
  const nBends = (txt, m) => (txt.match(new RegExp(`^bend .* mitre=${m}$`, 'gm')) ?? []).length;
  check('coupler3 layout (#61): by default four square turn pairs (one rectangle each: the turns sit at the ends of their straights) on the outer lines\' core pads; the as-built and core netlists carry 8 bends mitre=none', turnsOf(L).length === 4 && turnsOf(L).every(t => t.pts.length === 4) && inCore(L)
    && nBends(L.netlist, 'none') === 8 && nBends(L.core.netlist, 'none') === 8 && parseNetlist(L.core.netlist).ports.length === 6);
  const mt = buildLayout(parseNetlist(src.replace(/^(\.layout coupler3 K.*)$/m, '$1 mitre=opt')));
  check('coupler3 layout (#61): mitre=opt gives optimally mitred turns, in the core and as 8 bends mitre=opt, without design-rule errors', mt.errors.length === 0 && turnsOf(mt).every(t => t.pts.length === 8) && inCore(mt) && nBends(mt.netlist, 'opt') === 8 && nBends(mt.core.netlist, 'opt') === 8);
  check('coupler3 layout (#61): other mitre values are refused', throws(() => buildLayout(parseNetlist(src.replace(/^(\.layout coupler3 K.*)$/m, '$1 mitre=45'))), /mitre=45/));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
