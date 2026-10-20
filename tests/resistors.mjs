// Chip resistors: model, netlist element, footprints (issue #37).  Run: node tests/resistors.mjs
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { resGeometry, RES_PACKAGES } from '../js/resistors.js';
import { resFootprint } from '../js/kicad.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const err = (t) => { try { parseNetlist(t); return ''; } catch (e) { return e.message; } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const mag = (r, i, j, k) => { const s = r.S(i, j); return Math.hypot(s.re[k], s.im[k]); };
const hdr = '.freq 10M 3G 3\n.substrate jlc-ro4350b-0.762\n';

{
  const ideal = solve(parseNetlist(`${hdr}port a\nport b\nres R1 a b R=100 pkg=ideal\n`));
  check('pkg=ideal: a plain 100 Ω between 50 Ω ports, S21 = 2Z0/(2Z0 + R) = 0.5', near(mag(ideal, 2, 1, 0), 0.5, 1e-12) && near(mag(ideal, 2, 1, 2), 0.5, 1e-12));
  const r = solve(parseNetlist(`${hdr}port a\nport b\nres R1 a b R=100 pkg=0402\n`));
  check('0402 in series: equals the ideal at 10 MHz, departs by 3 GHz (pads, ESL, cp)', near(mag(r, 2, 1, 0), 0.5, 1e-4) && Math.abs(mag(r, 2, 1, 2) - 0.5) > 1e-3);
  check('reciprocal', near(r.S(2, 1).re[2], r.S(1, 2).re[2], 1e-12) && near(r.S(2, 1).im[2], r.S(1, 2).im[2], 1e-12));
  const t = solve(parseNetlist(`${hdr}port a\nres T a R=50 pkg=0603\n`));
  check('0603 50 Ω termination through vias: matched at 10 MHz (|S11| < 1e-3), worse but < −20 dB at 3 GHz', mag(t, 1, 1, 0) < 1e-3 && mag(t, 1, 1, 2) > 1e-2 && mag(t, 1, 1, 2) < 0.1, mag(t, 1, 1, 2));
  const d = parseNetlist(`${hdr}port a\nres T a R=50 pkg=0603 n=3 esl=0.3n cp=0\n`);
  check('options: esl=, cp=0 (no body C), n= vias; the element info is recorded', d.resistors[0].esl === 0.3e-9 && d.resistors[0].cp === 0 && d.resistors[0].via.n === 3 && d.resistors[0].ground);
}
{
  check('errors: R missing, unknown package, unknown option, no substrate',
    /R= \(> 0\)/.test(err(`${hdr}port a\nres T a pkg=0603\n`)) && /unknown resistor package 1206/.test(err(`${hdr}port a\nres T a R=50 pkg=1206\n`)) &&
    /unknown res option q/.test(err(`${hdr}port a\nres T a R=50 Q=3\n`)) && /needs a \.substrate/.test(err('.freq 1G 2G 3\nport a\nres T a R=50\n')));
  check('pkg=ideal needs no substrate', err('.freq 1G 2G 3\nport a\nres T a R=50 pkg=ideal\n') === '');
}
{
  for (const pkg of Object.keys(RES_PACKAGES)) {
    const g = resGeometry({ pkg }), p = RES_PACKAGES[pkg].pads;
    const cx = (poly) => (Math.min(...poly.map(q => q[0])) + Math.max(...poly.map(q => q[0]))) / 2;
    check(`${pkg} series geometry: pads at ±${p.x} mm, ${p.l} × ${p.w} mm (KiCad ${RES_PACKAGES[pkg].kicad})`, near(cx(g.hot[0]), -p.x, 1e-12) && near(cx(g.cold[0]), p.x, 1e-12) && g.vias.length === 0);
  }
  const s = resFootprint({ pkg: '0603' }), gr = resFootprint({ pkg: '0402', ground: true, via: { d: 0.3, n: 2 } });
  check('series footprint: two roundrect pads, no vias', (s.text.match(/\(pad "[12]" smd roundrect/g) || []).length === 2 && !/thru_hole/.test(s.text) && s.name === 'RES_0603');
  check('termination footprint: pads 1, 2, a ground land and 2 vias on pad 2', gr.name === 'RES_0402_GND2V' && (gr.text.match(/\(pad "2" thru_hole/g) || []).length === 2 && (gr.text.match(/\(pad "2" smd rect/g) || []).length === 1);
  const emb = resFootprint({ pkg: '0603', lib: 'L', embed: { at: [1, 2], rot: 90 }, nets: { hot: [3, 'a'], gnd: [4, 'b'] }, ref: 'R1', value: '100' });
  check('embedded: library-qualified, placed, nets on both pads', /\(footprint "L:RES_0603"/.test(emb.text) && /\(at 1 2 90\)/.test(emb.text) && /\(net 3 "a"\)/.test(emb.text) && /\(net 4 "b"\)/.test(emb.text) && /"Reference" "R1"/.test(emb.text));
  check('deterministic', resFootprint({ pkg: '0603' }).text === s.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
