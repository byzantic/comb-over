// KiCad component-library export (issue #22).  Run: node tests/kicad.mjs
// KiCad itself checks these files in CI (tools/kicad-check.sh); here we check structure and geometry.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { buildLayout } from '../js/layout-templates.js';
import { polygonArea } from '../js/layout.js';
import { componentLibrary, checkBoard, footprint, crc32, zip, KICAD_BOARD_VERSION, KICAD_SYMBOL_VERSION } from '../js/kicad.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const db = (r, i, j, k) => { const s = r.S(i, j); return 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); };

// minimal s-expression reader: lists, quoted strings, atoms
function sexpr(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const read = () => {
    ws();
    if (text[i] === '(') {
      i++; const list = [];
      for (;;) { ws(); if (text[i] === ')') { i++; return list; } if (i >= text.length) throw new Error('unbalanced'); list.push(read()); }
    }
    if (text[i] === '"') {
      let s = ''; i++;
      while (text[i] !== '"') { if (text[i] === '\\') i++; s += text[i++]; if (i >= text.length) throw new Error('unterminated string'); }
      i++; return { str: s };
    }
    const m = /^[^\s()"]+/.exec(text.slice(i)); if (!m) throw new Error(`bad token at ${i}`);
    i += m[0].length; return m[0];
  };
  const v = read(); ws();
  if (i !== text.length) throw new Error('trailing text');
  return v;
}
const kids = (node, tag) => node.filter(x => Array.isArray(x) && x[0] === tag);
const kid = (node, tag) => kids(node, tag)[0];
const s = (x) => (typeof x === 'object' ? x.str : x);

for (const [file, f0, nPorts, gnd] of [['coupler-10dB-ro4350b.cir', 5e9, 4, false], ['schiffman-ro4350b.cir', 2e9, 4, false], ['marchand-ro4350b.cir', 1e9, 3, true]]) {
  const src = ex(file), d = parseNetlist(src), L = buildLayout(d);
  const lib = componentLibrary(L, { source: src });
  const tag = L.type;
  console.log(`-- ${tag}`);
  const fpText = Object.entries(lib.files).find(([p]) => p.endsWith('.kicad_mod'))[1];
  let fp;
  try { fp = sexpr(fpText); check(`${tag}: footprint is a well-formed s-expression`, fp[0] === 'footprint'); } catch (e) { check(`${tag}: footprint is a well-formed s-expression`, false, e.message); continue; }
  check(`${tag}: footprint version ${KICAD_BOARD_VERSION}`, kid(fp, 'version')?.[1] === String(KICAD_BOARD_VERSION));
  const pads = kids(fp, 'pad');
  const nums = new Set(pads.map(p => s(p[1])));
  check(`${tag}: one pad number per port${gnd ? ' plus GND' : ''}`, nums.size === nPorts + (gnd ? 1 : 0), [...nums].join(','));
  const ties = kid(fp, 'net_tie_pad_groups')?.slice(1).map(g => s(g).split(',').map(t => t.trim())) || [];
  check(`${tag}: net-tie groups name existing pads`, ties.length > 0 && ties.every(g => g.every(n => nums.has(n))), JSON.stringify(ties));
  // every pad that touches another pad of a different number is in the same tie group
  const groupOf = (n) => ties.findIndex(g => g.includes(n));
  const touching = L.core.pads.flatMap((a, i) => L.core.pads.slice(i + 1).filter(b => b.num !== a.num && a.polys.some(pa => b.polys.some(pb => pa.some(([x, y]) => pb.some(([u, v]) => Math.hypot(x - u, y - v) < 1e-9))))).map(b => [a.num, b.num]));
  check(`${tag}: abutting pads of different numbers are net-tied`, touching.length > 0 && touching.every(([a, b]) => groupOf(a) >= 0 && groupOf(a) === groupOf(b)), JSON.stringify(touching));
  // custom pads: primitives are filled polygons; the copper equals the layout's core copper
  const custom = pads.filter(p => p[3] === 'custom');
  check(`${tag}: conductors are custom pads on F.Cu (+ mask opening), not on paste`, custom.length === L.core.pads.length && custom.every(p => { const ly = kid(p, 'layers').slice(1).map(s); return ly.includes('F.Cu') && ly.includes('F.Mask') && !ly.some(l => /Paste/.test(l)); }));
  const primArea = custom.reduce((a, p) => a + kids(kid(p, 'primitives'), 'gr_poly').reduce((b, g) => b + polygonArea(kid(g, 'pts').slice(1).map(q => [+q[1], +q[2]])), 0), 0);
  const coreArea = L.core.pads.reduce((a, p) => a + p.polys.reduce((b, poly) => b + polygonArea(poly), 0), 0);
  check(`${tag}: pad primitive area equals the core copper area`, near(primArea, coreArea, 1e-4), `${primArea} vs ${coreArea}`);
  if (tag === 'coupler') {
    const lines = L.items.filter(i => i.role === 'core').reduce((a, i) => a + polygonArea(i.pts), 0);
    check('coupler: the pads tile the coupled lines exactly (no overlap, no gap)', near(coreArea, lines, 1e-6), `${coreArea} vs ${lines}`);
  }
  const th = pads.filter(p => p[2] === 'thru_hole');
  check(`${tag}: grounding vias as thru-hole pads`, gnd ? th.length === L.core.vias.length && th.length > 0 : th.length === 0);
  const zone = kid(fp, 'zone');
  check(`${tag}: footprint has an F.Cu keepout that only forbids copper pour`, zone && s(kid(zone, 'layer')[1]) === 'F.Cu' && s(kid(kid(zone, 'keepout'), 'copperpour')[1]) === 'not_allowed' && s(kid(kid(zone, 'keepout'), 'tracks')[1]) === 'allowed');
  const props = Object.fromEntries(kids(fp, 'property').map(p => [s(p[1]), s(p[2])]));
  check(`${tag}: substrate and netlist hash recorded`, /h=\d/.test(props.Substrate) && props['Netlist hash'] === lib.hash && /^[0-9a-f]{8}$/.test(lib.hash));
  // symbol
  const sy = sexpr(lib.files[`${lib.lib}.kicad_sym`]);
  check(`${tag}: symbol library version ${KICAD_SYMBOL_VERSION}`, sy[0] === 'kicad_symbol_lib' && kid(sy, 'version')[1] === String(KICAD_SYMBOL_VERSION));
  const sym = kid(sy, 'symbol'), pins = kids(kid(sym, 'symbol') && kids(sym, 'symbol')[1], 'pin');
  const pinNums = pins.map(p => s(kid(p, 'number')[1]));
  check(`${tag}: symbol pins match the footprint pads`, pinNums.length === nums.size && pinNums.every(n => nums.has(n)), pinNums.join(','));
  check(`${tag}: pins on the 1.27 mm grid`, pins.every(p => { const a = kid(p, 'at'); return [+a[1], +a[2]].every(v => near(v / 1.27, Math.round(v / 1.27), 1e-9)); }));
  const fpField = kids(sym, 'property').find(p => s(p[1]) === 'Footprint');
  check(`${tag}: symbol footprint field points at the bundled library`, s(fpField[2]) === `${lib.lib}:${lib.name}`);
  check(`${tag}: lib tables use \${KIPRJMOD}`, lib.files['fp-lib-table'].includes(`\${KIPRJMOD}/${lib.lib}.pretty`) && lib.files['sym-lib-table'].includes(`\${KIPRJMOD}/${lib.lib}.kicad_sym`));
  // core netlist
  const c = solve(parseNetlist(lib.files[`${lib.name}.cir`])), r0 = solve(d), k = r0.freq.findIndex(x => x >= f0);
  check(`${tag}: core netlist within 0.3 dB of the bare design (S21 at f0)`, Math.abs(db(c, 2, 1, k) - db(r0, 2, 1, k)) < 0.3, `${db(c, 2, 1, k)} vs ${db(r0, 2, 1, k)}`);
  // reproducible
  check(`${tag}: output is deterministic`, componentLibrary(L, { source: src }).files[`${lib.lib}.pretty/${lib.name}.kicad_mod`] === fpText);
  // check board
  const b = checkBoard(L, { source: src });
  let pcb; try { pcb = sexpr(b.board); } catch (e) { pcb = null; }
  check(`${tag}: check board is well-formed, KiCad 9 version`, pcb && pcb[0] === 'kicad_pcb' && kid(pcb, 'version')[1] === String(KICAD_BOARD_VERSION));
  const nets = Object.fromEntries(kids(pcb, 'net').map(n => [n[1], s(n[2])]));
  const efp = kids(pcb, 'footprint').find(f => s(f[1]).endsWith(lib.name));
  check(`${tag}: embedded part pads carry their nets`, kids(efp, 'pad').every(p => { const n = kid(p, 'net'); return n && nets[n[1]] === s(n[2]); }));
  check(`${tag}: pin function only on the board copy (as KiCad writes it)`, !/pinfunction/.test(fpText) && kids(efp, 'pad').every(p => kid(p, 'pinfunction')));
  check(`${tag}: a feed track per port`, new Set(kids(pcb, 'segment').map(t => kid(t, 'net')[1])).size === nPorts);
  check(`${tag}: project file sets clearance to the fab minimum space`, JSON.parse(b.project).net_settings.classes[0].clearance === Math.max(0.1, L.substrate.fab.minSpace * 1e3));
}

// mask option
{
  const L = buildLayout(parseNetlist(ex('coupler-10dB-ro4350b.cir')));
  const t = footprint(L, { mask: 'covered' }).text;
  check('mask=covered leaves F.Mask off the conductor pads', !/"F\.Mask"/.test(t));
}

// zip
{
  const enc = new TextEncoder();
  check('crc32 matches zlib', !zlib.crc32 || crc32(enc.encode('comb-over')) === zlib.crc32('comb-over'));
  const z = zip({ 'a.txt': 'hello', 'b/c.txt': 'world' }, 'root');
  const sig = (o) => z[o] | (z[o + 1] << 8) | (z[o + 2] << 16) | (z[o + 3] << 24);
  check('zip starts with a local header and ends with the central directory end record', sig(0) === 0x04034b50 && (sig(z.length - 22) >>> 0) === 0x06054b50);
  const names = new TextDecoder().decode(z);
  check('zip entries are under the root folder', names.includes('root/a.txt') && names.includes('root/b/c.txt'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
