// Chip resistors (#37): Wilkinson isolation resistors and terminations — parasitic model, netlist
// element and footprint geometry. SI units unless stated (geometry in mm, as in js/layout.js).
//
// Sources and assumptions
//   Land patterns: KiCad library Resistor_SMD:R_0402_1005Metric / R_0603_1608Metric / R_0805_2012Metric
//     (CC-BY-SA 4.0 with the KiCad library exception).
//   ESL (0.4 / 0.6 / 0.8 nH) and the body capacitance across the part (cp, 0.03 pF) are TYPICAL values
//     for thin-film chip resistors, not from a particular datasheet: set esl= and cp= from your part.
//
// Model, between two nodes (series):   N1 ─ Cpad ─┐            ┌─ Cpad ─ N2      (pads to ground)
//                                          N1 ── ESL ── R ── N2,   cp across ESL+R
// to ground (N2 omitted or 0):          N1 ─ Cpad, N1 ── ESL ── R ── cold pad ── n vias ── ground
import { padC } from './capacitors.js';

export const RES_PACKAGES = {
  '0402': { pads: { x: 0.51, l: 0.54, w: 0.64 }, crt: [0.93, 0.47], esl: 0.4e-9, kicad: 'R_0402_1005Metric' },
  '0603': { pads: { x: 0.825, l: 0.8, w: 0.95 }, crt: [1.48, 0.73], esl: 0.6e-9, kicad: 'R_0603_1608Metric' },
  '0805': { pads: { x: 0.9125, l: 1.025, w: 1.4 }, crt: [1.68, 0.95], esl: 0.8e-9, kicad: 'R_0805_2012Metric' },
};
export const RES_DEFAULT_CP = 0.03e-12;

const rectC = (cx, cy, l, w) => [[cx - l / 2, cy - w / 2], [cx + l / 2, cy - w / 2], [cx + l / 2, cy + w / 2], [cx - l / 2, cy + w / 2]];

/**
 * Footprint geometry in the part's frame (mm): pad 1 centred at x = −x0, pad 2 at +x0 for a series part
 * (centred on the origin); for a termination, pad 1 starts at x = 0 (on the line end, as the loading
 * capacitors do) and a ground land with the vias follows pad 2. Shape as capGeometry: { hot, cold, vias, crt }.
 */
export function resGeometry({ pkg = '0603', ground = false, via = { d: 0.3, n: 2 } }) {
  const fp = RES_PACKAGES[pkg];
  if (!fp) throw new Error(`unknown resistor package ${pkg} (${Object.keys(RES_PACKAGES).join(', ')})`);
  const { x, l, w } = fp.pads;
  if (!ground) {
    const [cx, cy] = fp.crt;
    return { hot: [rectC(-x, 0, l, w)], cold: [rectC(x, 0, l, w)], vias: [], crt: [[-cx, -cy], [cx, -cy], [cx, cy], [-cx, cy]] };
  }
  const ov = 0.05, hx = l / 2, cxp = hx + 2 * x, vp = via.d + 0.3, gap = 0.15;
  const landL = via.n * vp + (via.n - 1) * gap + 0.3, landW = Math.max(w, vp + 0.3), lx0 = cxp + l / 2;
  const vias = Array.from({ length: via.n }, (_, i) => ({ x: lx0 + 0.15 + vp / 2 + i * (vp + gap), y: 0, drill: via.d, pad: vp }));
  const x1 = lx0 + landL, yc = Math.max(fp.crt[1], landW / 2 + 0.25);
  return {
    hot: [[[-ov, -w / 2], [l, -w / 2], [l, w / 2], [-ov, w / 2]]],
    cold: [rectC(cxp, 0, l, w), [[lx0 - ov, -landW / 2], [x1, -landW / 2], [x1, landW / 2], [lx0 - ov, landW / 2]]],
    vias, crt: [[-0.25, -yc], [x1 + 0.25, -yc], [x1 + 0.25, yc], [-0.25, yc]],
  };
}

/**
 * Expand `res NAME N1 [N2] R=.. [pkg=0402|0603|0805] [esl=..] [cp=..] [d=..] [n=..]` into primitive
 * netlist lines. Without a substrate, or with pkg=ideal, it is a plain resistor. Returns { lines, info, warnings }.
 */
export function expandRes({ name, nodes, o, ev, sub, fail }) {
  const n1 = nodes[0], n2 = nodes[1] ?? '0';
  if (!n1 || nodes.length > 2) fail('res NAME N1 [N2] R=.. [pkg=0402|0603|0805] [esl=..] [cp=..] [d=..] [n=..]');
  const known = new Set(['r', 'pkg', 'esl', 'cp', 'd', 'n']);
  for (const k of Object.keys(o)) if (!known.has(k)) fail(`unknown res option ${k}`);
  const R = o.r != null ? ev(o.r) : NaN;
  if (!(R > 0)) fail('res: R= (> 0) is required');
  const ground = n2 === '0' || /^gnd$/i.test(n2), pkg = o.pkg ?? '0603', lines = [], warnings = [];
  const num = (v) => String(+v.toPrecision(8));
  if (pkg === 'ideal') { lines.push(`R${name} ${n1} ${n2} ${num(R)}`); return { lines, warnings, info: { pkg, R, ground } }; }
  if (!RES_PACKAGES[pkg]) fail(`unknown resistor package ${pkg} (${Object.keys(RES_PACKAGES).join(', ')}, ideal)`);
  if (!sub) fail('res with a package needs a .substrate before it (pads and vias), or pkg=ideal');
  const p = RES_PACKAGES[pkg], esl = o.esl != null ? ev(o.esl) : p.esl, cp = o.cp != null ? ev(o.cp) : RES_DEFAULT_CP;
  const via = { d: o.d != null ? ev(o.d) : Math.max(0.3e-3, sub.fab?.minDrill ?? 0.3e-3), n: o.n != null ? Math.round(ev(o.n)) : 2 };
  const Cp = padC({ W: p.pads.w, L: p.pads.l, sub });
  const far = ground ? `${name}_y` : n2;
  lines.push(`C${name}_p1 ${n1} 0 ${num(Cp)}`, `L${name}_esl ${n1} ${name}_x ${num(esl)}`, `R${name}_r ${name}_x ${far} ${num(R)}`);
  if (cp > 0) lines.push(`C${name}_cp ${n1} ${far} ${num(cp)}`);
  if (ground) lines.push(`via V${name} ${far} d=${num(via.d)} n=${via.n}`);
  else lines.push(`C${name}_p2 ${n2} 0 ${num(Cp)}`);
  return { lines, warnings, info: { pkg, R, esl, cp, Cpad: Cp, ground, via } };
}
