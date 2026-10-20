// Filter synthesis from the command line: the designer's "Realise in microstrip" (issues #13, #15).
// Usage:
//   node tools/synth.mjs SPEC.json|'{"structure":"comb",...}' --substrate ID [--cap ideal|smd-0603|smd-0402|smd-0805|trimmer]
//                        [--out FILE.cir]
// SPEC is the designer's specification (as js/synth.js design() takes it): structure comb|interdigital|
// hairpin|edgecoupled (the last two need --substrate),
// type chebyshev|butterworth, n, ripple (dB), f0 (Hz), fbw, theta0Deg (comb), Zr, er, R0. Without
// --substrate, prints the homogeneous design's netlist. Prints the report and warnings to stderr;
// exits 1 on warnings.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { design } from '../js/synth.js';
import { realise } from '../js/synth-geom.js';
import { realiseHairpin } from '../js/synth-hairpin.js';
import { realiseEdgeCoupled } from '../js/synth-ec.js';

const [, , specArg, ...rest] = process.argv;
const usage = 'usage: node tools/synth.mjs SPEC.json|JSON --substrate ID [--cap ideal|smd-PKG|trimmer] [--out FILE.cir]';
if (!specArg) { console.error(usage); process.exit(2); }
const opt = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!/^--(substrate|cap|out)$/.test(rest[i]) || rest[i + 1] == null) { console.error(usage); process.exit(2); }
  opt[rest[i].slice(2)] = rest[i + 1];
}
const spec = JSON.parse(existsSync(specArg) ? readFileSync(specArg, 'utf8') : specArg);
const t0 = Date.now();
const micro = spec.structure === 'hairpin' || spec.structure === 'edgecoupled';
if (micro && !opt.substrate) { console.error(`${spec.structure} needs --substrate`); process.exit(2); }
const r = micro ? { netlist: '', warnings: [] } : design(spec);
let netlist = r.netlist, report = [], warnings = r.warnings ?? [];
if (opt.substrate) {
  const [type, pkg] = (opt.cap ?? 'ideal').split('-');
  const g = spec.structure === 'hairpin' ? realiseHairpin(spec, { substrate: opt.substrate })
    : spec.structure === 'edgecoupled' ? realiseEdgeCoupled(spec, { substrate: opt.substrate })
      : realise(r, { substrate: opt.substrate, cap: { type, pkg } });
  netlist = g.netlist; report = g.report; warnings = g.warnings;
}
if (opt.out) writeFileSync(opt.out, netlist); else process.stdout.write(netlist);
console.error([...report, `(${((Date.now() - t0) / 1000).toFixed(1)} s)`].join('\n'));
if (warnings.length) { console.error('warnings:\n  ' + warnings.join('\n  ')); process.exit(1); }
