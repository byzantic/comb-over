// openEMS export (issue #16): write the full-wave model of a netlist's .layout and the netlist to compare.
// Usage:
//   node tools/openems.mjs FILE.cir --out DIR [--fmin HZ] [--fmax HZ] [--excite all|N] [--fine MM] [--nz N]
//                          [--end 1e-4] [--run]
// Writes DIR/<name>.py (self-contained openEMS/CSXCAD Python script; it writes DIR/<name>.sNp) and
// DIR/compare.cir (the as-built netlist at the same reference planes, overlaying the result). --run
// runs the script with python3 (openEMS's Python modules must be importable).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openemsExport } from '../js/openems.js';

const [, , file, ...rest] = process.argv;
const usage = 'usage: node tools/openems.mjs FILE.cir --out DIR [--fmin HZ] [--fmax HZ] [--excite all|N] [--fine MM] [--nz N] [--end 1e-4] [--run]';
if (!file) { console.error(usage); process.exit(2); }
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '');
  if (k === 'run') { opt.run = true; continue; }
  if (!['out', 'fmin', 'fmax', 'excite', 'fine', 'nz', 'end'].includes(k) || rest[i + 1] == null) { console.error(usage); process.exit(2); }
  opt[k] = rest[++i];
}
if (!opt.out) { console.error(usage); process.exit(2); }
const num = (x) => (x == null ? undefined : Number(x));
const g = openemsExport(readFileSync(file, 'utf8'), { fmin: num(opt.fmin), fmax: num(opt.fmax), excite: opt.excite, fine: num(opt.fine), nz: num(opt.nz), endCriteria: num(opt.end) });
mkdirSync(opt.out, { recursive: true });
const py = join(opt.out, `${g.name}.py`);
writeFileSync(py, g.script);
writeFileSync(join(opt.out, 'compare.cir'), g.compare);
console.log(`wrote ${py} (${g.info.cells} cells: ${g.info.X - 1} × ${g.info.Y - 1} × ${g.info.Z - 1}; fine ${+g.info.fine.toFixed(4)} mm, max ${+g.info.maxStep.toFixed(3)} mm)`);
console.log(`wrote ${join(opt.out, 'compare.cir')}`);
if (opt.run) {
  const t0 = Date.now();
  const r = spawnSync('python3', [py], { stdio: 'inherit' });
  console.log(`openEMS: exit ${r.status} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(r.status ?? 1);
}
