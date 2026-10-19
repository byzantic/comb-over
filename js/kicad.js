// KiCad 9 export (issue #22): the core of a layout as a self-contained component library, a
// footprint (.kicad_mod) + symbol (.kicad_sym) + library tables + the core netlist, and a small
// check board used to validate the part with kicad-cli.
//
// File versions are those written by KiCad 9.0.x (from the 9.0 branch sources):
//   board / footprint  SEXPR_BOARD_FILE_VERSION      20241229
//   symbol library     SEXPR_SYMBOL_LIB_FILE_VERSION 20241209
//   fp/sym lib tables  (version 7)
//
// Geometry conventions follow js/layout.js: millimetres, y down (as in Pcbnew). Symbols use y up.

import { launchTaper, padWidth } from './connectors.js';
import { capGeometry, SMD_PACKAGES, TRIMMER_FOOTPRINT } from './capacitors.js';

export const KICAD_BOARD_VERSION = 20241229;
export const KICAD_SYMBOL_VERSION = 20241209;
export const GENERATOR = 'comb-over';

// ---------------------------------------------------------------- s-expression helpers
const num = (x) => {
  const v = Math.round(x * 1e6) / 1e6;
  return (Object.is(v, -0) ? 0 : v).toString();
};
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const xy = (pts) => pts.map(([x, y]) => `(xy ${num(x)} ${num(y)})`).join(' ');

// 32-bit FNV-1a; used for the netlist hash and for deterministic UUIDs (reproducible files).
export function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function uuidFactory(seed) {
  let n = 0;
  return () => {
    const s = `${seed}:${n++}`;
    const fmix = (h) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
    const h = [0x811c9dc5, 0x01234567, 0x89abcdef, 0x5bd1e995].map(k => fmix(fnv1a(s, k)).toString(16).padStart(8, '0')).join('');
    // RFC 4122 layout, version 4 / variant bits set so KiCad sees a well-formed UUID
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

// ---------------------------------------------------------------- naming
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_.+-]+/g, '_').replace(/^_+|_+$/g, '');
const fmtF = (f) => (f >= 1e9 ? `${(f / 1e9).toFixed(2).replace('.', 'G')}` : `${(f / 1e6).toFixed(0)}M`);

// e.g. COUPLER_5G00_jlc-ro4350b-0.508
export function partName(layout, { name } = {}) {
  if (name) return sanitize(name);
  const f0 = layout.core?.f0 ?? layout.f0;
  return sanitize(`${layout.type.toUpperCase()}_${f0 ? fmtF(f0) + '_' : ''}${layout.substrate.id}`);
}

// ---------------------------------------------------------------- footprint
function inflateRect(bb, d) { return { x0: bb.x0 - d, y0: bb.y0 - d, x1: bb.x1 + d, y1: bb.y1 + d }; }
function bboxOf(core) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of core.pads) for (const poly of p.polys) for (const [x, y] of poly) add(x, y);
  for (const v of core.vias) { add(v.x - v.pad / 2, v.y - v.pad / 2); add(v.x + v.pad / 2, v.y + v.pad / 2); }
  return { x0, y0, x1, y1 };
}
const rectPts = (b) => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];

// Origin of the part: centre of its copper, rounded to 0.01 mm. Returns { ox, oy }.
export function partOrigin(core) {
  const b = bboxOf(core);
  return { ox: Math.round((b.x0 + b.x1) / 2 * 100) / 100, oy: Math.round((b.y0 + b.y1) / 2 * 100) / 100 };
}

function textProp(name, value, at, layer, uuid, { hide = false, size = 1 } = {}) {
  return `\t(property ${q(name)} ${q(value)}\n\t\t(at ${num(at[0])} ${num(at[1])} 0)\n\t\t(layer ${q(layer)})${hide ? '\n\t\t(hide yes)' : ''}\n\t\t(uuid ${q(uuid)})\n\t\t(effects\n\t\t\t(font (size ${size} ${size}) (thickness ${num(size * 0.15)}))\n\t\t)\n\t)`;
}

/**
 * Footprint text for a layout's core.
 * opts: { name, lib, mask: 'open'|'covered', keepout (mm, default max(3h, 1)), hash, netlist }
 *       nets: { node → [code, name] } when the footprint is embedded in a board.
 * Returns { text, name, origin }.
 */
export function footprint(layout, opts = {}) {
  const core = layout.core, sub = layout.substrate;
  const name = opts.name || partName(layout);
  const { ox, oy } = opts.origin || partOrigin(core);
  const uuid = uuidFactory(`fp:${name}:${opts.hash ?? ''}`);
  const R = ([x, y]) => [x - ox, y - oy];
  const h = sub.dielectric.h * 1e3;
  const keep = opts.keepout ?? Math.max(3 * h, 1);
  const bb0 = bboxOf(core);
  const bb = { x0: bb0.x0 - ox, y0: bb0.y0 - oy, x1: bb0.x1 - ox, y1: bb0.y1 - oy };
  const crt = inflateRect(bb, 0.25), ko = inflateRect(bb, keep);
  const maskLayers = opts.mask === 'covered' ? '' : ' "F.Mask"';
  const netOf = (node) => opts.nets?.[node];
  const netTok = (node) => { const n = netOf(node); return n ? `\n\t\t(net ${n[0]} ${q(n[1])})` : ''; };
  // pin function/type come from the schematic: only on a board copy, as KiCad itself writes them
  const pinTok = (node) => (opts.nets ? `\n\t\t(pinfunction ${q(node)})\n\t\t(pintype "passive")` : '');
  const L = [];
  const embedded = !!opts.embed;
  L.push(`(footprint ${q(embedded ? `${opts.lib || name}:${name}` : name)}`);
  if (!embedded) L.push(`\t(version ${KICAD_BOARD_VERSION})\n\t(generator ${q(GENERATOR)})\n\t(generator_version "9.0")`);
  L.push(`\t(layer "F.Cu")`);
  if (embedded) L.push(`\t(uuid ${q(uuid())})\n\t(at ${num(opts.embed.at[0])} ${num(opts.embed.at[1])})`);
  const desc = `${layout.type} core on ${sub.name}; generated by comb-over. Reference planes at the pad ends where the feeds attach.`;
  L.push(`\t(descr ${q(desc)})`);
  L.push(`\t(tags ${q(`comb-over RF microstrip ${layout.type}`)})`);
  L.push(textProp('Reference', opts.ref || 'RF1', [bb.x0, crt.y0 - 1.2], 'F.Fab', uuid()));   // F.Fab: RF copper is under most of the part
  L.push(textProp('Value', name, [0, crt.y1 + 1.2], 'F.Fab', uuid()));
  L.push(textProp('Datasheet', '', [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('Description', desc, [0, 0], 'F.Fab', uuid(), { hide: true }));
  const d = sub.dielectric, c = sub.copper;
  const props = {
    'Substrate': `${sub.id}: h=${num(d.h * 1e3)} mm, er=${d.er}, tand=${d.tand}, t=${num(c.t * 1e6)} um`,
    'Netlist hash': opts.hash ?? '',
    'Generator': 'comb-over (https://github.com/byzantic/comb-over)',
  };
  for (const [k, v] of Object.entries(props)) L.push(textProp(k, v, [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push(`\t(attr exclude_from_pos_files exclude_from_bom)`);
  if (core.ties.length) L.push(`\t(net_tie_pad_groups ${core.ties.map(t => q(t.join(', '))).join(' ')})`);
  // courtyard and fab outline
  const box = (b, layer, w) => [[b.x0, b.y0, b.x1, b.y0], [b.x1, b.y0, b.x1, b.y1], [b.x1, b.y1, b.x0, b.y1], [b.x0, b.y1, b.x0, b.y0]]
    .map(([a, bq, cq, dq]) => `\t(fp_line\n\t\t(start ${num(a)} ${num(bq)})\n\t\t(end ${num(cq)} ${num(dq)})\n\t\t(stroke (width ${w}) (type solid))\n\t\t(layer ${q(layer)})\n\t\t(uuid ${q(uuid())})\n\t)`);
  L.push(...box(crt, 'F.CrtYd', 0.05));
  L.push(...box(bb, 'F.Fab', 0.1));
  L.push(`\t(fp_text user "\${REFERENCE}"\n\t\t(at 0 0 0)\n\t\t(layer "F.Fab")\n\t\t(uuid ${q(uuid())})\n\t\t(effects\n\t\t\t(font (size 1 1) (thickness 0.15))\n\t\t)\n\t)`);
  // reference-plane markers on F.Fab
  for (const r of core.refs) {
    const [x, y] = R(r.at), nx = -r.dir[1], ny = r.dir[0], hw = r.wFeed / 2 + 0.3;
    L.push(`\t(fp_line\n\t\t(start ${num(x + nx * hw)} ${num(y + ny * hw)})\n\t\t(end ${num(x - nx * hw)} ${num(y - ny * hw)})\n\t\t(stroke (width 0.1) (type dash))\n\t\t(layer "F.Fab")\n\t\t(uuid ${q(uuid())})\n\t)`);
  }
  // pads: one custom pad per conductor piece, anchor a small square inside the copper
  for (const p of core.pads) {
    const a = 0.05;   // anchor square, inside the copper (the anchor point is inset ≥ 0.025 mm)
    const [px, py] = R(p.at);
    const prims = p.polys.map(poly => `\t\t\t(gr_poly\n\t\t\t\t(pts\n\t\t\t\t\t${xy(poly.map(pt => { const [x, y] = R(pt); return [x - px, y - py]; }))}\n\t\t\t\t)\n\t\t\t\t(width 0)\n\t\t\t\t(fill yes)\n\t\t\t)`).join('\n');
    L.push(`\t(pad ${q(p.num)} smd custom\n\t\t(at ${num(px)} ${num(py)})\n\t\t(size ${num(a)} ${num(a)})\n\t\t(layers "F.Cu"${maskLayers})${netTok(p.node)}${pinTok(p.node)}\n\t\t(zone_connect 2)\n\t\t(options\n\t\t\t(clearance outline)\n\t\t\t(anchor rect)\n\t\t)\n\t\t(primitives\n${prims}\n\t\t)\n\t\t(uuid ${q(uuid())})\n\t)`);
  }
  for (const v of core.vias) {
    const [x, y] = R([v.x, v.y]);
    L.push(`\t(pad ${q(v.num)} thru_hole circle\n\t\t(at ${num(x)} ${num(y)})\n\t\t(size ${num(v.pad)} ${num(v.pad)})\n\t\t(drill ${num(v.drill)})\n\t\t(layers "*.Cu")\n\t\t(remove_unused_layers no)${netTok(v.node)}${pinTok(v.node)}\n\t\t(zone_connect 2)\n\t\t(uuid ${q(uuid())})\n\t)`);
  }
  // keepout: no copper pour on F.Cu near the coupled lines (tracks, vias and pads allowed)
  L.push(`\t(zone\n\t\t(net 0)\n\t\t(net_name "")\n\t\t(layer "F.Cu")\n\t\t(uuid ${q(uuid())})\n\t\t(name "RF keepout")\n\t\t(hatch edge 0.5)\n\t\t(connect_pads\n\t\t\t(clearance 0)\n\t\t)\n\t\t(min_thickness 0.25)\n\t\t(filled_areas_thickness no)\n\t\t(keepout\n\t\t\t(tracks allowed)\n\t\t\t(vias allowed)\n\t\t\t(pads allowed)\n\t\t\t(copperpour not_allowed)\n\t\t\t(footprints allowed)\n\t\t)\n\t\t(placement\n\t\t\t(enabled no)\n\t\t\t(sheetname "")\n\t\t)\n\t\t(fill\n\t\t\t(thermal_gap 0.5)\n\t\t\t(thermal_bridge_width 0.5)\n\t\t)\n\t\t(polygon\n\t\t\t(pts\n\t\t\t\t${xy(rectPts(ko).map(([x, y]) => (embedded ? [x + opts.embed.at[0], y + opts.embed.at[1]] : [x, y])))}\n\t\t\t)\n\t\t)\n\t)`);   // zones in a board footprint are in board coordinates
  L.push(`\t(embedded_fonts no)`);
  L.push(')');
  return { text: L.join('\n') + '\n', name, origin: { ox, oy }, keepout: keep };
}

// ---------------------------------------------------------------- symbol
// Pins from the reference-plane directions: left/right/top/bottom; ground pin at the bottom.
export function symbol(layout, opts = {}) {
  const core = layout.core;
  const name = opts.name || partName(layout);
  const lib = opts.lib || name;
  const G = 2.54;
  const side = { left: [], right: [], top: [], bottom: [] };
  for (const r of core.refs) {
    const [dx, dy] = r.dir;
    const s = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
    side[s].push({ num: r.num, name: r.node, key: s === 'left' || s === 'right' ? r.at[1] : r.at[0] });
  }
  const gnd = [...new Set(core.vias.map(v => v.num).concat(core.pads.filter(p => p.node === 'GND').map(p => p.num)))];
  for (const g of gnd) side.bottom.push({ num: g, name: 'GND', key: Infinity });
  for (const s of Object.values(side)) s.sort((a, b) => a.key - b.key);
  const nv = Math.max(side.left.length, side.right.length, 1), nh = Math.max(side.top.length, side.bottom.length, 1);
  const hh = Math.max(nv * G, G), hw = Math.max(nh * G, 2 * G);   // half sizes: pins 5.08 apart, ≥ 2.54 clear of the corners
  const pins = [];
  const place = (list, f) => list.forEach((p, i) => { const off = (i - (list.length - 1) / 2) * G * 2; pins.push({ ...p, ...f(Math.round(off / G) * G) }); });
  place(side.left, (o) => ({ x: -hw - G, y: -o, a: 0 }));           // symbol y is up: first (top-most on the board) pin at the top
  place(side.right, (o) => ({ x: hw + G, y: -o, a: 180 }));
  place(side.top, (o) => ({ x: o, y: hh + G, a: 270 }));
  place(side.bottom, (o) => ({ x: o, y: -hh - G, a: 90 }));
  const font = '(effects\n\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t)\n\t\t\t\t\t)';
  const prop = (k, v, at, hide) => `\t\t(property ${q(k)} ${q(v)}\n\t\t\t(at ${num(at[0])} ${num(at[1])} 0)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)${hide ? '\n\t\t\t\t(hide yes)' : ''}\n\t\t\t)\n\t\t)`;
  const desc = `${layout.type} on ${layout.substrate.name} (comb-over). Model: ${name}.cir`;
  const L = [];
  L.push(`(kicad_symbol_lib\n\t(version ${KICAD_SYMBOL_VERSION})\n\t(generator ${q(GENERATOR)})\n\t(generator_version "9.0")`);
  L.push(`\t(symbol ${q(name)}\n\t\t(exclude_from_sim no)\n\t\t(in_bom no)\n\t\t(on_board yes)`);
  L.push(prop('Reference', 'RF', [-hw, hh + G * (side.top.length ? 2.5 : 1)], false));
  L.push(prop('Value', name, [-hw, -hh - G * (side.bottom.length ? 2.5 : 1)], false));
  L.push(prop('Footprint', `${lib}:${name}`, [0, 0], true));
  L.push(prop('Datasheet', '', [0, 0], true));
  L.push(prop('Description', desc, [0, 0], true));
  L.push(prop('ki_keywords', `RF microstrip ${layout.type} comb-over`, [0, 0], true));
  L.push(`\t\t(symbol ${q(`${name}_0_1`)}\n\t\t\t(rectangle\n\t\t\t\t(start ${num(-hw)} ${num(hh)})\n\t\t\t\t(end ${num(hw)} ${num(-hh)})\n\t\t\t\t(stroke\n\t\t\t\t\t(width 0.254)\n\t\t\t\t\t(type default)\n\t\t\t\t)\n\t\t\t\t(fill\n\t\t\t\t\t(type background)\n\t\t\t\t)\n\t\t\t)\n\t\t)`);
  L.push(`\t\t(symbol ${q(`${name}_1_1`)}`);
  for (const p of pins) {
    L.push(`\t\t\t(pin passive line\n\t\t\t\t(at ${num(p.x)} ${num(p.y)} ${p.a})\n\t\t\t\t(length ${G})\n\t\t\t\t(name ${q(p.name)}\n\t\t\t\t\t${font}\n\t\t\t\t)\n\t\t\t\t(number ${q(p.num)}\n\t\t\t\t\t${font}\n\t\t\t\t)\n\t\t\t)`);
  }
  L.push('\t\t)');
  L.push('\t\t(embedded_fonts no)');
  L.push('\t)');
  L.push(')');
  return { text: L.join('\n') + '\n', name, pins };
}

// ---------------------------------------------------------------- library bundle
export const fpLibTable = (lib) => `(fp_lib_table\n\t(version 7)\n\t(lib (name ${q(lib)})(type "KiCad")(uri ${q(`\${KIPRJMOD}/${lib}.pretty`)})(options "")(descr "comb-over design library"))\n)\n`;
export const symLibTable = (lib) => `(sym_lib_table\n\t(version 7)\n\t(lib (name ${q(lib)})(type "KiCad")(uri ${q(`\${KIPRJMOD}/${lib}.kicad_sym`)})(options "")(descr "comb-over design library"))\n)\n`;

/**
 * Self-contained component library for one design. Returns { lib, name, files: { path → text } }.
 *   <lib>.pretty/<name>.kicad_mod, <lib>.kicad_sym, fp-lib-table, sym-lib-table, <name>.cir, README.txt
 * opts: { name, lib, mask, keepout, source (netlist text, hashed into the part) }
 */
export function componentLibrary(layout, opts = {}) {
  const name = opts.name || partName(layout);
  const lib = sanitize(opts.lib || name);
  const hash = opts.source != null ? fnv1a(opts.source).toString(16).padStart(8, '0') : '';
  const fp = footprint(layout, { ...opts, name, lib, hash });
  const sym = symbol(layout, { name, lib });
  const sub = layout.substrate;
  const readme = [
    `${name}: ${layout.type} core, generated by comb-over`,
    '',
    `Substrate: ${sub.name} (h ${num(sub.dielectric.h * 1e3)} mm, er ${sub.dielectric.er}). The copper is only valid on this stack-up.`,
    `Source netlist hash: ${hash || 'n/a'}`,
    '',
    'Files',
    `  ${lib}.pretty/${name}.kicad_mod   footprint (KiCad 9)`,
    `  ${lib}.kicad_sym                  symbol, footprint field set to ${lib}:${name}`,
    '  fp-lib-table, sym-lib-table       project library tables (${KIPRJMOD}); put them next to your .kicad_pro,',
    '                                    or add the library through Preferences → Manage Libraries',
    `  ${name}.cir                       core netlist for comb-over: ports at the reference planes`,
    '',
    'Footprint',
    '  - Each conductor is a custom-shape pad. A conductor that carries two ports (e.g. a through line) is',
    '    split at mid-length into two pads that are declared as a net tie, so DRC accepts the DC path.',
    '  - Pins: ' + sym.pins.map(p => `${p.num}=${p.name}`).join(', ') + '.',
    '  - Reference planes (dashed on F.Fab) are where the feeds attach. Attach each feed at its pad end with',
    '    the port impedance width; the feed length then adds to the core model in the .cir.',
    `  - Rule area "RF keepout": no copper pour on F.Cu within ${num(fp.keepout)} mm of the copper.`,
    `  - Solder mask: ${opts.mask === 'covered' ? 'covers the conductors (the model assumes bare lines)' : 'opened over the conductors, matching the model (no mask dielectric)'}.`,
    '  - The ground plane is the board\'s (B.Cu); the footprint has no back-side copper.',
    '',
  ].join('\n');
  const files = {
    [`${lib}.pretty/${name}.kicad_mod`]: fp.text,
    [`${lib}.kicad_sym`]: sym.text,
    'fp-lib-table': fpLibTable(lib),
    'sym-lib-table': symLibTable(lib),
    [`${name}.cir`]: layout.core.netlist,
    'README.txt': readme,
  };
  return { lib, name, hash, files, footprint: fp, symbol: sym };
}

// ---------------------------------------------------------------- board (issue #7)
const BOARD_LAYERS = `\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(2 "B.Cu" signal)\n\t\t(9 "F.Adhes" user "F.Adhesive")\n\t\t(11 "B.Adhes" user "B.Adhesive")\n\t\t(13 "F.Paste" user)\n\t\t(15 "B.Paste" user)\n\t\t(5 "F.SilkS" user "F.Silkscreen")\n\t\t(7 "B.SilkS" user "B.Silkscreen")\n\t\t(1 "F.Mask" user)\n\t\t(3 "B.Mask" user)\n\t\t(17 "Dwgs.User" user "User.Drawings")\n\t\t(19 "Cmts.User" user "User.Comments")\n\t\t(21 "Eco1.User" user "User.Eco1")\n\t\t(23 "Eco2.User" user "User.Eco2")\n\t\t(25 "Edge.Cuts" user)\n\t\t(27 "Margin" user)\n\t\t(31 "F.CrtYd" user "F.Courtyard")\n\t\t(29 "B.CrtYd" user "B.Courtyard")\n\t\t(35 "F.Fab" user)\n\t\t(33 "B.Fab" user)\n\t)`;

// 2-layer stack-up from the substrate, so KiCad's stack-up manager and impedance calculator agree.
function stackup(sub) {
  const t = num(sub.copper.t * 1e3), d = sub.dielectric;
  const cu = (n) => `\t\t\t(layer ${q(n)}\n\t\t\t\t(type "copper")\n\t\t\t\t(thickness ${t})\n\t\t\t)`;
  const mask = (n, ty) => `\t\t\t(layer ${q(n)}\n\t\t\t\t(type ${q(ty)})\n\t\t\t\t(color "Green")\n\t\t\t\t(thickness 0.01)\n\t\t\t)`;
  return [
    '\t\t(stackup',
    '\t\t\t(layer "F.SilkS"\n\t\t\t\t(type "Top Silk Screen")\n\t\t\t)',
    '\t\t\t(layer "F.Paste"\n\t\t\t\t(type "Top Solder Paste")\n\t\t\t)',
    mask('F.Mask', 'Top Solder Mask'), cu('F.Cu'),
    `\t\t\t(layer "dielectric 1"\n\t\t\t\t(type "core")\n\t\t\t\t(thickness ${num(d.h * 1e3)})\n\t\t\t\t(material ${q(d.material)})\n\t\t\t\t(epsilon_r ${num(d.er)})\n\t\t\t\t(loss_tangent ${num(d.tand)})\n\t\t\t)`,
    cu('B.Cu'), mask('B.Mask', 'Bottom Solder Mask'),
    '\t\t\t(layer "B.Paste"\n\t\t\t\t(type "Bottom Solder Paste")\n\t\t\t)',
    '\t\t\t(layer "B.SilkS"\n\t\t\t\t(type "Bottom Silk Screen")\n\t\t\t)',
    '\t\t\t(copper_finish "ENIG")',
    '\t\t\t(dielectric_constraints yes)',
    '\t\t)',
  ].join('\n');
}

// Placeholder for an edge connector (issue #8 replaces it with an SMA): one SMD pad of the feed width.
const portName = (w, pl) => `PORT_${num(w).replace('.', 'p')}x${num(pl).replace('.', 'p')}mm`;
function portFootprint(w, pl, { lib, embed, net, ref = 'J1', uuid = uuidFactory(`port:${w}:${pl}`) } = {}) {
  const name = portName(w, pl);
  const L = [`(footprint ${q(embed ? `${lib}:${name}` : name)}`];
  if (!embed) L.push(`\t(version ${KICAD_BOARD_VERSION})\n\t(generator ${q(GENERATOR)})\n\t(generator_version "9.0")`);
  L.push('\t(layer "F.Cu")');
  if (embed) L.push(`\t(uuid ${q(uuid())})\n\t(at ${num(embed.at[0])} ${num(embed.at[1])}${embed.rot ? ' ' + embed.rot : ''})`);
  L.push(`\t(descr "Port placeholder: feed end for an edge-launch connector (comb-over)")`);
  L.push(textProp('Reference', ref, [0, -w / 2 - 1.2], 'F.Fab', uuid()));
  L.push(textProp('Value', name, [0, w / 2 + 1.2], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('Datasheet', '', [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('Description', 'Port placeholder (comb-over)', [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push('\t(attr smd exclude_from_bom allow_missing_courtyard)');
  L.push(`\t(pad "1" smd rect\n\t\t(at 0 0${embed?.rot ? ' ' + embed.rot : ''})\n\t\t(size ${num(pl)} ${num(w)})\n\t\t(layers "F.Cu" "F.Mask")${net ? `\n\t\t(net ${net[0]} ${q(net[1])})\n\t\t(pinfunction "1")\n\t\t(pintype "passive")` : ''}\n\t\t(uuid ${q(uuid())})\n\t)`);
  L.push('\t(embedded_fonts no)', ')');
  return { name, text: L.join('\n') + '\n' };
}

// Edge-launch connector footprint (issue #8), in the connector-local frame of js/connectors.js:
// origin on the board edge at the signal-pad centre line, +x out of the board. The signal pad carries
// a launch taper to the feed width wf (a separate pad "1" without paste), and each ground pad gets
// three thru-hole vias tying the top and bottom ground pads (and pours) together.
const smaName = (c, wf, mode) => `${c.footprint}_${mode === 'library' ? 'L' : 'W'}${wf.toFixed(3).replace('.', 'p')}`;
function smaFootprint(c, wf0, { lib, embed, nets, ref = 'J1', uuid = uuidFactory(`sma:${c.id}:${wf0}`), drill = 0.3, mode = 'matched' } = {}) {
  const wf = Math.round(wf0 * 1000) / 1000;              // 1 µm: one footprint per feed width as named
  const name = smaName(c, wf, mode), s = c.signal, g = c.ground, Lt = launchTaper(c, wf, mode), pw = padWidth(c, wf, mode);
  const rot = embed?.rot ? ` ${embed.rot}` : '';
  const net = (k) => (nets?.[k] ? `\n\t\t(net ${nets[k][0]} ${q(nets[k][1])})\n\t\t(pinfunction ${q(k === 'sig' ? 'In' : 'Ext')})\n\t\t(pintype "passive")` : '');
  const L = [`(footprint ${q(embed ? `${lib}:${name}` : name)}`];
  if (!embed) L.push(`\t(version ${KICAD_BOARD_VERSION})\n\t(generator ${q(GENERATOR)})\n\t(generator_version "9.0")`);
  L.push('\t(layer "F.Cu")');
  if (embed) L.push(`\t(uuid ${q(uuid())})\n\t(at ${num(embed.at[0])} ${num(embed.at[1])}${rot})`);
  const desc = `${c.name}, edge mount; ${mode === 'library' ? `library ${s.w} mm signal pad with a ${num(Lt)} mm taper to` : 'signal pad matched to'} a ${num(wf)} mm feed. Pads from ${c.source}; origin on the board edge. Generated by comb-over.`;
  L.push(`\t(descr ${q(desc)})`, `\t(tags "SMA edge launch comb-over")`);
  L.push(textProp('Reference', ref, [-s.l / 2, -c.courtyard.y - 1], 'F.Fab', uuid()));
  L.push(textProp('Value', name, [c.courtyard.x1 / 2, c.courtyard.y + 1], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('Datasheet', 'https://www.amphenolrf.com/132289.html', [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('Description', desc, [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('MPN', c.mpn, [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push('\t(attr smd)');
  const line = (x0, y0, x1, y1, layer, w) => `\t(fp_line\n\t\t(start ${num(x0)} ${num(y0)})\n\t\t(end ${num(x1)} ${num(y1)})\n\t\t(stroke (width ${w}) (type solid))\n\t\t(layer ${q(layer)})\n\t\t(uuid ${q(uuid())})\n\t)`;
  const box = (x0, y0, x1, y1, layer, w) => [line(x0, y0, x1, y0, layer, w), line(x1, y0, x1, y1, layer, w), line(x1, y1, x0, y1, layer, w), line(x0, y1, x0, y0, layer, w)];
  const cy = c.courtyard;
  for (const ly of ['F.CrtYd', 'B.CrtYd']) L.push(...box(cy.x0 - (Lt > 0 ? Lt : 0), -cy.y, cy.x1, cy.y, ly, 0.05));
  for (const [x0, y0, x1, y1] of c.fab) L.push(...box(x0, y0, x1, y1, 'F.Fab', 0.1));
  L.push(line(0, -cy.y, 0, cy.y, 'Dwgs.User', 0.1));      // board edge reference
  const pad = (num_, x, y, w, l, layers, k) => `\t(pad ${q(num_)} smd rect\n\t\t(at ${num(x)} ${num(y)}${rot})\n\t\t(size ${num(l)} ${num(w)})\n\t\t(layers ${layers})${net(k)}\n\t\t(uuid ${q(uuid())})\n\t)`;
  L.push(pad('1', -s.l / 2, 0, pw, s.l, '"F.Cu" "F.Mask" "F.Paste"', 'sig'));
  if (Lt > 0) {
    const ax = -s.l - Lt / 2;                               // anchor in the middle of the taper
    const pts = [[-s.l, -pw / 2], [-s.l, pw / 2], [-s.l - Lt, wf / 2], [-s.l - Lt, -wf / 2]].map(([x, y]) => [x - ax, y]);
    const a = Math.min(pw, wf) / 2;
    L.push(`\t(pad "1" smd custom\n\t\t(at ${num(ax)} 0${rot})\n\t\t(size ${num(a)} ${num(a)})\n\t\t(layers "F.Cu" "F.Mask")${net('sig')}\n\t\t(zone_connect 2)\n\t\t(options\n\t\t\t(clearance outline)\n\t\t\t(anchor rect)\n\t\t)\n\t\t(primitives\n\t\t\t(gr_poly\n\t\t\t\t(pts\n\t\t\t\t\t${xy(pts)}\n\t\t\t\t)\n\t\t\t\t(width 0)\n\t\t\t\t(fill yes)\n\t\t\t)\n\t\t)\n\t\t(uuid ${q(uuid())})\n\t)`);
  }
  for (const sg of [-1, 1]) {
    L.push(pad('2', -g.l / 2, sg * g.y, g.w, g.l, '"F.Cu" "F.Mask" "F.Paste"', 'gnd'));
    L.push(pad('2', -g.l / 2, sg * g.y, g.w, g.l, '"B.Cu" "B.Mask" "B.Paste"', 'gnd'));
    for (const x of [-0.8, -g.l / 2, -g.l + 0.8]) {
      L.push(`\t(pad "2" thru_hole circle\n\t\t(at ${num(x)} ${num(sg * g.y)}${rot})\n\t\t(size ${num(drill + 0.3)} ${num(drill + 0.3)})\n\t\t(drill ${num(drill)})\n\t\t(layers "*.Cu")\n\t\t(remove_unused_layers no)${net('gnd')}\n\t\t(zone_connect 2)\n\t\t(uuid ${q(uuid())})\n\t)`);
    }
  }
  L.push('\t(embedded_fonts no)', ')');
  return { name, text: L.join('\n') + '\n' };
}
// KiCad footprint rotation (degrees, counter-clockwise on screen with y down) taking local +x to dir.
const rotTo = ([dx, dy]) => { const a = Math.round(Math.atan2(-dy, dx) * 180 / Math.PI); return ((a % 360) + 360) % 360; };

const ptSegDist = (p, a, b) => {
  const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
};
const ptPolyDist = (p, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, ptSegDist(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
};

/**
 * KiCad 9 project for a layout: the part from componentLibrary() placed with its nets, a port
 * placeholder and 50 Ω track at every feed, F.Cu and B.Cu GND pours, stitching and fence vias,
 * stack-up from the substrate, title block, and a .kicad_pro with the fab rules.
 * opts: componentLibrary options plus
 *   topPour (true), topClear (mm, default the part keepout), viaPitch (mm, default min(λeff/10, 5)),
 *   viaDrill (mm), title, date (YYYY-MM-DD).
 * Returns { lib, name, files } where files are the project files (library included).
 */
export function boardProject(layout, opts = {}) {
  const lib = componentLibrary(layout, opts);
  const core = layout.core, sub = layout.substrate, fab = sub.fab;
  const uuid = uuidFactory(`board:${lib.name}:${lib.hash}`);
  const ports = layout.feeds.map(f => f.node);
  const nodes = [...new Set([...core.pads.map(p => p.node), ...core.vias.map(v => v.node), ...ports, 'GND'])];
  const nets = {}; nodes.forEach((n, i) => { nets[n] = [i + 1, n]; });
  const { ox, oy } = lib.footprint.origin;
  const keep = lib.footprint.keepout;
  const fp = footprint(layout, { ...opts, name: lib.name, lib: lib.lib, hash: lib.hash, nets, embed: { at: [ox, oy] } });
  const h = sub.dielectric.h * 1e3, t = sub.copper.t * 1e3;
  const clearance = Math.max(0.1, (fab.minSpace ?? 0.1) * 1e3);
  const minTrack = Math.max(0.1, (fab.minTrace ?? 0.1) * 1e3);
  const edgeClr = 0.3;
  const topPour = opts.topPour ?? true;
  const topClr = opts.topClear ?? keep;
  const drill = opts.viaDrill ?? Math.max(0.3, (fab.minDrill ?? 0.3) * 1e3), viaD = drill + 0.3, vr = viaD / 2;
  const f0 = core.f0 || 1e9;
  const lam = 299792458 / f0 / Math.sqrt((sub.dielectric.er + 1) / 2) * 1e3;
  const pitch = opts.viaPitch ?? Math.max(1.5, Math.min(lam / 10, 5));
  const files = { ...lib.files };
  const L = [];
  L.push(`(kicad_pcb\n\t(version ${KICAD_BOARD_VERSION})\n\t(generator ${q(GENERATOR)})\n\t(generator_version "9.0")`);
  L.push(`\t(general\n\t\t(thickness ${num(h + 2 * t)})\n\t\t(legacy_teardrops no)\n\t)\n\t(paper "A4")`);
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const d = sub.dielectric;
  L.push(`\t(title_block\n\t\t(title ${q(opts.title || layout.title || lib.name)})\n\t\t(date ${q(date)})\n\t\t(company "comb-over")\n\t\t(comment 1 ${q(`${sub.name}: h ${num(d.h * 1e3)} mm, er ${d.er}, tand ${d.tand}, Cu ${num(t * 1e3)} um`)})\n\t\t(comment 2 ${q(`${layout.type}, f0 ${num(f0 / 1e9)} GHz; part ${lib.lib}:${lib.name}`)})\n\t\t(comment 3 ${q(`source netlist hash ${lib.hash || 'n/a'}`)})\n\t)`);
  L.push(BOARD_LAYERS);
  L.push(`\t(setup\n${stackup(sub)}\n\t\t(pad_to_mask_clearance 0)\n\t\t(allow_soldermask_bridges_in_footprints no)\n\t\t(tenting front back)\n\t)`);
  L.push(`\t(net 0 "")`);
  for (const n of nodes) L.push(`\t(net ${nets[n][0]} ${q(n)})`);
  L.push(fp.text.trim().split('\n').map(l => '\t' + l).join('\n'));
  // ports and feed tracks; copper of other nets kept for the via placement below
  const signal = core.pads.filter(p => p.node !== 'GND').flatMap(p => p.polys);
  const trackSegs = [];
  const conn = layout.connector;
  const portItems = layout.items.filter(i => i.type === 'port');
  const connBoxes = [];
  layout.feeds.forEach((f, k) => {
    const port = portItems.find(p => p.name === f.node);
    if (conn && port?.launch) {
      // edge-launch connector footprint at the port; the track starts at the end of its launch taper
      const rot = rotTo(port.dir);
      const mode = layout.opts?.launch;
      const sf = smaFootprint(conn, f.width, { lib: lib.lib, drill, mode });
      files[`${lib.lib}.pretty/${sf.name}.kicad_mod`] = sf.text;
      const emb = smaFootprint(conn, f.width, { lib: lib.lib, embed: { at: [port.x, port.y], rot }, nets: { sig: nets[f.node], gnd: nets.GND }, ref: `J${k + 1}`, uuid, drill, mode });
      L.push(emb.text.trim().split('\n').map(l => '\t' + l).join('\n'));
      signal.push(...port.launch.sig);
      const cy = conn.courtyard, Lt = port.launch.Lt;
      const cpts = [[cy.x0 - Lt, -cy.y], [0, -cy.y], [0, cy.y], [cy.x0 - Lt, cy.y]].map(([x, y]) => [port.x + port.dir[0] * x - port.dir[1] * y, port.y + port.dir[1] * x + port.dir[0] * y]);
      connBoxes.push(cpts);
      const pts = [port.launch.end, ...f.path.slice(1)];
      for (let i = 0; i < pts.length - 1; i++) {
        if (dist2(pts[i], pts[i + 1]) < 1e-6) continue;
        trackSegs.push({ a: pts[i], b: pts[i + 1], w: f.width });
        L.push(`\t(segment\n\t\t(start ${num(pts[i][0])} ${num(pts[i][1])})\n\t\t(end ${num(pts[i + 1][0])} ${num(pts[i + 1][1])})\n\t\t(width ${num(f.width)})\n\t\t(layer "F.Cu")\n\t\t(net ${nets[f.node][0]})\n\t\t(uuid ${q(uuid())})\n\t)`);
      }
      return;
    }
    const [e, nxt] = f.path, ux = (nxt[0] - e[0]) / dist2(e, nxt), uy = (nxt[1] - e[1]) / dist2(e, nxt);
    const pl = Math.min(1, dist2(e, nxt) / 2);
    const back = edgeClr + 0.05 + Math.max(pl, f.width) / 2;          // pad and the track's round end clear the edge
    const c = [e[0] + ux * back, e[1] + uy * back];
    const rot = Math.abs(uy) > Math.abs(ux) ? 90 : 0;
    const pf = portFootprint(f.width, pl, { lib: lib.lib });
    files[`${lib.lib}.pretty/${pf.name}.kicad_mod`] = pf.text;
    const emb = portFootprint(f.width, pl, { lib: lib.lib, embed: { at: c, rot }, net: nets[f.node], ref: `J${k + 1}`, uuid });
    L.push(emb.text.trim().split('\n').map(l => '\t' + l).join('\n'));
    const pts = [c, ...f.path.slice(1)];
    for (let i = 0; i < pts.length - 1; i++) {
      trackSegs.push({ a: pts[i], b: pts[i + 1], w: f.width });
      L.push(`\t(segment\n\t\t(start ${num(pts[i][0])} ${num(pts[i][1])})\n\t\t(end ${num(pts[i + 1][0])} ${num(pts[i + 1][1])})\n\t\t(width ${num(f.width)})\n\t\t(layer "F.Cu")\n\t\t(net ${nets[f.node][0]})\n\t\t(uuid ${q(uuid())})\n\t)`);
    }
  });
  // other parts of the layout (#15: loading capacitors on the resonator ends), with their nets
  const parts = layout.parts ?? [];
  parts.forEach((p, k) => {
    if (p.kind !== 'cap') return;
    const opt = { type: p.type, pkg: p.pkg, a: p.a, via: p.via };
    const lf = capFootprint(opt);
    files[`${lib.lib}.pretty/${lf.name}.kicad_mod`] = lf.text;
    const value = p.type === 'printed' ? 'printed pad' : `${+(p.C * 1e12).toPrecision(3)}pF${p.type === 'trimmer' ? ' (trimmer setting)' : ''}`;
    const emb = capFootprint({ ...opt, lib: lib.lib, embed: { at: p.at, rot: rotTo(p.dir) }, nets: { hot: nets[p.node], gnd: nets.GND }, ref: `C${k + 1}`, value, uuid });
    L.push(emb.text.trim().split('\n').map(l => '\t' + l).join('\n'));
    connBoxes.push(p.bbox);
  });
  // stitching vias (grid) and fences along the feeds; only where the top pour will be, so every via
  // joins both pours: clear of signal copper by topClr, outside the part's keepout, inside the board
  const o = layout.outline;
  const xs = o.map(p => p[0]), ys = o.map(p => p[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  const ko = inflateRect(bboxOf(core), keep + vr + 0.05);
  const sigDist = (p) => Math.min(...signal.map(poly => ptPolyDist(p, poly)), ...trackSegs.map(s => ptSegDist(p, s.a, s.b) - s.w / 2));
  const ok = (p) => p[0] >= bx0 + edgeClr + vr + 0.2 && p[0] <= bx1 - edgeClr - vr - 0.2 && p[1] >= by0 + edgeClr + vr + 0.2 && p[1] <= by1 - edgeClr - vr - 0.2
    && !(p[0] > ko.x0 && p[0] < ko.x1 && p[1] > ko.y0 && p[1] < ko.y1) && sigDist(p) >= (topPour ? topClr : clearance) + vr + 0.05
    && !connBoxes.some(b => ptPolyDist(p, b) < vr + 0.3);
  const vias = [];
  const add = (p) => { if (ok(p) && vias.every(v => Math.hypot(v[0] - p[0], v[1] - p[1]) >= pitch * 0.7)) vias.push(p); };
  for (const s of trackSegs) {                                  // fences first, so the grid fills around them
    const l = dist2(s.a, s.b), ux = (s.b[0] - s.a[0]) / l, uy = (s.b[1] - s.a[1]) / l, off = s.w / 2 + (topPour ? topClr : clearance) + vr + 0.1;
    for (let u = 0; u <= l + 1e-9; u += pitch / 2) for (const sg of [1, -1]) add([s.a[0] + ux * u - uy * off * sg, s.a[1] + uy * u + ux * off * sg]);
  }
  // fence ring just outside the RF keepout (filter templates): a closed row of vias round the part,
  // broken only where a feed or a part crosses it
  if (layout.fence) {
    const r = inflateRect(bboxOf(core), keep + vr + 0.06), per = 2 * (r.x1 - r.x0 + r.y1 - r.y0), k = Math.ceil(per / (pitch / 2));
    for (let i = 0; i < k; i++) {
      let u = i * per / k; const w = r.x1 - r.x0, hh = r.y1 - r.y0;
      add(u < w ? [r.x0 + u, r.y0] : (u -= w) < hh ? [r.x1, r.y0 + u] : (u -= hh) < w ? [r.x1 - u, r.y1] : [r.x0, r.y1 - (u - w)]);
    }
  }
  const gx0 = bx0 + ((bx1 - bx0) % pitch) / 2, gy0 = by0 + ((by1 - by0) % pitch) / 2;
  for (let y = gy0; y <= by1; y += pitch) for (let x = gx0; x <= bx1; x += pitch) add([x, y]);
  for (const v of vias) L.push(`\t(via\n\t\t(at ${num(v[0])} ${num(v[1])})\n\t\t(size ${num(viaD)})\n\t\t(drill ${num(drill)})\n\t\t(layers "F.Cu" "B.Cu")\n\t\t(net ${nets.GND[0]})\n\t\t(uuid ${q(uuid())})\n\t)`);
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length];
    L.push(`\t(gr_line\n\t\t(start ${num(a[0])} ${num(a[1])})\n\t\t(end ${num(b[0])} ${num(b[1])})\n\t\t(stroke (width 0.05) (type default))\n\t\t(layer "Edge.Cuts")\n\t\t(uuid ${q(uuid())})\n\t)`);
  }
  // fab note under the board
  const note = [`${lib.name}  (comb-over)`, `${sub.name}: dielectric ${num(d.h * 1e3)} mm, er ${d.er}; copper ${num(t * 1e3)} um, finish ENIG`, 'controlled-dielectric RF board: do not substitute material or thickness'];
  note.forEach((tx, i) => L.push(`\t(gr_text ${q(tx)}\n\t\t(at ${num(bx0)} ${num(by1 + 2 + i * 1.6)} 0)\n\t\t(layer "Cmts.User")\n\t\t(uuid ${q(uuid())})\n\t\t(effects\n\t\t\t(font (size 1 1) (thickness 0.15))\n\t\t\t(justify left bottom)\n\t\t)\n\t)`));
  const zone = (layer, clr) => `\t(zone\n\t\t(net ${nets.GND[0]})\n\t\t(net_name "GND")\n\t\t(layer ${q(layer)})\n\t\t(uuid ${q(uuid())})\n\t\t(name ${q(`GND ${layer}`)})\n\t\t(hatch edge 0.5)\n\t\t(connect_pads yes\n\t\t\t(clearance ${num(clr)})\n\t\t)\n\t\t(min_thickness 0.25)\n\t\t(filled_areas_thickness no)\n\t\t(fill yes\n\t\t\t(thermal_gap 0.5)\n\t\t\t(thermal_bridge_width 0.5)\n\t\t)\n\t\t(polygon\n\t\t\t(pts\n\t\t\t\t${xy(o)}\n\t\t\t)\n\t\t)\n\t)`;
  L.push(zone('B.Cu', clearance));
  if (topPour) L.push(zone('F.Cu', topClr));
  L.push('\t(embedded_fonts no)');
  L.push(')');
  const board = L.join('\n') + '\n';
  const name = lib.lib;
  files[`${name}.kicad_pcb`] = board;
  files[`${name}.kicad_pro`] = projectFile(name, { clearance, minTrack, minDrill: (fab.minDrill ?? 0.3) * 1e3, edgeClr });
  files[`${name}-asbuilt.cir`] = layout.netlist;
  const dru = [];
  if (conn) dru.push(`(rule "Edge-launch connector pads meet the board edge"\n\t(constraint edge_clearance (min 0mm))\n\t(severity ignore)\n\t(condition "A.memberOfFootprint('J*')"))`);
  if (parts.length) dru.push(`(rule "Loading capacitors sit on the resonator ends of the RF part"\n\t(constraint courtyard_clearance (min 0mm))\n\t(severity ignore)\n\t(condition "A.memberOfFootprint('C*') || B.memberOfFootprint('C*')"))`);
  if (dru.length) files[`${name}.kicad_dru`] = `(version 1)\n${dru.join('\n')}\n`;
  files['README.txt'] += [
    '',
    'Board (KiCad project)',
    `  ${name}.kicad_pro / .kicad_pcb   open the .kicad_pro in KiCad 9`,
    `  ${name}-asbuilt.cir              the whole board as laid out (part + feeds), for comb-over`,
    ...(parts.length ? [`  - ${parts.length} loading capacitors C1..C${parts.length} on the resonator ends (Value = nominal capacitance; see the as-built netlist)`] : []),
    conn ? `  - ${layout.feeds.length} ports J1..J${layout.feeds.length}: ${conn.name} (${conn.footprint} pads, launch taper to the feed width, 3 ground vias per ground pad); ${name}.kicad_dru lets their pads meet the board edge`
      : `  - ${layout.feeds.length} ports J1..J${layout.feeds.length}: placeholder pads at the board edge (connector=none)`,
    ...(layout.warnings || []).map(w => `  - WARNING: ${w}`),
    `  - feeds are ${[...new Set(layout.feeds.map(f => num(f.width)))].join('/')} mm tracks (port impedance)`,
    `  - GND pours on B.Cu${topPour ? ` and F.Cu (F.Cu kept ${num(topClr)} mm clear of the RF copper)` : ''}; ${vias.length} stitching/fence vias, ${num(drill)} mm drill, pitch ${num(pitch)} mm`,
    '  - stack-up and the fab design rules are set in the board and project files',
    '  - zones are saved unfilled: press B (Edit → Fill All Zones) after opening',
    '',
  ].join('\n');
  return { lib: lib.lib, name: lib.name, hash: lib.hash, files, board, vias, footprint: lib.footprint, symbol: lib.symbol, project: files[`${name}.kicad_pro`] };
}
const dist2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const checkBoard = boardProject;   // the CI check uses the real board

// Minimal .kicad_pro carrying the design rules kicad-cli uses for DRC.
export function projectFile(name, { clearance, minTrack, minDrill, edgeClr }) {
  return JSON.stringify({
    board: {
      design_settings: {
        defaults: {},
        rules: {
          min_clearance: clearance, min_track_width: minTrack, min_through_hole_diameter: minDrill,
          min_hole_to_hole: 0.25, min_copper_edge_clearance: edgeClr, min_via_diameter: 0.4, min_via_annular_width: 0.1,
          min_hole_clearance: 0.2, min_connection: 0, min_microvia_diameter: 0.2, min_microvia_drill: 0.1,
          solder_mask_to_copper_clearance: 0, min_silk_clearance: 0, min_text_height: 0.8, min_text_thickness: 0.08,
          max_error: 0.005, allow_blind_buried_vias: false, allow_microvias: false, use_height_for_length_calcs: true,
          min_resolved_spokes: 2, min_groove_width: 0,
        },
      },
    },
    meta: { filename: `${name}.kicad_pro`, version: 3 },
    net_settings: {
      classes: [{ name: 'Default', clearance, track_width: minTrack, via_diameter: 0.6, via_drill: Math.max(0.3, minDrill), diff_pair_gap: 0.25, diff_pair_width: 0.2, microvia_diameter: 0.3, microvia_drill: 0.1, wire_width: 6, bus_width: 12, line_style: 0, pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)', priority: 2147483647 }],
      meta: { version: 4 },
    },
  }, null, 2) + '\n';
}

// ---------------------------------------------------------------- zip (store only)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Uncompressed zip of { path → string }. Returns a Uint8Array. */
export function zip(files, root = '') {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let off = 0;
  const u16 = (v) => [v & 255, (v >>> 8) & 255], u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const [p, text] of Object.entries(files)) {
    const name = enc.encode(root ? `${root}/${p}` : p), data = enc.encode(text), crc = crc32(data);
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    const local = new Uint8Array([...u32(0x04034b50), ...common]);
    parts.push(local, name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
    off += local.length + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(Object.keys(files).length), ...u16(Object.keys(files).length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

// ---------------------------------------------------------------- loading-capacitor footprints (#14)
// One footprint per option, in the capacitor-local frame of js/capacitors.js (origin at the resonator
// end, +x away from the line). Pad 1 = hot side (resonator), pad 2 = ground (with its vias).
export function capFootprint({ type, pkg = '0603', a, via = { d: 0.3, n: 2 }, name, embed, nets, ref = 'C**', value, lib, uuid: uuidIn }) {
  const g = capGeometry({ type, pkg, a, via });
  const nm = name || (type === 'smd' ? `CAP_${pkg}_GND${via.n}V` : type === 'trimmer' ? `CAP_TZC3_GND${via.n}V` : `CAP_PRINTED_${num(a).replace('.', 'p')}mm`);
  const uuid = uuidIn ?? uuidFactory(`cap:${nm}`);
  // embedded in a board: library-qualified name, placement, pad rotation and nets (as smaFootprint)
  const rot = embed?.rot ? ` ${embed.rot}` : '';
  const netTok = (k) => (nets?.[k] ? `\n\t\t(net ${nets[k][0]} ${q(nets[k][1])})\n\t\t(pinfunction ${q(k === 'hot' ? '1' : '2')})\n\t\t(pintype "passive")` : '');
  const L = [`(footprint ${q(embed ? `${lib}:${nm}` : nm)}`];
  if (!embed) L.push(`\t(version ${KICAD_BOARD_VERSION})\n\t(generator ${q(GENERATOR)})\n\t(generator_version "9.0")`);
  L.push('\t(layer "F.Cu")');
  if (embed) L.push(`\t(uuid ${q(uuid())})\n\t(at ${num(embed.at[0])} ${num(embed.at[1])}${rot})`);
  const src = type === 'smd' ? `pads from KiCad Capacitor_SMD:${SMD_PACKAGES[pkg].kicad}` : type === 'trimmer' ? `pads from KiCad Capacitor_SMD:${TRIMMER_FOOTPRINT.kicad} (Murata TZC3)` : 'square pad to the ground plane';
  const desc = `comb-over loading capacitor (${type}${type === 'smd' ? ' ' + pkg : ''}): pad 1 on the resonator end, pad 2 to ground${g.vias.length ? ` through ${g.vias.length} vias` : ''}; ${src}`;
  L.push(`\t(descr ${q(desc)})`, '\t(tags "comb-over capacitor RF")');
  const bb = { x0: Math.min(...g.crt.map(p => p[0])), x1: Math.max(...g.crt.map(p => p[0])), y0: Math.min(...g.crt.map(p => p[1])), y1: Math.max(...g.crt.map(p => p[1])) };
  L.push(textProp('Reference', ref, [(bb.x0 + bb.x1) / 2, bb.y0 - 1], 'F.Fab', uuid()));
  L.push(textProp('Value', value ?? nm, [(bb.x0 + bb.x1) / 2, bb.y1 + 1], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('Datasheet', '', [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push(textProp('Description', desc, [0, 0], 'F.Fab', uuid(), { hide: true }));
  L.push(`\t(attr ${type === 'printed' ? 'smd exclude_from_pos_files exclude_from_bom' : 'smd'})`);
  const box = [[bb.x0, bb.y0, bb.x1, bb.y0], [bb.x1, bb.y0, bb.x1, bb.y1], [bb.x1, bb.y1, bb.x0, bb.y1], [bb.x0, bb.y1, bb.x0, bb.y0]];
  for (const [x0, y0, x1, y1] of box) L.push(`\t(fp_line\n\t\t(start ${num(x0)} ${num(y0)})\n\t\t(end ${num(x1)} ${num(y1)})\n\t\t(stroke (width 0.05) (type solid))\n\t\t(layer "F.CrtYd")\n\t\t(uuid ${q(uuid())})\n\t)`);
  const rectPad = (n, poly, layers, round) => {
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return `\t(pad ${q(n)} smd ${round ? 'roundrect' : 'rect'}\n\t\t(at ${num(cx)} ${num(cy)}${rot})\n\t\t(size ${num(Math.max(...xs) - Math.min(...xs))} ${num(Math.max(...ys) - Math.min(...ys))})\n\t\t(layers ${layers})${round ? '\n\t\t(roundrect_rratio 0.25)' : ''}${netTok(n === '1' ? 'hot' : 'gnd')}\n\t\t(uuid ${q(uuid())})\n\t)`;
  };
  const round = type === 'smd';                                  // KiCad's chip-capacitor pads are roundrects
  const part = '"F.Cu" "F.Mask" "F.Paste"';
  if (type === 'printed') L.push(rectPad('1', g.hot[0], '"F.Cu" "F.Mask"', false));
  else {
    L.push(rectPad('1', g.hot[0], part, round), rectPad('2', g.cold[0], part, round), rectPad('2', g.cold[1], '"F.Cu" "F.Mask"', false));
    for (const v of g.vias) L.push(`\t(pad "2" thru_hole circle\n\t\t(at ${num(v.x)} ${num(v.y)}${rot})\n\t\t(size ${num(v.pad)} ${num(v.pad)})\n\t\t(drill ${num(v.drill)})\n\t\t(layers "*.Cu")\n\t\t(remove_unused_layers no)${netTok('gnd')}\n\t\t(zone_connect 2)\n\t\t(uuid ${q(uuid())})\n\t)`);
  }
  L.push('\t(embedded_fonts no)', ')');
  return { name: nm, text: L.join('\n') + '\n', geometry: g };
}
