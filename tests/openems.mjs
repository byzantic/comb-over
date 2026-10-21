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
  check('mesh: steps at most λ/20 in the substrate at fmax', [X, Y].every(a => a.every((v, i) => i === 0 || v - a[i - 1] <= g.info.maxStep + 1e-6)));
  check('mesh: four cells through the substrate, then graded air', Z.filter(z => z <= 0.508 + 1e-9).length === 5 && Z.at(-1) > 9 * 0.508);
  check('boundaries: PML on every open side, PEC ground', JSON.stringify(g.info.bc) === JSON.stringify(['PML_8', 'PML_8', 'PML_8', 'PML_8', 'PEC', 'PML_8']));
  check('ports terminated in their impedance (Feed_R), so the DC-isolated strips discharge and the energy decays', /Feed_R=p\['z'\]/.test(g.script) && P.every(p => p.z === 50));
  check('the script compiles (python3 -m py_compile)', (() => { const dir = mkdtempSync(join(tmpdir(), 'oems-')), f = join(dir, 'm.py'); writeFileSync(f, g.script); const r = spawnSync('python3', ['-m', 'py_compile', f]); return r.status === 0; })());
  // the comparison netlist: the as-built feeds shortened by Lp — same as the core netlist with feeds of the remaining length
  const d = parseNetlist(g.compare);
  check('comparison netlist: no connectors, the feeds shortened to the measurement planes, the openEMS result overlaid', !/_sma|_pad /.test(g.compare) && (g.compare.match(/^T\w+_f .* len=6\.8226mm$/mg) || []).length === 4 && d.data?.length === 1 && d.data[0].overlay);
}
{
  const g = openemsExport(ex('wilkinson-2g4-ro4350b-1524.cir'));
  const Lm = val(g.script, 'LUMPED');
  check('Wilkinson: the isolation resistor as a lumped R across the gap (its pads\' facing edges), along y', Lm.length === 1 && Lm[0].R > 50 && Lm[0].R < 100 && Lm[0].ny === 1 && Lm[0].start[1] < 0 && Lm[0].stop[1] > 0);
}
{
  const g = openemsExport(ex('combline-5pole-2g-ro4350b-1524.cir'));
  check('comb-line: grounding vias as cylinders (10 shorting + 10 under the capacitors), five lumped capacitors', val(g.script, 'VIAS').length === 20 && val(g.script, 'LUMPED').filter(l => l.C > 0).length === 5);
}
check('a netlist without .layout is refused', throws(() => openemsExport(ex('combline-4pole.cir')), /needs a \.layout/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
