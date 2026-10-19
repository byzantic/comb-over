// Print a coarse text summary of a netlist's response: node tools/summary.mjs file.cir [i j]...
// .data sets (issue #17) are listed with their S-parameters at the same frequencies.
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { attachData } from '../js/data.js';
import { dataFiles } from './files.mjs';
const [, , file, ...ij] = process.argv;
const d = parseNetlist(readFileSync(file, 'utf8'));
const r = solve(d);
const att = attachData(d, r.freq, dataFiles(file));
att.warnings.forEach(w => console.error('warning: ' + w));
const pairs = ij.length ? ij.map(s => s.split('').map(Number)) : [[1, 1], [2, 1]];
const step = Math.max(1, Math.floor(r.freq.length / 40));
console.log('f(GHz)   ' + pairs.map(([i, j]) => `S${i}${j}dB    ang`).join('   '));
for (let k = 0; k < r.freq.length; k += step) {
  console.log((r.freq[k] / 1e9).toFixed(4).padStart(7) + '  ' + pairs.map(([i, j]) => { const s = r.S(i, j); return (20 * Math.log10(Math.hypot(s.re[k], s.im[k]))).toFixed(2).padStart(8) + (Math.atan2(s.im[k], s.re[k]) * 180 / Math.PI).toFixed(1).padStart(8); }).join('  '));
}
for (const ds of att.sets) {
  console.log(`\n.data ${ds.name} = ${ds.file} (${ds.P} ports, ${ds.n} points)`);
  for (let k = 0; k < r.freq.length; k += step) console.log((r.freq[k] / 1e9).toFixed(4).padStart(7) + '  ' + pairs.map(([i, j]) => { if (i > ds.P || j > ds.P) return ''.padStart(16); const s = att.data[ds.name].S(i, j); return (20 * Math.log10(Math.hypot(s.re[k], s.im[k]))).toFixed(2).padStart(8) + (Math.atan2(s.im[k], s.re[k]) * 180 / Math.PI).toFixed(1).padStart(8); }).join('  '));
}
d.sections.forEach(s => console.log(s.name, 'len', (s.len * 1e3).toFixed(3), 'mm; eps_eff', s.epsEff.map(x => x.toFixed(3)).join(' ')));
