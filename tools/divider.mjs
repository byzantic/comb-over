// Power dividers and hybrids from the command line (issue #39).
// Usage:
//   node tools/divider.mjs SPEC.json|JSON [--substrate ID] [--coupled true|false] [--gap MM] [--pitch MM] [--pkg 0402|0603|0805] [--out FILE.cir]
// SPEC: { "type": "wilkinson"|"branchline"|"ratrace"|"gysel"|"wilkinson-tree", "f0": Hz, "R0": 50,
//         "sections": 1–3, "fbw": 0.2, "splitDb": 0 (unequal Wilkinson, ideal only), "ways": 4 (tree) }
// Without --substrate: the ideal TEM design (js/dividers.js). With it (wilkinson with equal split, or
// branchline): the microstrip design with its layout line (js/dividers-ms.js). Report to stderr; exits 1 on warnings.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { wilkinson, wilkinsonTree, branchline, ratrace, gysel } from '../js/dividers.js';
import { realiseWilkinson, realiseBranchline } from '../js/dividers-ms.js';

const [, , specArg, ...rest] = process.argv;
const usage = 'usage: node tools/divider.mjs SPEC.json|JSON [--substrate ID] [--coupled true|false] [--gap MM] [--pitch MM] [--pkg 0603] [--out FILE.cir]';
if (!specArg) { console.error(usage); process.exit(2); }
const opt = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!/^--(substrate|coupled|gap|pitch|pkg|out)$/.test(rest[i]) || rest[i + 1] == null) { console.error(usage); process.exit(2); }
  opt[rest[i].slice(2)] = rest[i + 1];
}
const spec = JSON.parse(existsSync(specArg) ? readFileSync(specArg, 'utf8') : specArg);
const t0 = Date.now();
let g;
if (opt.substrate) {
  const o = { substrate: opt.substrate, coupled: opt.coupled !== 'false', gap: opt.gap ? +opt.gap : undefined, pitch: opt.pitch ? +opt.pitch : undefined, pkg: opt.pkg };
  if (spec.type === 'wilkinson' && !(spec.splitDb > 0)) g = realiseWilkinson(spec, o);
  else if (spec.type === 'branchline') g = realiseBranchline(spec, o);
  else { console.error(`microstrip designs: wilkinson (equal split) and branchline; ${spec.type} is ideal only (omit --substrate)`); process.exit(2); }
} else {
  const f = { wilkinson, 'wilkinson-tree': wilkinsonTree, branchline, ratrace, gysel }[spec.type];
  if (!f) { console.error(`unknown type ${spec.type}`); process.exit(2); }
  g = { ...f(spec), report: [], warnings: [] };
}
if (opt.out) writeFileSync(opt.out, g.netlist); else process.stdout.write(g.netlist);
console.error([...(g.report ?? []), `(${((Date.now() - t0) / 1000).toFixed(1)} s)`].join('\n'));
if (g.warnings?.length) { console.error('warnings:\n  ' + g.warnings.join('\n  ')); process.exit(1); }
