// Export the core of a netlist's .layout as a self-contained KiCad 9 component library (issue #22).
//
//   node tools/kicad.mjs FILE.cir --out DIR [--name PART] [--mask open|covered] [--keepout MM] [--check] [--zip]
//
// Writes DIR/<lib>.pretty/<part>.kicad_mod, DIR/<lib>.kicad_sym, DIR/fp-lib-table, DIR/sym-lib-table,
// DIR/<part>.cir (core netlist) and DIR/README.txt. --zip writes DIR/<lib>.zip instead of the loose files.
// --check also writes DIR/check/<part>-check.kicad_pcb + .kicad_pro: the part with test feeds, for
// `kicad-cli pcb drc` (used by CI, issue #9).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
import { componentLibrary, checkBoard, zip } from '../js/kicad.js';

const [, , file, ...rest] = process.argv;
const usage = 'usage: node tools/kicad.mjs FILE.cir --out DIR [--name PART] [--mask open|covered] [--keepout MM] [--check] [--zip]';
if (!file) { console.error(usage); process.exit(1); }
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '');
  if (k === 'check' || k === 'zip') opt[k] = true; else opt[k] = rest[++i];
}
if (!opt.out) { console.error(usage); process.exit(1); }
const src = readFileSync(file, 'utf8');
const L = buildLayout(parseNetlist(src));
if (L.errors.length) { console.error(L.errors.map(e => `DRC: ${e.msg}`).join('\n')); process.exit(2); }
const o = { name: opt.name, mask: opt.mask, keepout: opt.keepout != null ? +opt.keepout : undefined, source: src };
const lib = componentLibrary(L, o);
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); console.log(`wrote ${p}`); };
if (opt.zip) put(join(opt.out, `${lib.lib}.zip`), zip(lib.files, lib.lib));
else for (const [p, t] of Object.entries(lib.files)) put(join(opt.out, p), t);
if (opt.check) {
  const b = checkBoard(L, o);
  const dir = join(opt.out, 'check');
  put(join(dir, `${lib.name}-check.kicad_pcb`), b.board);
  put(join(dir, `${lib.name}-check.kicad_pro`), b.project);
  for (const [p, t] of Object.entries(lib.files)) if (/\.kicad_(mod|sym)$|lib-table$/.test(p)) put(join(dir, p), t);
}
