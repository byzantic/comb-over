// openEMS export (issue #16): the generated model and the comparison netlist, without running openEMS.
// Run: node tests/openems.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openemsExport } from '../js/openems.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) || (console.log('       ', e.message), false); } };
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const val = (script, name) => JSON.parse(script.match(new RegExp(`^${name} = (.*)$`, 'm'))[1]);

{
  const g = openemsExport(ex('coupler-10dB-ro4350b.cir'));
  const P = val(g.script, 'PORTS'), X = val(g.script, 'X'), Y = val(g.script, 'Y'), Z = val(g.script, 'Z');
  check('coupler: four MSL ports, one per feed, along x, measurement planes max(3 mm, 2 W) in', P.length === 4 && P.every(p => p.dir === 'x' && p.Lp === 3));
  check('coupler: ports from the strip (start, z = h; openEMS draws the port strip there) to the ground (stop, z = 0), across the feed width', P.every(p => p.start[2] === 0.508 && p.stop[2] === 0 && Math.abs(Math.abs(p.stop[1] - p.start[1]) - 1.073) < 1e-3));
  check('mesh: monotonic; a line on both sides of each coupled-strip edge (the 0.1025 mm gap resolved)', [X, Y, Z].every(a => a.every((v, i) => i === 0 || v > a[i - 1])) && Y.filter(y => y > -0.06 && y < 0.06).length >= 2);
  { const f = g.info.fine, near = (v) => Y.some(y => Math.abs(y - v) < 1e-5);
    check('mesh: thirds rule at the gap edges (y = ±0.05125): a line fine/3 inside the metal, one 2·fine/3 into the gap, none on the edge', [1, -1].every(sg => near(sg * (0.05125 + f / 3)) && near(sg * (0.05125 - 2 * f / 3)) && !near(sg * 0.05125))); }
  check('mesh: steps at most λ/20 in the substrate at fmax', [X, Y].every(a => a.every((v, i) => i === 0 || v - a[i - 1] <= g.info.maxStep + 1e-6)));
  const dz = (i) => Z[i + 1] - Z[i], ih = Z.findIndex(z => Math.abs(z - 0.508) < 1e-9);
  check('mesh z: a line on the strip plane, graded from `fine` either side, at most h/4 in the substrate, air to above 9 h', ih > 0 && Math.abs(dz(ih) - g.info.fine) < 1e-6 && Math.abs(dz(ih - 1) - g.info.fine) < 1e-6 && Z.slice(0, ih + 1).every((z, i) => i === 0 || z - Z[i - 1] <= 0.127 + 1e-6) && Z.at(-1) > 9 * 0.508);
  check('boundaries: PML on every open side, PEC ground', JSON.stringify(g.info.bc) === JSON.stringify(['PML_8', 'PML_8', 'PML_8', 'PML_8', 'PEC', 'PML_8']));
  check('each port: the domain edge on the feed end, 12 uniform cells (Lp/20), the feed on the 10th line — outside the 8-cell PML', P.every(p => { const e = p.start[0], s = Math.sign(p.stop[0] - p.start[0]), i0 = X.findIndex(x => Math.abs(x - e) < 1e-6); if (i0 !== 0 && i0 !== X.length - 1) return false; const run = Array.from({ length: 13 }, (_, k) => X[i0 + s * k]); return run.every((x, k) => Math.abs(Math.abs(x - e) - k * p.Lp / 20) < 1e-5) && Math.abs(p.feed - 10 * p.Lp / 20) < 1e-6; }));
  check('ports terminated in their impedance (Feed_R), so the DC-isolated strips discharge and the energy decays', /Feed_R=p\['z'\]/.test(g.script) && P.every(p => p.z === 50));
  check('the script compiles (python3 -m py_compile)', (() => { const dir = mkdtempSync(join(tmpdir(), 'oems-')), f = join(dir, 'm.py'); writeFileSync(f, g.script); const r = spawnSync('python3', ['-m', 'py_compile', f]); return r.status === 0; })());
  // the comparison netlist: the as-built feeds shortened by Lp — same as the core netlist with feeds of the remaining length
  const d = parseNetlist(g.compare);
  check('comparison netlist: no connectors, the feeds shortened to the measurement planes, the openEMS result overlaid', !/_sma|_pad /.test(g.compare) && (g.compare.match(/^T\w+_f .* len=6\.8226mm$/mg) || []).length === 4 && d.data?.length === 1 && d.data[0].overlay);
}
{
  const g = openemsExport(ex('wilkinson-2g4-ro4350b-1524.cir'));
  const Lm = val(g.script, 'LUMPED');
  check('Wilkinson: the isolation resistor as a plain lumped R across the gap (no ESL on either side) (its pads\' facing edges), along y', Lm.length === 1 && Lm[0].R > 50 && Lm[0].R < 100 && Lm[0].L === undefined && /^res .* esl=0 cp=0$/m.test(g.compare) && Lm[0].ny === 1 && Lm[0].start[1] < 0 && Lm[0].stop[1] > 0);
}
{
  const g = openemsExport(ex('combline-5pole-2g-ro4350b-1524.cir'));
  check('comb-line: grounding vias as cylinders (10 shorting + 10 under the capacitors), five lumped capacitors', val(g.script, 'VIAS').length === 20 && val(g.script, 'LUMPED').filter(l => l.C > 0).length === 5);
}
{
  const g = openemsExport(ex('coupler-10dB-ro4350b.cir'), { lossless: true });
  check('lossless: PEC copper and no dielectric loss in openEMS; Q → ∞ on every comb-over line', /^LOSSLESS = True$/m.test(g.script) && /KAPPA = .*, 0$/m.test(g.script) && /^cline K .*\n  Q 1e30$/m.test(g.compare) && g.compare.split('\n').filter(l => /^T/.test(l)).every(l => / Q=1e30$/.test(l)));
  check('the excitation has no DC (a soft source with net charge leaves it trapped and the energy never decays)', /SetCustomExcite\('\(cos\(2\*pi\*.*\)-%.17g\)\*exp/.test(g.script) && /k = np\.exp\(-\(1\.5 \* f0 \/ fc\) \*\* 2\)/.test(g.script));
}
{
  // the committed full-wave result (worked example 13) against comb-over's as-built model at the same planes
  const { readTouchstone, onSweep } = await import('../js/touchstone.js');
  const cmp = readFileSync(new URL('../examples/em/coupler-10dB-ro4350b-compare.cir', import.meta.url), 'utf8'), d = parseNetlist(cmp);
  const ds = readTouchstone(readFileSync(new URL(`../examples/em/${d.data[0].file}`, import.meta.url), 'utf8'), { nPorts: 4, name: d.data[0].file });
  const F = Float64Array.from({ length: 11 }, (_, k) => 1e9 + k * 0.5e9), r = solve(d, F), em = onSweep(ds, F);
  const db = (x, k) => 20 * Math.log10(Math.hypot(x.re[k], x.im[k]));
  const worst = Math.max(...Array.from(F, (_, k) => Math.abs(db(r.S(3, 1), k) - db(em.S(3, 1), k))));
  check(`openEMS (committed result): comb-over's coupling within 0.35 dB of full wave over 1–6 GHz (worst ${worst.toFixed(2)} dB)`, worst < 0.35);
  const wc = readFileSync(new URL('../examples/em/wilkinson-2g4-ro4350b-1524-compare.cir', import.meta.url), 'utf8');
  check('the committed Wilkinson comparison netlist is the export\'s', wc.replace(/^\.data .*$/m, '') === openemsExport(ex('wilkinson-2g4-ro4350b-1524.cir')).compare.replace(/^\.data .*$/m, ''));
  {
    const dw = parseNetlist(wc), fw = dw.data[0].file;
    const dsw = readTouchstone(readFileSync(new URL(`../examples/em/${fw}`, import.meta.url), 'utf8'), { nPorts: 3, name: fw });
    const Fw = Float64Array.from({ length: 13 }, (_, k) => 2.16e9 + k * 0.04e9), e = onSweep(dsw, Fw);
    const w = (i, j) => Math.max(...Array.from(Fw, (_, k) => db(e.S(i, j), k)));
    check(`openEMS (committed): the trimmed Wilkinson meets 20 dB over ±10 % (S11 ${w(1, 1).toFixed(2)}, S22 ${w(2, 2).toFixed(2)}, S33 ${w(3, 3).toFixed(2)}, S32 ${w(3, 2).toFixed(2)} dB)`, w(1, 1) < -20 && w(2, 2) < -20 && w(3, 3) < -20 && w(3, 2) < -20);
  }
  check('the comparison netlist is the export\'s, with the committed result\'s name', cmp.replace(/^\.data .*$/m, '') === openemsExport(ex('coupler-10dB-ro4350b.cir')).compare.replace(/^\.data .*$/m, ''));
}
check('a netlist without .layout is refused', throws(() => openemsExport(ex('combline-4pole.cir')), /needs a \.layout/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
