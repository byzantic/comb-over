// Comb-line and interdigital layout templates (issue #15).  Run: node tests/filter-layout.mjs
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
import { assess } from '../js/synth.js';
import { boardProject } from '../js/kicad.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : (console.log('       ', e.message), true); } };
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const lay = (t) => buildLayout(parseNetlist(t));
// the response shape, lossless (lines and capacitors), as the synthesis judges it
const lossless = (t) => t.replace(/^  geom msl$/mg, '  geom msl\n  Q 1e30').replace(/^(cap .*)$/mg, '$1 Q=1e30');

const COMB = ex('combline-5pole-2g-ro4350b-1524.cir'), IDG = ex('interdigital-3pole-fr4.cir');
const combSpec = { structure: 'comb', type: 'chebyshev', n: 5, ripple: 0.1, f0: 2e9, fbw: 0.1, theta0Deg: 45, Zr: 55, er: 3.66, R0: 50 };
const idgSpec = { structure: 'interdigital', type: 'chebyshev', n: 3, ripple: 0.1, f0: 1.5e9, fbw: 0.1, Zr: 50, er: 4.5, R0: 50 };

for (const [name, text, spec, n, kind] of [['comb-line 5-pole, 1.524 mm RO4350B, 0603', COMB, combSpec, 5, 'comb'], ['interdigital 3-pole, 1.6 mm FR-4', IDG, idgSpec, 3, 'interdigital']]) {
  const L = lay(text);
  check(`${name}: builds DRC clean, no warnings`, L.errors.length === 0 && L.warnings.length === 0, JSON.stringify([L.errors, L.warnings]));
  const short = L.items.filter(i => i.type === 'via' && i.role !== 'part');
  check(`${name}: two shorting vias per line (${n} lines)`, short.length === 2 * n, short.length);
  check(`${name}: resonators, a ground pour on B.Cu, two edge ports`, L.items.filter(i => i.type === 'zone' && i.layer === 'B.Cu').length === 1 && L.items.filter(i => i.type === 'port').length === 2);
  check(`${name}: the part has a pad per line, the tapped lines numbered as the ports, tied to ground (DC-shorted filter)`,
    L.core.pads.length === n && L.core.pads.filter(p => p.node && p.node !== 'GND').length === 2 && L.core.ties.length === 1 && L.core.ties[0].length === 3);
  const nl = L.netlist;
  check(`${name}: as-built netlist: no .layout, a feed line at each tap, tees moved to the inner node`,
    !/^\.layout/m.test(nl) && (nl.match(/^Tt\d_f t\d(_lc)? t\d_k W=[\d.]+mm len=[\d.]+mm/mg) || []).length === 2 && (nl.match(/^tee TJ\d ta\d tb\d t\d_k /mg) || []).length === 2 && /^\.title as built: /m.test(nl));
  check(`${name}: core netlist: feeds are just the 1 mm stubs`, (L.core.netlist.match(/^Tt\d_f .* len=1mm/mg) || []).length === 2);
  // as built ≈ design: the feeds are matched lines, so the shape must not move
  const a = assess({ spec, netlist: lossless(text) }), b = assess({ spec, netlist: lossless(L.netlist) });
  check(`${name}: as built ≈ design: centre within 0.05 %, −3 dB width within 1 %, core RL within 0.5 dB`,
    Math.abs(b.fc / a.fc - 1) < 5e-4 && Math.abs(b.bw3 / a.bw3 - 1) < 0.01 && Math.abs(b.rlCore - a.rlCore) < 0.5, `${a.fc} ${b.fc} ${a.bw3} ${b.bw3} ${a.rlCore} ${b.rlCore}`);
  check(`${name}: layout type ${kind}`, L.type === kind);
}

// ---- comb-line: capacitor parts ----
{
  const L = lay(COMB);
  check('comb: one 0603 part per resonator, at the open end, with a courtyard and two vias each',
    L.parts.length === 5 && L.parts.every(p => p.kind === 'cap' && p.type === 'smd' && p.pkg === '0603' && p.via.n === 2) &&
    L.items.filter(i => i.type === 'courtyard' && /^C\d$/.test(i.name)).length === 5 && L.items.filter(i => i.type === 'via' && i.role === 'part').length === 10);
  check('comb: the outer capacitors connect to the port nets, the inner ones to ground', L.parts.filter(p => p.node !== 'GND').map(p => p.node).sort().join() === 't1,t5');
  // ideal capacitors in the netlist are realised as parts for the same effective capacitance
  const ideal = COMB.replace(/^cap (C\d) (r\d) C=(cl\d) .*$/mg, '$1 $2 0 $3').replace(/^\.layout comb$/m, '.layout comb cap=smd-0603');
  const Li = lay(ideal);
  check('comb, ideal capacitors + cap=smd-0603: realised as 0603 parts, as-built netlist has cap lines', Li.parts.length === 5 && (Li.netlist.match(/^cap C\d r\d C=[\d.]+p type=smd pkg=0603 d=0.3mm n=2 +# realised/mg) || []).length === 5, Li.parts.length);
  const Ld = lay(COMB.replace(/^cap (C\d) (r\d) C=(cl\d) .*$/mg, '$1 $2 0 $3'));
  check('comb, ideal capacitors without cap=: realised as 0603 (the default), with a note giving the nominal values', Ld.parts.length === 5 && Ld.parts.every(p => p.pkg === '0603') && Ld.notes.some(n => /realised as smd 0603 parts.*C1 [\d.]+ pF/.test(n)));
}

// ---- interdigital: the end extensions ----
{
  const L = lay(IDG);
  check('interdigital: no capacitors; the end lines carry their extension (ext1)', L.parts.length === 0 && L.items.filter(i => /^extension/.test(i.label ?? '')).length === 2 && L.notes.some(n => /extends [\d.]+ mm beyond the array/.test(n)));
}

// ---- errors ----
{
  check('.layout interdigital on a comb-line netlist is refused', throws(() => lay(COMB.replace(/^\.layout comb$/m, '.layout interdigital')), /alternate ends/));
  check('.layout comb on an interdigital netlist is refused, naming the right template', throws(() => lay(IDG.replace(/^\.layout interdigital$/m, '.layout comb')), /use \.layout interdigital/));
  check('a line without its via is refused', throws(() => lay(COMB.replace(/^via V3 g3 .*$/m, '')), /line 3/));
  check('a tee wider than its feed is refused', throws(() => lay(COMB.replace(/^tee TJ1 (.*) W2=wf$/m, 'tee TJ1 $1 W2=2mm')), /spans [\d.]+ mm of line but its feed is 2 mm/));
  check('one tap only is refused', throws(() => lay(COMB.replace(/^tee TJ5 .*$/m, 'T5_j ta5 tb5 W=w1 len=2*hw*1deg')), /one tap on each outer line|no feed|port/));
  check('widths given as numbers (not field-solved arrays) are refused', throws(() => lay(`.freq 1G 2G 3\n.substrate jlc-fr4-1.6\n.layout comb\nport a\nport b\nT1 a b Z0=50 len=10mm\n`), /W=\[…\] S=\[…\]/));
}

// ---- KiCad board: capacitor footprints placed, with nets ----
{
  const b = boardProject(lay(COMB), { source: COMB, date: '2026-01-01' }), pcb = b.board, lib = 'COMB_2G00_jlc-ro4350b-1.524';
  const fps = pcb.split(/\n\t\(footprint /).slice(1);
  const caps = fps.filter(f => f.startsWith(`"${lib}:CAP_0603_GND2V"`));
  check('board: five CAP_0603_GND2V footprints from the project library, plus the part and two SMAs', caps.length === 5 && fps.length === 8 && b.files[`${lib}.pretty/CAP_0603_GND2V.kicad_mod`]);
  const val = (i) => +COMB.match(new RegExp(`^\\.param cl${i} = ([\\d.]+)p`, 'm'))[1];
  const want = { C1: val(1), C2: val(2), C3: val(3), C4: val(2), C5: val(1) };
  check('board: references C1…C5, values the nominal capacitances (pF, 3 significant figures)', caps.every(f => { const r = f.match(/"Reference" "(C\d)"/)[1], v = +f.match(/"Value" "([\d.]+)pF"/)[1]; return Math.abs(v - want[r]) < 0.006; }));
  const padNets = (f) => [...f.matchAll(/\(pad "(\d)"[\s\S]*?\(net \d+ "([^"]+)"\)/g)].map(m => `${m[1]}:${m[2]}`);
  const byRef = Object.fromEntries(caps.map(f => [f.match(/"Reference" "(C\d)"/)[1], padNets(f)]));
  check('board: capacitor pad 1 on the resonator net (t1/t5 on the tapped lines, GND inside), pad 2 and its vias on GND',
    byRef.C1.includes('1:t1') && byRef.C5.includes('1:t5') && byRef.C3.includes('1:GND') && Object.values(byRef).every(p => p.filter(x => x.startsWith('2:')).every(x => x === '2:GND')), JSON.stringify(byRef));
  check('board: rotated to point away from the open ends', caps.every(f => /^\(at [-\d.]+ [-\d.]+ (90|270)\)$/.test(f.match(/\(at [^)]*\)/)[0])));
  check('.kicad_dru: courtyard rule for the capacitors (they sit on the RF part by design)', /courtyard_clearance \(min 0mm\)\)\n\t\(severity ignore\)\n\t\(condition "A\.memberOfFootprint\('C\*'\) \|\| B\.memberOfFootprint\('C\*'\)"\)/.test(b.files[`${lib}.kicad_dru`]));
  check('board: as-built netlist written with the feed lines and connectors', /^Tt1_f /m.test(b.files[`${lib}-asbuilt.cir`]));
  const vias = [...pcb.matchAll(/\n\t\(via\n\t\t\(at ([-\d.]+) ([-\d.]+)\)/g)].map(m => [+m[1], +m[2]]);
  check('board: stitching/fence vias, most of them in the ring round the part (via fence)', vias.length >= 20 && new Set(vias.map(v => v[1].toFixed(2))).size < vias.length * 0.6, vias.length);
  check('board is deterministic', boardProject(lay(COMB), { source: COMB, date: '2026-01-01' }).board === pcb);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
