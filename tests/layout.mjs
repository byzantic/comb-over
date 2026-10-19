// Layout core and templates (issue #6).  Run: node tests/layout.mjs
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { rect, pathPolygon, polygonArea, polyDistance, pathLength, drc, toSVG } from '../js/layout.js';
import { buildLayout } from '../js/layout-templates.js';
import { synthMsline, fromSubstrate } from '../js/microstrip.js';
import { makeSubstrate } from '../js/substrates.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const db = (r, i, j, k) => { const s = r.S(i, j); return 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); };

// ---- geometry helpers ----
{
  check('straight path polygon has area W·L', near(polygonArea(pathPolygon([[0, 0], [10, 0]], 2)), 20, 1e-12));
  const bent = pathPolygon([[0, 0], [10, 0], [15, 5]], 1);
  check('45° mitred path: area = W × centre-line length', near(polygonArea(bent), 1 * pathLength([[0, 0], [10, 0], [15, 5]]), 1e-9), polygonArea(bent));
  check('distance between parallel rectangles', near(polyDistance(rect(0, 0, 10, 1), rect(0, 1.25, 10, 2)), 0.25, 1e-12));
  check('overlapping polygons have distance 0', polyDistance(rect(0, 0, 2, 2), rect(1, 1, 3, 3)) === 0);
  check('diagonal distance', near(polyDistance(rect(0, 0, 1, 1), rect(2, 2, 3, 3)), Math.SQRT2, 1e-12));
}

// ---- DRC ----
{
  const sub = makeSubstrate('jlc-fr4-1.6');
  const base = { substrate: sub, outline: rect(-1, -5, 21, 5), items: [] };
  const L = (gap, width = 0.5) => ({ ...base, items: [
    { type: 'poly', layer: 'F.Cu', net: 'a', pts: rect(0, -width - gap / 2, 20, -gap / 2), width },
    { type: 'poly', layer: 'F.Cu', net: 'b', pts: rect(0, gap / 2, 20, gap / 2 + width), width },
  ] });
  check('DRC passes a 0.15 mm gap (JLC minimum 0.10 mm)', drc(L(0.15)).length === 0, JSON.stringify(drc(L(0.15))));
  check('DRC flags a 0.05 mm gap', drc(L(0.05)).some(e => e.rule === 'space' && near(e.value, 0.05, 1e-9)));
  check('DRC flags touching copper on different nets as a short', drc(L(0)).some(e => e.rule === 'short'));
  check('DRC flags a trace narrower than the minimum', drc(L(0.2, 0.08)).some(e => e.rule === 'width'));
  const v = { ...base, items: [{ type: 'via', x: 5, y: 0, drill: 0.1, pad: 0.4, net: 'GND' }] };
  check('DRC flags a via drill below the minimum', drc(v).some(e => e.rule === 'drill'));
  const edge = { ...base, items: [{ type: 'poly', layer: 'F.Cu', net: 'a', pts: rect(0, 4.9, 5, 4.95), width: 0.05 }] };
  check('DRC flags copper too close to the board edge', drc(edge).some(e => e.rule === 'edge'));
}

// ---- coupler template ----
{
  const d = parseNetlist(ex('coupler-10dB-ro4350b.cir'));
  const L = buildLayout(d);
  check('coupler layout passes DRC', L.errors.length === 0, JSON.stringify(L.errors));
  const lines = L.items.filter(i => i.type === 'poly' && /^line/.test(i.label));
  const W = 0.8831, S = 0.1025, len = d.sections[0].len * 1e3;
  // the coupled region: both line polygons contain the points just inside their edges at mid-length
  const mid = len / 2, yc = (W + S) / 2;
  const contains = (poly, p) => { let inside = false; const pts = poly.pts; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
  check('coupled strips are W wide and S apart at mid-length', contains(lines[0], [mid, -yc + W / 2 - 1e-4]) && !contains(lines[0], [mid, -yc + W / 2 + 1e-4]) && contains(lines[1], [mid, yc - W / 2 + 1e-4]) && !contains(lines[1], [mid, yc - W / 2 - 1e-4]));
  check('minimum copper gap equals S', near(polyDistance(lines[0].pts, lines[1].pts), S, 1e-9), polyDistance(lines[0].pts, lines[1].pts));
  const ports = L.items.filter(i => i.type === 'port');
  check('four ports, each on the board edge', ports.length === 4 && ports.every(p => [L.outline[0][0], L.outline[1][0]].some(x => near(p.x, x, 1e-9))));
  const wf = synthMsline({ Z0: 50, ...fromSubstrate(d.substrate), f: 5e9 }).W * 1e3;
  check('feeds are 50 Ω wide at the ports', ports.every(p => near(p.width, wf, 1e-9)), wf);
  check('ports on the connector pitch (12 mm for the Amphenol 132289)', near(Math.abs(ports[0].y - ports[2].y), 12, 1e-9) && L.opts.pitch === 12);
  const ab = parseNetlist(L.netlist), r0 = solve(d), r1 = solve(ab);
  const k = r0.freq.findIndex(f => f >= 5e9);
  check('as-built netlist parses and keeps the coupled section', ab.sections.some(s => s.name === 'K' && near(s.len * 1e3, len, 1e-3)));
  check('as-built coupling at 5 GHz within 0.3 dB of the bare section', Math.abs(db(r1, 3, 1, k) - db(r0, 3, 1, k)) < 0.3, `${db(r1, 3, 1, k)} vs ${db(r0, 3, 1, k)}`);
  const svg = toSVG(L);
  const nCu = L.items.filter(i => i.type === 'poly').length;
  check('SVG has the board, every copper shape and 4 ports', /<polygon class="board"/.test(svg) && (svg.match(/class="cu"/g) || []).length === nCu && (svg.match(/class="port"/g) || []).length === 4);
  check('coupler: 2 lines + 4 tapers + 4 feeds + 4 × (signal pad + 2 ground pads)', nCu === 2 + 4 + 4 + 12, nCu);
}

// ---- Schiffman and Marchand templates ----
{
  const d = parseNetlist(ex('schiffman-ro4350b.cir'));
  const L = buildLayout(d);
  check('Schiffman layout passes DRC', L.errors.length === 0, JSON.stringify(L.errors));
  const ref = L.items.find(i => i.label === 'reference line');
  const extra = L.notes[0].match(/\(([\d.]+) mm\)/)[1];
  check('reference line = designed length + C-section feed lengths', near((ref.pts[1][0] - ref.pts[0][0]), d.sections[1].len * 1e3 + +extra, 1e-3));
  const bridge = L.items.find(i => i.label === 'C-section bridge');
  const lines = L.items.filter(i => /^C-section line/.test(i.label));
  check('bridge joins both C-section lines', lines.every(l => polyDistance(l.pts, bridge.pts) === 0));
  const ab = solve(parseNetlist(L.netlist)), k = ab.freq.findIndex(f => f >= 2e9);
  const s21 = ab.S(2, 1), s43 = ab.S(4, 3);
  const dphi = (Math.atan2(s21.im[k], s21.re[k]) - Math.atan2(s43.im[k], s43.re[k])) * 180 / Math.PI;
  const wrapped = ((dphi % 360) + 540) % 360 - 180;
  check('as-built phase difference at 2 GHz still ≈ 90° (within 6°)', Math.abs(wrapped - 90) < 6, wrapped);
}
{
  const d = parseNetlist(ex('marchand-ro4350b.cir'));
  const L = buildLayout(d);
  check('Marchand layout passes DRC', L.errors.length === 0, JSON.stringify(L.errors));
  const vias = L.items.filter(i => i.type === 'via');
  const sec = L.items.filter(i => /secondary/.test(i.label));
  const inside = (v, p) => { const xs = p.pts.map(q => q[0]), ys = p.pts.map(q => q[1]); return v.x - v.pad / 2 >= Math.min(...xs) && v.x + v.pad / 2 <= Math.max(...xs) && v.y - v.pad / 2 >= Math.min(...ys) - 1e-9 && v.y + v.pad / 2 <= Math.max(...ys) + 1e-9; };
  check('grounding vias sit on the secondary-line pads (2 per end)', vias.length === 4 && vias.every(v => sec.some(p => inside(v, p))));
  check('outputs leave from the bottom edge on the connector pitch', (() => { const ps = L.items.filter(i => i.type === 'port' && i.dir[1] === 1); return ps.length === 2 && near(Math.abs(ps[0].x - ps[1].x), 12, 1e-9); })());
  const ab = parseNetlist(L.netlist), r = solve(ab), r0 = solve(d), k = r.freq.findIndex(f => f >= 1e9);
  check('as-built Marchand outputs within 0.5 dB of the bare sections at f0', Math.abs(db(r, 2, 1, k) - db(r0, 2, 1, k)) < 0.5 && Math.abs(db(r, 3, 1, k) - db(r0, 3, 1, k)) < 0.5, `${db(r, 2, 1, k)} ${db(r, 3, 1, k)} vs ${db(r0, 2, 1, k)} ${db(r0, 3, 1, k)}`);
}

// ---- tapers and connectors (#8) ----
{
  const d = parseNetlist(ex('coupler-10dB-ro4350b.cir'));
  const L = buildLayout(d);
  const W = 0.8831, wf = L.items.find(i => i.type === 'port').width;
  check('reference planes are at the full feed width (taper inside the part)', L.core.refs.every(r => near(r.wCore, wf, 1e-9) && near(r.wFeed, wf, 1e-9)));
  const tapers = L.items.filter(i => /^taper/.test(i.label || ''));
  check('a W → feed-width taper at each coupler end', tapers.length === 4 && tapers.every(t => near(dist2(t.pts[0], t.pts[3]), W, 1e-9) && near(dist2(t.pts[1], t.pts[2]), wf, 1e-9)));
  const feeds = L.items.filter(i => i.role === 'feed');
  check('each feed meets its taper end exactly', feeds.every(f => L.core.refs.some(r => dist2(r.at, f.path.at(-1)) < 1e-9)));
  const sig = L.items.filter(i => i.role === 'connector' && i.net !== 'GND');
  check('launch=matched: SMA signal pads are the feed width', sig.length === 4 && sig.every(p => near(p.width, wf, 1e-9)));
  check('connector ground pads reach the board edge and pass DRC', L.errors.length === 0 && L.items.filter(i => i.role === 'connector' && i.net === 'GND').length === 8);
  check('board thickness warning for the 0.062" connector on 0.508 mm RO4350B', L.warnings.length === 1 && /1\.57 mm/.test(L.warnings[0]));
  const ab = parseNetlist(L.netlist);
  check('as-built netlist has the SMA pad section at each port', ['in', 'thru', 'cpl', 'iso'].every(n => ab.sections.some(sc => sc.name === `T${n}_pad`)));
  const lib = buildLayout(parseNetlist(ex('coupler-10dB-ro4350b.cir').replace('.layout coupler K', '.layout coupler K launch=library')));
  const lsig = lib.items.filter(i => i.role === 'connector' && i.net !== 'GND' && i.pts.length === 4);
  check('launch=library: 1.5 mm pad plus a taper to the feed width', lsig.some(p => near(p.width, 1.5, 1e-9)) && /taper to the feed width/.test(lib.notes.join(' ')));
  const r0 = solve(d), rm = solve(ab), rl = solve(parseNetlist(lib.netlist)), k = r0.freq.findIndex(f => f >= 5e9);
  check('matched launch keeps the coupling within 0.3 dB; the library pad on 0.508 mm does not', Math.abs(db(rm, 3, 1, k) - db(r0, 3, 1, k)) < 0.3 && Math.abs(db(rl, 3, 1, k) - db(r0, 3, 1, k)) > 0.5, `${db(rm, 3, 1, k)} ${db(rl, 3, 1, k)} vs ${db(r0, 3, 1, k)}`);
  const none = buildLayout(parseNetlist(ex('coupler-10dB-ro4350b.cir').replace('.layout coupler K', '.layout coupler K connector=none')));
  check('connector=none: no connector copper, old 10 mm pitch', !none.items.some(i => i.role === 'connector') && near(Math.abs(none.items.filter(i => i.type === 'port')[0].y - none.items.filter(i => i.type === 'port')[2].y), 10, 1e-9));
  const tight = buildLayout(parseNetlist(ex('coupler-10dB-ro4350b.cir').replace('.layout coupler K', '.layout coupler K pitch=8mm')));
  check('connector courtyards overlapping at an 8 mm pitch are a DRC error', tight.errors.filter(e => e.rule === 'courtyard').length === 2);
  const touch = buildLayout(parseNetlist(ex('coupler-10dB-ro4350b.cir').replace('.layout coupler K', '.layout coupler K pitch=11.16mm')));
  check('…and touching courtyards (pitch = courtyard width) are not', touch.errors.every(e => e.rule !== 'courtyard'), JSON.stringify(touch.errors));
  const sch = buildLayout(parseNetlist(ex('schiffman-ro4350b.cir')));
  check('no thickness warning on 1.524 mm RO4350B (1.594 mm with copper)', sch.warnings.length === 0);
}

// ---- errors ----
{
  const elec = ex('coupler-10dB-microstrip.cir') + '.substrate jlc-ro4350b-0.508\n.layout coupler K\n';
  check('layout of an impedance-based section asks for physical dimensions', throws(() => buildLayout(parseNetlist(elec)), /physical dimensions/));
  check('unknown template is reported', throws(() => buildLayout(parseNetlist(ex('coupler-10dB-ro4350b.cir').replace('.layout coupler K', '.layout lange K'))), /unknown template/));
  check('unknown .layout option is a parse error', throws(() => parseNetlist(ex('coupler-10dB-ro4350b.cir').replace('.layout coupler K', '.layout coupler K wibble=2')), /unknown \.layout option/));
  const tight = ex('coupler-10dB-ro4350b.cir').replace('.param s = 0.1025mm', '.param s = 0.06mm');
  check('a gap below the fab minimum shows up in the layout DRC', buildLayout(parseNetlist(tight)).errors.some(e => e.rule === 'space'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
