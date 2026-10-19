// Run a netlist's .goal optimisation from the command line; prints the tuned netlist.
// Usage: node tools/opt.mjs file.cir [maxiter] [restarts]
import { readFileSync, writeFileSync } from 'node:fs';
import { optimise, writeBack } from '../js/optimize.js';
import { dataFiles } from './files.mjs';
const [, , file, it = '600', rs = '3'] = process.argv;
let text = readFileSync(file, 'utf8');
for (let r = 0; r < +rs; r++) {
  const g = optimise(text, { maxiter: +it, files: dataFiles(file, text) });
  let s; while (!(s = g.next()).done) {} 
  const fin = s.value;
  console.error(`round ${r}: cost ${fin.cost.toExponential(3)} after ${fin.evals} evals`);
  text = writeBack(text, fin.best);
}
writeFileSync(file, text);
console.log(text.split('\n').filter(l => /^\.param/.test(l)).join('\n'));
