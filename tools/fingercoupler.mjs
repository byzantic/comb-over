// A finger-loaded coupled-line coupler in openEMS (issue #41, stage 2): the 10 dB coupler's layout with the
// coupled section replaced by a finger-loaded pair, and comb-over's model of it from the extracted C, L.
//   node tools/fingercoupler.mjs gen DIR --fit DESIGN_DIR/CASE [--cells 13 --net examples/coupler-10dB-ro4350b.cir]
//   (cd DIR && $OPENEMS_PYTHON f.py)       ports 1 and 2 driven; the 180° rotation gives the rest
//   node tools/fingercoupler.mjs cmp DIR   model against openEMS (and the plain coupler's committed result)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
import { openemsExport } from '../js/openems.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';
import { fitCase } from './fingerlib.mjs';

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const r6 = (x) => +x.toFixed(6), m8 = (x) => x.toPrecision(8);

function gen() {
  const f = fitCase(opt('fit')), c = f.c, n = +opt('cells', 13), len = r6(n * c.p);
  const src = readFileSync(opt('net', 'examples/coupler-10dB-ro4350b.cir'), 'utf8');
  // the plain coupler's netlist with the backbones' W, gap and the section length
  const geomNet = src.replace(/^\.param w = \S+/m, `.param w = ${c.W}mm`).replace(/^\.param s = \S+/m, `.param s = ${c.G}mm`).replace(/len 90deg/, `len ${len}mm`);
  const d = parseNetlist(geomNet), L = buildLayout({ ...d, layout: { ...d.layout, opts: { ...(d.layout.opts ?? {}), connector: 'none' } } });
  // fingers as rectangles on the backbones' inner edges (line 1, in–thru, at y < 0), section from x = 0
  const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], h = c.wf / 2, e = c.G / 2;
  const fingers = [];
  for (let k = 0; k < n; k++) {
    const a = (k + 0.25) * c.p, b = (k + 0.75) * c.p;
    fingers.push({ type: 'poly', role: 'core', pts: rect(r6(a - h), r6(a + h), -e, r6(-e + c.lf)) });
    fingers.push({ type: 'poly', role: 'core', pts: rect(r6(b - h), r6(b + h), r6(e - c.lf), e) });
  }
  L.items.push(...fingers);
  const fine = Math.min(c.wf, c.side, c.tip, Math.abs(c.overlap), c.G) / 3;
  const g = openemsExport(geomNet, { layout: L, fine, excite: '1,2', perm: [4, 3, 2, 1] });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'f.py'), g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'"));
  // comb-over's model: the comparison netlist with the section as the extracted per-length C, L
  const K = `cline K\n  C [${m8(f.C[0][0])} ${m8(f.C[0][1])}; ${m8(f.C[1][0])} ${m8(f.C[1][1])}]\n  L [${m8(f.L[0][0])} ${m8(f.L[0][1])}; ${m8(f.L[1][0])} ${m8(f.L[1][1])}]`;
  const cmp = g.compare.replace(/^cline K .*$/m, K).replace(/^\.data .*$/m, '.data em f.s4p overlay');
  writeFileSync(join(dir, 'compare.cir'), cmp);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ ...c, cells: n, len, meshCells: g.info.cells, fine, fit: opt('fit') }));
  console.log(`${n} cells, ${len} mm; mesh ${g.info.cells} cells, fine ${fine.toFixed(4)} mm`);
}

function cmp() {
  const net = readFileSync(join(dir, 'compare.cir'), 'utf8'), d = parseNetlist(net);
  const F = Float64Array.from({ length: 9 }, (_, k) => (1 + k) * 1e9);
  const em = onSweep(readTouchstone(readFileSync(join(dir, 'f.s4p'), 'utf8'), { nPorts: 4, name: 'f' }), F), r = solve(d, F);
  const pc = parseNetlist(readFileSync('examples/em/coupler-10dB-ro4350b-compare.cir', 'utf8'));
  const pe = onSweep(readTouchstone(readFileSync(`examples/em/${pc.data[0].file}`, 'utf8'), { nPorts: 4, name: 'p' }), F), pr = solve(pc, F);
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
