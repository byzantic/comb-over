// Combine comb-over parts' core netlists (the PART.cir of each KiCad library) into one netlist for a system simulation.
//
//   node tools/combine.mjs A=lib/CPL10/CPL10.cir B=lib/C3/C3.cir [--port A.in] [--port B.o1:50 …] [--title T] [--out FILE]
//
// Each part's nodes, elements and .params are prefixed with its letter (A_in, TA_in_t1, …); the parts must share one
// .substrate. --port lists the system's ports in order. Add the tracks between the parts (T lines of the feed width,
// bends) to the end of the result; manual §8.7.
import { readFileSync, writeFileSync } from 'node:fs';
import { combine } from '../js/combine.js';

const args = process.argv.slice(2), parts = [], ports = [];
let out = null, title;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port') ports.push(args[++i]);
  else if (a === '--out') out = args[++i];
  else if (a === '--title') title = args[++i];
  else if (/^[A-Za-z][A-Za-z0-9]*=/.test(a)) { const [prefix, file] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]; parts.push({ prefix, text: readFileSync(file, 'utf8') }); }
  else { console.error(`unknown argument ${a}\nusage: node tools/combine.mjs A=PART.cir B=PART.cir … [--port A.node[:Z] …] [--title T] [--out FILE]`); process.exit(2); }
}
if (!parts.length) { console.error('usage: node tools/combine.mjs A=PART.cir B=PART.cir … [--port A.node[:Z] …] [--title T] [--out FILE]'); process.exit(2); }
try {
  const r = combine(parts, { ports, title });
  if (out) { writeFileSync(out, r.text); console.log(`wrote ${out}`); } else process.stdout.write(r.text);
  for (const p of r.parts) console.error(`${p.prefix}: ${p.title}\n   ports ${p.ports.map(q => `${q.node}→${q.as}`).join(' ')}`);
} catch (e) { console.error(e.message); process.exit(1); }
