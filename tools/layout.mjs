// Build the layout of a netlist that has a .layout statement.
//
//   node tools/layout.mjs FILE.cir [--svg out.svg] [--netlist asbuilt.cir] [--json layout.json]
//
// Prints the board size, design-rule results and notes; optionally writes the SVG preview, the
// as-built netlist (with the feed lines the layout adds) and the layout data as JSON.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { buildLayout } from '../js/layout-templates.js';
import { toSVG } from '../js/layout.js';

const [, , file, ...rest] = process.argv;
if (!file) { console.error('usage: node tools/layout.mjs FILE.cir [--svg out.svg] [--netlist asbuilt.cir] [--json out.json]'); process.exit(1); }
const opt = {}; for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
const d = parseNetlist(readFileSync(file, 'utf8'));
const L = buildLayout(d);
console.log(`${L.type} layout on ${L.substrate.name}: ${L.size[0].toFixed(2)} × ${L.size[1].toFixed(2)} mm`);
console.log(L.errors.length ? L.errors.map(e => `DRC: ${e.msg}`).join('\n') : 'DRC: design rules met');
L.notes.forEach(n => console.log(`note: ${n}`));
d.warnings.forEach(w => console.log(`warning: ${w}`));
if (opt.svg) { writeFileSync(opt.svg, toSVG(L)); console.log(`wrote ${opt.svg}`); }
if (opt.netlist) { writeFileSync(opt.netlist, L.netlist); console.log(`wrote ${opt.netlist}`); }
if (opt.json) { const { substrate, ...rest2 } = L; writeFileSync(opt.json, JSON.stringify({ ...rest2, substrate: substrate.id }, null, 1)); console.log(`wrote ${opt.json}`); }
process.exit(L.errors.length ? 2 : 0);
