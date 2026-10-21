// openEMS export (issue #16): write the full-wave model of a netlist's .layout and the netlist to compare.
// Usage:
//   node tools/openems.mjs FILE.cir --out DIR [--fmin HZ] [--fmax HZ] [--excite all|N] [--fine MM] [--zfine MM] [--nz N]
//                          [--end 1e-4] [--lossless] [--run]
// Writes DIR/<name>.py (self-contained openEMS/CSXCAD Python script; it writes DIR/<name>.sNp) and
// DIR/compare.cir (the as-built netlist at the same reference planes, overlaying the result). --run
// runs the script with python3 (openEMS's Python modules must be importable; set OPENEMS_PYTHON to use
// another interpreter, e.g. openEMS's venv).
//   node tools/openems.mjs --compare DIR [--at F1,F2,…] [--port N]   tabulate the result against comb-over
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openemsExport } from '../js/openems.js';

// --compare DIR [--at F1,F2,…] [--port N]: the openEMS result in DIR against comb-over's comparison netlist
if (process.argv[2] === '--compare') {
  const { readdirSync } = await import('node:fs');
  const { parseNetlist } = await import('../js/netlist.js');
  const { solve } = await import('../js/solver.js');
  const { readTouchstone, onSweep } = await import('../js/touchstone.js');
  const dir = process.argv[3], args = process.argv.slice(4), get = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
  const cmp = readFileSync(join(dir, 'compare.cir'), 'utf8'), d = parseNetlist(cmp), P = d.ports.length;
  const tsName = readdirSync(dir).find(f => new RegExp(`\\.s${P}p$`, 'i').test(f));
  if (!tsName) { console.error(`no .s${P}p in ${dir} (run the script first)`); process.exit(2); }
  const ds = readTouchstone(readFileSync(join(dir, tsName), 'utf8'), { nPorts: P, name: tsName });
  const F = Float64Array.from((get('at') ?? '').split(',').filter(Boolean).map(Number).length ? get('at').split(',').map(Number) : Array.from({ length: 9 }, (_, k) => d.freq.start + (d.freq.stop - d.freq.start) * k / 8));
  const r = solve(d, F), em = onSweep(ds, F), j = Number(get('port') ?? 1);
  const db = (x, k) => 20 * Math.log10(Math.hypot(x.re[k], x.im[k]));
  const lost = (S, k) => 100 * (1 - d.ports.reduce((acc, _, i) => { const s = S(i + 1, j); return acc + s.re[k] ** 2 + s.im[k] ** 2; }, 0));
  console.log(`excitation port ${j} (${d.ports[j - 1].node}); comb-over | openEMS: |S| in dB; power lost (absorbed or radiated) in %`);
  console.log(['f (GHz)', ...d.ports.map((p, i) => `S${i + 1}${j}`), 'lost %'].map(x => x.padEnd(22)).join(''));
  for (let k = 0; k < F.length; k++) {
    const cells = d.ports.map((_, i) => { const a = r.S(i + 1, j), b = em.S(i + 1, j); return `${db(a, k).toFixed(2)} | ${db(b, k).toFixed(2)}`; });
    console.log([(F[k] / 1e9).toFixed(3), ...cells, `${lost(r.S, k).toFixed(1)} | ${lost(em.S, k).toFixed(1)}`].map(x => String(x).padEnd(22)).join(''));
  }
  process.exit(0);
}
const [, , file, ...rest] = process.argv;
const usage = 'usage: node tools/openems.mjs FILE.cir --out DIR [--fmin HZ] [--fmax HZ] [--excite all|N] [--fine MM] [--zfine MM] [--nz N] [--end 1e-4] [--lossless] [--run]';
if (!file) { console.error(usage); process.exit(2); }
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '');
  if (k === 'run') { opt.run = true; continue; }
  if (k === 'lossless') { opt.lossless = true; continue; }
  if (!['out', 'fmin', 'fmax', 'excite', 'fine', 'zfine', 'nz', 'end'].includes(k) || rest[i + 1] == null) { console.error(usage); process.exit(2); }
  opt[k] = rest[++i];
}
if (!opt.out) { console.error(usage); process.exit(2); }
const num = (x) => (x == null ? undefined : Number(x));
const g = openemsExport(readFileSync(file, 'utf8'), { fmin: num(opt.fmin), fmax: num(opt.fmax), excite: opt.excite, fine: num(opt.fine), nz: num(opt.nz), zfine: num(opt.zfine), lossless: opt.lossless, endCriteria: num(opt.end) });
mkdirSync(opt.out, { recursive: true });
const py = join(opt.out, `${g.name}.py`);
writeFileSync(py, g.script);
writeFileSync(join(opt.out, 'compare.cir'), g.compare);
console.log(`wrote ${py} (${g.info.cells} cells: ${g.info.X - 1} × ${g.info.Y - 1} × ${g.info.Z - 1}; fine ${+g.info.fine.toFixed(4)} mm, max ${+g.info.maxStep.toFixed(3)} mm)`);
console.log(`wrote ${join(opt.out, 'compare.cir')}`);
if (opt.run) {
  const t0 = Date.now();
  const r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', [py], { stdio: 'inherit' });
  console.log(`openEMS: exit ${r.status} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(r.status ?? 1);
}
