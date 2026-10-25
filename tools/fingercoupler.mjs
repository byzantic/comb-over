// A finger-loaded coupled-line coupler in openEMS (issue #41, stage 2): the 10 dB coupler's layout with the
// coupled section replaced by a finger-loaded pair, and comb-over's model of it from the extracted C, L.
//   node tools/fingercoupler.mjs gen DIR --fit DESIGN_DIR/CASE [--long DESIGN_DIR/CASE_n14] [--cells 13 --net examples/coupler-10dB-ro4350b.cir]
//   (cd DIR && $OPENEMS_PYTHON f.py)       ports 1 and 2 driven; the 180° rotation gives the rest
//   node tools/fingercoupler.mjs cmp DIR [--plain DIR]   model against openEMS, and a plain coupler's (default: the committed 10 dB)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
import { openemsExport } from '../js/openems.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';
import { fitCase, loadCase, bloch, fitZ } from './fingerlib.mjs';

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const r6 = (x) => +x.toFixed(6), m8 = (x) => x.toPrecision(8);

function gen() {
  // the section's C, L: de-embedded from the pair (--long, the same geometry with more cells), else fitted to --fit alone
  const f = opt('long') ? (() => { const b = bloch(opt('long'), opt('fit')); return fitZ(opt('long'), b.ee, b.eo); })() : fitCase(opt('fit'));
  const c = loadCase(opt('fit')).c, n = +opt('cells', 13), len = r6(n * c.p);
  const src = readFileSync(opt('net', 'examples/coupler-10dB-ro4350b.cir'), 'utf8');
  // the plain coupler's netlist with the backbones' W, gap, the section length and a fingers line carrying the
  // extracted modes: the coupler layout template draws the fingers (one outline per line) and the export meshes them
  const modes = f.modes ?? f, fl = `  fingers wf=${c.wf}mm lf=${c.lf}mm p=${c.p}mm Ze=${modes.Ze.toFixed(4)} Zo=${modes.Zo.toFixed(4)} ee=${modes.ee.toFixed(5)} eo=${modes.eo.toFixed(5)}`;
  const net = src.replace(/^\.param w = \S+/m, `.param w = ${c.W}mm`).replace(/^\.param s = \S+/m, `.param s = ${c.G}mm`).replace(/len 90deg/, `len ${len}mm`)
    .replace(/^(cline K .*)$/m, `$1\n${fl}`);
  const g = openemsExport(net, { excite: '1,2', perm: [4, 3, 2, 1] }), fine = g.info.fine;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'f.py'), g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'"));
  writeFileSync(join(dir, 'net.cir'), net);
  writeFileSync(join(dir, 'compare.cir'), g.compare.replace(/^\.data .*$/m, '.data em f.s4p overlay'));
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ ...c, cells: n, len, meshCells: g.info.cells, fine, fit: opt('fit') }));
  console.log(`${n} cells, ${len} mm; mesh ${g.info.cells} cells, fine ${fine.toFixed(4)} mm`);
}

function cmp() {
  const net = readFileSync(join(dir, 'compare.cir'), 'utf8'), d = parseNetlist(net);
  const F = Float64Array.from({ length: 9 }, (_, k) => (1 + k) * 1e9);
  const em = onSweep(readTouchstone(readFileSync(join(dir, 'f.s4p'), 'utf8'), { nPorts: 4, name: 'f' }), F), r = solve(d, F);
  // the plain coupler to compare with: --plain DIR (an openems.mjs --out DIR with its result), else the committed 10 dB one
  const pdir = opt('plain', 'examples/em'), pcf = opt('plain') ? join(pdir, 'compare.cir') : 'examples/em/coupler-10dB-ro4350b-compare.cir';
  const pc = parseNetlist(readFileSync(pcf, 'utf8'));
  const pe = onSweep(readTouchstone(readFileSync(join(pdir, pc.data[0].file), 'utf8'), { nPorts: 4, name: 'p' }), F), pr = solve(pc, F);
  const db = (x, k) => 20 * Math.log10(Math.hypot(x.re[k], x.im[k])), f2 = (v) => v.toFixed(1).padStart(6);
  console.log('GHz   | finger: model / openEMS                         | plain: model / openEMS');
  console.log('      | S31          S41          S11          D        | S31          S41          D');
  for (let k = 0; k < F.length; k++) {
    const D = (s) => db(s.S(3, 1), k) - db(s.S(4, 1), k);
    console.log(`${(F[k] / 1e9).toFixed(0).padStart(4)}  | ${f2(db(r.S(3, 1), k))}/${f2(db(em.S(3, 1), k))} ${f2(db(r.S(4, 1), k))}/${f2(db(em.S(4, 1), k))} ${f2(db(r.S(1, 1), k))}/${f2(db(em.S(1, 1), k))} ${f2(D(r))}/${f2(D(em))} | ${f2(db(pr.S(3, 1), k))}/${f2(db(pe.S(3, 1), k))} ${f2(db(pr.S(4, 1), k))}/${f2(db(pe.S(4, 1), k))} ${f2(D(pr))}/${f2(D(pe))}`);
  }
}

const fn = { gen, cmp }[cmd];
if (!fn || !dir) { console.error('usage: node tools/fingercoupler.mjs gen|cmp DIR [options]'); process.exit(2); }
fn();
