// A finger-loaded coupled-line coupler in openEMS (issue #41, stage 2): the 10 dB coupler's layout with the
// coupled section replaced by a finger-loaded pair, and comb-over's model of it from the extracted C, L.
//   node tools/fingercoupler.mjs gen DIR --fit DESIGN_DIR/CASE [--long DESIGN_DIR/CASE_n14] [--cells 13 --net examples/coupler-10dB-ro4350b.cir]
//   (cd DIR && $OPENEMS_PYTHON f.py)       ports 1 and 2 driven; the 180° rotation gives the rest
//   node tools/fingercoupler.mjs cmp DIR   model against openEMS (and the plain coupler's committed result)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
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
  // the plain coupler's netlist with the backbones' W, gap and the section length
  const geomNet = src.replace(/^\.param w = \S+/m, `.param w = ${c.W}mm`).replace(/^\.param s = \S+/m, `.param s = ${c.G}mm`).replace(/len 90deg/, `len ${len}mm`);
  const d = parseNetlist(geomNet), L = buildLayout({ ...d, layout: { ...d.layout, opts: { ...(d.layout.opts ?? {}), connector: 'none' } } });
  // fingers spliced into each backbone's outline along its inner edge (y = ∓G/2), section from x = 0: one outline
  // per line, as in the extraction (separate rectangles butted against the backbone put an edge inside the copper,
  // and the mesh's thirds rule then placed the backbone edge's lines the wrong way round)
  const h = c.wf / 2, e = c.G / 2, centres = (o) => Array.from({ length: n }, (_, k) => (k + o) * c.p);
  let spliced = 0;
  for (const it of L.items.filter(i => i.role === 'core')) {
    const P = it.pts;
    for (let i = 0; i < P.length; i++) {
      const [a, b] = [P[i], P[(i + 1) % P.length]];
      if (Math.abs(a[1] - b[1]) > 1e-9 || Math.abs(Math.abs(a[1]) - e) > 1e-6) continue;
      const y = a[1], s = Math.sign(-y), up = b[0] > a[0];   // fingers grow towards y = 0
      const cs = centres(y < 0 ? 0.25 : 0.75).sort((u, v) => up ? u - v : v - u), ins = [];
      for (const x of cs) { const [x1, x2] = up ? [x - h, x + h] : [x + h, x - h]; ins.push([r6(x1), y], [r6(x1), r6(y + s * c.lf)], [r6(x2), r6(y + s * c.lf)], [r6(x2), y]); }
      if (!cs.every(x => x - h > Math.min(a[0], b[0]) && x + h < Math.max(a[0], b[0]))) throw new Error('fingers run past the coupled edge');
      P.splice(i + 1, 0, ...ins); spliced++; break;
    }
  }
  if (spliced !== 2) throw new Error(`found ${spliced} inner edges, expected 2`);
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
