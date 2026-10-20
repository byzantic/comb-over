// KiCad 9 export of a netlist's .layout (issues #22, #7).
//
//   node tools/kicad.mjs FILE.cir --out DIR [--board] [--zip] [--name PART] [--mask open|covered]
//                        [--keepout MM] [--no-top-pour] [--via-pitch MM] [--date YYYY-MM-DD] [--make SUBSTRATE] [--force]
//
// Default: the core as a self-contained component library (footprint, symbol, lib tables, core
// netlist, README). --board: the whole KiCad project (board, .kicad_pro, as-built netlist) with that
// library bundled. --zip writes DIR/<name>.zip instead of loose files.
// --make SUBSTRATE does what the designer's "Make PCB layout" does for a netlist without .layout: set
// the substrate, convert impedance-defined sections to microstrip and add the detected .layout.
// --force exports even when the layout breaks a design rule (used by CI to check that KiCad's DRC
// catches it too).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
import { componentLibrary, boardProject, zip } from '../js/kicad.js';
import { setSubstrate, setLayout, detectLayouts, toMicrostrip } from '../js/netlist-edit.js';

// --caps SUBSTRATE --out DIR: the loading-capacitor (#14) and chip-resistor (#37) footprints as a library, for checking in KiCad
if (process.argv[2] === '--caps') {
  const { makeSubstrate } = await import('../js/substrates.js');
  const { capFootprint, resFootprint } = await import('../js/kicad.js');
  const { printedSize } = await import('../js/capacitors.js');
  const sub = makeSubstrate(process.argv[3]), outI = process.argv.indexOf('--out'), dir = process.argv[outI + 1];
  const d = Math.max(0.3, (sub.fab.minDrill ?? 0.3e-3) * 1e3);
  const fps = [...['0402', '0603', '0805'].map(pkg => capFootprint({ type: 'smd', pkg, via: { d, n: 2 } })), capFootprint({ type: 'trimmer', via: { d, n: 2 } }),
    capFootprint({ type: 'printed', a: +printedSize({ C: 2.2e-12, sub, f: 1e9 }).a.toFixed(3) }),
    ...['0402', '0603', '0805'].flatMap(pkg => [resFootprint({ pkg }), resFootprint({ pkg, ground: true, via: { d, n: 2 } })])];   // chip resistors (#37)
  for (const f of fps) { const p = join(dir, 'comb-over-caps.pretty', `${f.name}.kicad_mod`); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.text); console.log(`wrote ${p}`); }
  process.exit(0);
}
const [, , file, ...rest] = process.argv;
const usage = 'usage: node tools/kicad.mjs FILE.cir --out DIR [--board] [--zip] [--name PART] [--mask open|covered] [--keepout MM] [--no-top-pour] [--via-pitch MM] [--date YYYY-MM-DD] [--make SUBSTRATE] [--force]';
if (!file) { console.error(usage); process.exit(1); }
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '');
  if (['board', 'zip', 'no-top-pour', 'check', 'force'].includes(k)) opt[k] = true; else opt[k] = rest[++i];
}
if (!opt.out) { console.error(usage); process.exit(1); }
let src = readFileSync(file, 'utf8');
if (opt.make) {
  src = setSubstrate(src, opt.make);
  const conv = toMicrostrip(src, parseNetlist(src), parseNetlist(src).substrate);
  if (conv.skipped.length) { console.error(conv.skipped.map(x => `${x.name}: ${x.why}`).join('\n')); process.exit(2); }
  conv.changed.forEach(c => console.log(`${c.name}: ${c.from} → ${c.to}`));
  const cand = detectLayouts(parseNetlist(conv.text))[0];
  if (!cand) { console.error('no layout template fits this netlist'); process.exit(2); }
  src = parseNetlist(conv.text).layout ? conv.text : setLayout(conv.text, cand);
  console.log(`layout: ${cand.type} ${cand.sections.join(' ')}`);
}
const L = buildLayout(parseNetlist(src));
if (L.errors.length) { console.error(L.errors.map(e => `DRC: ${e.msg}`).join('\n')); if (!opt.force) process.exit(2); console.error('--force: exporting anyway'); }
const o = { name: opt.name, mask: opt.mask, keepout: opt.keepout != null ? +opt.keepout : undefined, source: src,
  topPour: !opt['no-top-pour'], viaPitch: opt['via-pitch'] != null ? +opt['via-pitch'] : undefined, date: opt.date };
const out = (opt.board || opt.check) ? boardProject(L, o) : componentLibrary(L, o);
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); console.log(`wrote ${p}`); };
if (opt.zip) put(join(opt.out, `${out.lib}.zip`), zip(out.files, out.lib));
else for (const [p, t] of Object.entries(out.files)) put(join(opt.out, p), t);
if (out.vias) console.log(`board: ${out.vias.length} stitching/fence vias`);
