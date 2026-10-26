// A coupled-line coupler compensated by capacitors across the gap at each end of the section (#41, worked example 14:
// the comparison with finger loading). The capacitors give the odd mode the extra capacitance that the fingers spread
// along the section.
//   node tools/capcoupler.mjs design [--C 15 --W 1.0059 --S 0.3187 --sub ID]     W, S and Cc for coupling C and low S41, S11 over 4.5–5.5 GHz
//   node tools/capcoupler.mjs gen DIR --W --S --Cc PF [--pad 0.3]                 the openEMS case (the plain coupler's layout + two lumped C)
// The capacitors are ideal (no ESL, no pads beyond the two that hold the lumped element): the best case for the technique.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { buildLayout } from '../js/layout-templates.js';
import { openemsExport } from '../js/openems.js';
import { nm } from './fingerlib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const sub = opt('sub', 'jlc-ro4350b-0.508');

export const capNet = (W, S, Cc, freq = '1G 9G 801') => `.title capacitor-compensated coupled-line coupler
.freq ${freq}
.ref 5G
.substrate ${sub}
port in
port thru
port cpl
port iso
cline K geom=msl W=${W}mm S=${S}mm
  len 90deg
  A in   cpl
  B thru iso
end
Cc1 in cpl ${Cc}p
Cc2 thru iso ${Cc}p
`;

function design() {
  const k = 10 ** (-(+opt('C', 15)) / 20), F = Float64Array.from([4.5e9, 4.75e9, 5e9, 5.25e9, 5.5e9]), mag = (x, i) => Math.hypot(x.re[i], x.im[i]);
  const obj = (x) => { const [W, S, Cc] = x.map(Math.exp); let r; try { r = solve(parseNetlist(capNet(W, S, Cc, '1G 9G 9')), F); } catch { return 1e9; }
    let e = 0; for (let i = 0; i < F.length; i++) e += mag(r.S(4, 1), i) ** 2 + mag(r.S(1, 1), i) ** 2 + 4 * (mag(r.S(3, 1), i) - k) ** 2; return e; };
  let f = nm(obj, [Math.log(+opt('W', 1.0059)), Math.log(+opt('S', 0.3187)), Math.log(0.1)], 500, 0.2); f = nm(obj, f.x, 500, 0.02);
  const [W, S, Cc] = f.x.map(Math.exp);
  console.log(`W ${W.toFixed(4)} mm, S ${S.toFixed(4)} mm, Cc ${Cc.toFixed(4)} pF`);
}

function gen() {
  const dir = rest[0], W = +opt('W'), S = +opt('S'), Cc = +opt('Cc'), pw = +opt('pad', 0.3), pd = 0.2, m = 0.05;
  // the plain coupler's layout at W, S; a pad inside each line's inner edge at each end holds a lumped C across the gap
  const src = readFileSync(new URL('../examples/coupler-15dB-ro4350b.cir', import.meta.url), 'utf8').replace(/^\.param w = \S+/m, `.param w = ${W}mm`).replace(/^\.param s = \S+/m, `.param s = ${S}mm`);
  const d = parseNetlist(src), L = buildLayout({ ...d, layout: { ...d.layout, opts: { ...(d.layout.opts ?? {}), connector: 'none' } } });
  const len = d.sections[0].len * 1e3, e = S / 2, rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  L.parts = [];
  for (const [name, x0] of [['Cc1', m], ['Cc2', len - m - pw]]) {
    L.items.push({ type: 'poly', role: 'part', label: `${name} pad 1`, pts: rect(x0, -e - pd, x0 + pw, -e), width: pd });
    L.items.push({ type: 'poly', role: 'part', label: `${name} pad 2`, pts: rect(x0, e, x0 + pw, e + pd), width: pd });
    L.parts.push({ kind: 'cap', name, C: Cc * 1e-12 });
  }
  // ports 1 and 2 driven: the capacitor pair keeps the coupler's 180° rotation symmetry
  const g = openemsExport(src, { layout: L, excite: '1,2', perm: [4, 3, 2, 1] });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/f.py`, g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'"));
  writeFileSync(`${dir}/compare.cir`, g.compare.replace(/^\.data .*$/m, '.data em f.s4p overlay') + `Cc1 in_k cpl_k ${Cc}p\nCc2 thru_k iso_k ${Cc}p\n`);
  console.log(`section ${len.toFixed(4)} mm; ${g.info.cells} cells, fine ${g.info.fine.toFixed(4)} mm`);
}

const fn = { design, gen }[cmd];
if (!fn) { console.error('usage: node tools/capcoupler.mjs design|gen …'); process.exit(2); }
fn();
