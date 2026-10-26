// Etch tolerance of a finger-loaded coupler (#41, worked example 14 §7): every copper edge of the coupled section moves
// by δ (over-etch δ > 0: the backbones and fingers narrow by 2δ, the gap and the fingers' tip and side gaps widen by 2δ;
// a finger's length from its backbone's edge and the pitch are unchanged). The feeds stay nominal.
//   node tools/etchcheck.mjs gen NETLIST DIR --delta -0.03,-0.015,0.015,0.03 [--fine MM]    one openEMS case per δ (DIR/etch<δ>/)
//   (cd DIR/etch<δ> && $OPENEMS_PYTHON f.py)
//   node tools/etchcheck.mjs cmp DIR [--nominal FILE.s4p]                                  directivity, coupling and match per δ
// The design rules are not applied to the etched copper (an under-etched section breaks them: that is the point).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
import { openemsExport } from '../js/openems.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const r4 = (x) => +x.toFixed(4);

function gen() {
  const [netFile, dir] = rest, src = readFileSync(netFile, 'utf8');
  const nominal = parseNetlist(src), K = nominal.sections.find(s => s.geom?.fingers && s.geom.kind === 'msl2');
  if (!K) throw new Error('etchcheck: needs a finger-loaded pair (cline geom=msl W= S= with a fingers line)');
  const W = K.geom.W * 1e3, S = K.geom.S * 1e3, wf = K.geom.fingers.wf * 1e3;
  const fine = opt('fine') != null ? +opt('fine') : openemsExport(src).info.fine;   // the nominal mesh for every case
  for (const dl of opt('delta', '-0.03,-0.015,0.015,0.03').split(',').map(Number)) {
    const net = src.replace(/(cline \S+ geom=msl W=)\S+( S=)\S+/, `$1${r4(W - 2 * dl)}mm$2${r4(S + 2 * dl)}mm`).replace(/(fingers wf=)\S+/, `$1${r4(wf - 2 * dl)}mm`);
    const d = parseNetlist(net), L = buildLayout({ ...d, layout: { ...d.layout, opts: { ...(d.layout.opts ?? {}), connector: 'none' } } });
    L.errors = [];
    const g = openemsExport(net, { layout: L, excite: '1,2', perm: [4, 3, 2, 1], fine });
    const dd = join(dir, `etch${dl >= 0 ? '+' : ''}${dl}`); mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, 'f.py'), g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'")); writeFileSync(join(dd, 'net.cir'), net);
    console.log(`δ ${dl} mm: W ${r4(W - 2 * dl)} S ${r4(S + 2 * dl)} wf ${r4(wf - 2 * dl)} mm, tip gap ${r4(S + 2 * dl - K.geom.fingers.lf * 1e3)} mm; ${g.info.cells} cells → ${dd}`);
  }
}

function cmp() {
  const [dir] = rest, F = Float64Array.from({ length: 8 }, (_, k) => (1 + k) * 1e9), db = (x, k) => 20 * Math.log10(Math.hypot(x.re[k], x.im[k]));
  const runs = readdirSync(dir).filter(n => /^etch[+-]/.test(n) && existsSync(join(dir, n, 'f.s4p'))).map(n => [+n.slice(4), join(dir, n, 'f.s4p')]);
  if (opt('nominal')) runs.push([0, opt('nominal')]);
  runs.sort((a, b) => a[0] - b[0]);
  console.log('δ (mm)  | directivity at 1 … 8 GHz (dB)                 | S31 at 2 / 5 / 7 GHz    | S11 at 5 GHz');
  for (const [dl, f] of runs) {
    const e = onSweep(readTouchstone(readFileSync(f, 'utf8'), { nPorts: 4, name: 'x' }), F);
    console.log(`${String(dl).padEnd(7)} | ${[...F].map((_, k) => (db(e.S(3, 1), k) - db(e.S(4, 1), k)).toFixed(1).padStart(5)).join('')} | ${[1, 4, 6].map(k => db(e.S(3, 1), k).toFixed(2)).join(' / ')} | ${db(e.S(1, 1), 4).toFixed(1)}`);
  }
}

const fn = { gen, cmp }[cmd];
if (!fn) { console.error('usage: node tools/etchcheck.mjs gen NETLIST DIR [--delta …] | cmp DIR [--nominal FILE]'); process.exit(2); }
fn();
