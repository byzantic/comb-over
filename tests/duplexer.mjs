// Duplexer: netlist merging, manifold, layout, KiCad (issue #40).  Run: node tests/duplexer.mjs
import { readFileSync } from 'node:fs';
import { tagNetlist } from '../js/duplexer.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { buildLayout } from '../js/layout-templates.js';
import { boardProject } from '../js/kicad.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) || (console.log('       ', e.message), false); } };
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const db = (r, i, j, k) => { const s = r.S(i, j); return 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); };

// ---- tagNetlist: a filter renamed and merged keeps its response, whatever the host netlist's .ref ----
{
  const src = ex('interdigital-3pole-fr4.cir');                 // .ref 1.5G, field-solved array, tees, vias, extensions
  const t = tagNetlist(src, 'X', { input: 'inx', fref: 1.5e9 });
  check('tagging: ports mapped (input → the given node, output suffixed), parameters suffixed, tune ranges dropped',
    t.ports[0] === 'inx' && t.ports[1] === 't3_X' && t.params.every(p => /^\.param \w+_X = /.test(p) && !/tune/.test(p)));
  check('tagging: sections pinned to their own f0; element and node names suffixed; ground and open untouched',
    t.body.filter(l => /^  f0 1500000000$/.test(l)).length === 3 && t.body.some(l => /^tee TJ1_X ta1_X tb1_X inx /.test(l)) && t.body.some(l => /^via V1_X g1_X d=/.test(l)) && t.body.some(l => /^T1_ext_X r1_X - W=w1_X len=ext1_X f0=1500000000$/.test(l)));
  const host = ['.freq 1.2G 1.8G 7', '.ref 3G', '.substrate jlc-fr4-1.6', ...t.params, 'port inx 50', 'port t3_X 50', ...t.body].join('\n') + '\n';
  const a = solve(parseNetlist(src.replace(/^\.freq .*$/m, '.freq 1.2G 1.8G 7'))), b = solve(parseNetlist(host));
  let worst = 0; for (let k = 0; k < 7; k++) for (const [i, j] of [[1, 1], [2, 1]]) worst = Math.max(worst, Math.abs(db(a, i, j, k) - db(b, i, j, k)));
  check('tagged filter in a host with another .ref: S11 and S21 identical to the original (1e-9 dB)', worst < 1e-9, worst);
  check('tagging refuses lines it cannot merge', throws(() => tagNetlist('.freq 1G 2G 3\nport a\nfoo bar baz\n', 'X'), /cannot merge/));
}

// ---- the example duplexer ----
{
  const text = ex('duplexer-2g30-2g53-ro4350b-1524.cir'), d = parseNetlist(text);
  check('duplexer netlist: three ports (antenna, A, B), the manifold tee and two mitred bends, both filters, .layout duplexer',
    d.ports.map(p => p.node).join() === 'ant,t5_A,t5_B' && d.blocks.some(b => b.type === 'tee' && b.name === 'TJM') && d.blocks.filter(b => b.type === 'bend').length === 2 && d.sections.filter(s => /_A$/.test(s.name)).length >= 3 && d.sections.filter(s => /_B$/.test(s.name)).length >= 3 && d.layout?.type === 'duplexer');
  const F = Float64Array.from({ length: 451 }, (_, k) => 2.2e9 + k * 1e6), r = solve(d, F), at = (f) => F.findIndex(v => v >= f - 1);
  const worst = (fn, a, b) => { let m = -Infinity; for (let k = at(a); k <= at(b); k++) m = Math.max(m, fn(k)); return m; };
  const isoA = -worst(k => db(r, 3, 2, k), 2.2545e9, 2.3465e9), isoB = -worst(k => db(r, 3, 2, k), 2.4799e9, 2.5811e9);
  check(`isolation between the filter ports ≥ 40 dB (the spec) over each ripple band (${isoA.toFixed(1)} / ${isoB.toFixed(1)} dB)`, isoA >= 40 && isoB >= 40);
  const rlA = -worst(k => db(r, 1, 1, k), 2.2591e9, 2.3419e9), rlB = -worst(k => db(r, 1, 1, k), 2.4900e9, 2.5710e9);
  check(`antenna return loss ≥ 15 dB over the central 80 % of each band (${rlA.toFixed(2)} / ${rlB.toFixed(2)} dB)`, rlA >= 15 && rlB >= 15);
  check('each band reaches its own port (S21 at 2.30 GHz and S31 at 2.53 GHz better than −4 dB, with loss) and not the other (< −40 dB)', db(r, 2, 1, at(2.3e9)) > -4 && db(r, 3, 1, at(2.53e9)) > -4 && db(r, 3, 1, at(2.3e9)) < -40 && db(r, 2, 1, at(2.53e9)) < -40);
  const L = buildLayout(d);
  check('layout: DRC clean, no warnings; one part with a single net tie (ant, outputs, GND)', L.errors.length === 0 && L.warnings.length === 0 && L.core.ties.length === 1 && ['1', '2', '3', '4'].every(n => L.core.ties[0].includes(n)), JSON.stringify([L.errors, L.warnings]));
  check('layout: three edge ports (antenna on the left, A and B on the right)', (() => { const p = L.items.filter(i => i.type === 'port'); const ant = p.find(x => x.name === 'ant'); return p.length === 3 && p.filter(x => x.name !== 'ant').every(x => x.x > ant.x && x.dir[0] === 1) && ant.dir[0] === -1; })());
  check('layout: a filter whose tap would face away from the manifold is mirrored', L.notes.some(n => /mirrored top to bottom/.test(n)));
  const rb = solve(parseNetlist(L.netlist), F);
  const dd = Math.max(...[[2, 1, 2.3e9], [3, 1, 2.53e9]].map(([i, j, f]) => Math.abs(db(r, i, j, at(f)) - db(rb, i, j, at(f)))));
  const isoAb = -worst(k => db(rb, 3, 2, k), 2.2545e9, 2.3465e9);
  check('as built ≈ design: passband S21/S31 within 0.1 dB, isolation within 1 dB', dd < 0.1 && Math.abs(isoAb - isoA) < 1, `${dd} ${isoAb} ${isoA}`);
  const b = boardProject(L, { source: text, date: '2026-01-01' });
  check('KiCad board: three SMA footprints, nets ant/t5_A/t5_B/GND, fence vias', (b.board.match(/SMA_Amphenol_132289/g) || []).length >= 3 && ['ant', 't5_A', 't5_B', 'GND'].every(n => b.board.includes(`"${n}"`)) && (b.board.match(/\n\t\(via\n/g) || []).length >= 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
