// Layout templates (issue #6): turn a netlist with physical-geometry sections and a `.layout` hint
// into a board layout, plus an "as built" netlist that includes the feed lines the layout adds.
//
//   .layout coupler K [pitch=10mm] [feed=5mm] [margin=4mm]
//   .layout schiffman CS TREF [pitch=..] [feed=..] [margin=..]
//   .layout marchand S1 S2 [pitch=..] [feed=..] [margin=..] [gap=0.5mm] [drill=0.3mm] [vias=2]
//
// Conventions: millimetres, y down. Ports sit on the board edge where an edge-launch SMA connects.
// Feed lines are 50 Ω (the port impedance) microstrip on the substrate; where a feed leaves a coupled
// line it first runs diagonally (45°) at the coupled-line width until it is clear of its neighbour.

import { rect, pathPolygon, pathLength, bbox, drc } from './layout.js';
import { synthMsline, fromSubstrate } from './microstrip.js';
import { toDirective } from './substrates.js';
import { GROUND, OPEN } from './netlist.js';

const mm = (x) => x * 1e3;
const r4 = (x) => +x.toFixed(4);

function getSection(d, name, kind) {
  const s = d.sections.find(x => x.name === name);
  if (!s) throw new Error(`.layout: no section named "${name}"`);
  if (!s.geom || s.geom.kind !== kind) {
    const want = kind === 'msl2' ? '`cline … geom=msl W=… S=…`' : '`T… W=…`';
    throw new Error(`.layout: section ${name} must be given by physical dimensions (${want}); use tools/mscalc.mjs to convert impedances to W and S`);
  }
  return s;
}
const portOf = (d, node) => d.ports.find(p => p.node === node);
function needPort(d, node, what) {
  const p = portOf(d, node);
  if (!p) throw new Error(`.layout: ${what} (node "${node}") must be a port`);
  return p;
}
function isGroundNode(d, node) {
  if (GROUND.has(node)) return true;
  return d.wires.some(([a, b]) => (a === node && GROUND.has(b)) || (b === node && GROUND.has(a)));
}

function feedWidth(d, z, f0) {
  const W = synthMsline({ Z0: z, ...fromSubstrate(d.substrate), f: f0 }).W;
  return mm(W);
}

// Reconstruct .plot / .goal lines so the as-built netlist plots the same things.
function analysisLines(d) {
  const L = [];
  for (const p of d.plots) L.push(`.${p.kind}${p.ylim ? ` ylim=${p.ylim.join(',')}` : ''}${p.title ? ` title=${p.title.replace(/ /g, '_')}` : ''} ${p.traces.map(t => t.src).join(' ')}`);
  return L;
}
function header(d, what) {
  const fr = d.freq;
  return [
    `.title ${d.title ? d.title + ' — ' : ''}as built (${what} layout)`,
    '# Generated from the layout: includes the feed lines the layout adds. Bends, steps and the',
    '# coupling of the diverging feed sections near the coupled lines are not modelled.',
    `.freq ${fr.start} ${fr.stop} ${fr.n}${fr.log ? ' log' : ''}`,
    `.ref ${d.fref}`,
    toDirective(d.substrate),
  ];
}

// A line with diagonal escape: [edge] —straight(Wf)— [escape point] —diag(W)— [line end]
function escapeFeed(end, yTarget, xDir, Wline, Wf, feedLen) {
  const dy = yTarget - end[1], dx = Math.abs(dy) * xDir;
  const esc = [end[0] + dx, yTarget], edge = [end[0] + dx + xDir * feedLen, yTarget];
  return { esc, edge, diagLen: Math.hypot(dx, dy), pts: [edge, esc, end] };
}

// Split a diagonal escape where the wider feed can start: the two diverging centre lines (initial
// centre separation sep0, each moving away at 45°) must be at least (Wf + gap) apart perpendicular
// to the diagonal. Returns the point on the diagonal from `end` towards `esc`.
function splitPoint(end, esc, sep0, Wf, gap) {
  const u = Math.max(0, ((Wf + gap) * Math.SQRT2 - sep0) / 2);          // x-advance needed
  const dx = esc[0] - end[0], dy = esc[1] - end[1], l = Math.hypot(dx, dy);
  const t = Math.min(1, Math.abs(dx) > 0 ? u / Math.abs(dx) : 1);
  return [end[0] + dx * t, end[1] + dy * t];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------- coupler
function coupler(d, [name], o) {
  const K = getSection(d, name, 'msl2');
  const [a1, a2] = K.ends.A, [b1, b2] = K.ends.B;
  const P = [needPort(d, a1, 'line 1 end A'), needPort(d, b1, 'line 1 end B'), needPort(d, a2, 'line 2 end A'), needPort(d, b2, 'line 2 end B')];
  const W = mm(K.geom.W), S = mm(K.geom.S), L = mm(K.len), f0 = K.geom.f0;
  const pitch = o.pitch ?? 10, feedLen = o.feed ?? 5, margin = o.margin ?? 4;
  const yc = (W + S) / 2;
  if (pitch / 2 <= yc + W) throw new Error(`.layout coupler: pitch ${pitch} mm is too small for the line spacing`);
  const items = [], dims = [], nl = [];
  const lines = [[-yc, a1, b1, P[0], P[1]], [yc, a2, b2, P[2], P[3]]];
  lines.forEach(([y, nA, nB, pA, pB], i) => {
    const yp = Math.sign(y) * pitch / 2;
    const fa = escapeFeed([0, y], yp, -1, W, 0, feedLen), fb = escapeFeed([L, y], yp, +1, W, 0, feedLen);
    const wfA = feedWidth(d, pA.z, f0), wfB = feedWidth(d, pB.z, f0);
    const gapMin = Math.max(S, (d.substrate.fab.minSpace ?? 0) * 1e3);
    const sA = splitPoint([0, y], fa.esc, 2 * yc, wfA, gapMin), sB = splitPoint([L, y], fb.esc, 2 * yc, wfB, gapMin);
    items.push({ type: 'poly', layer: 'F.Cu', net: nA, pts: pathPolygon([sA, [0, y], [L, y], sB], W), width: W, label: `line ${i + 1}` });
    items.push({ type: 'poly', layer: 'F.Cu', net: nA, pts: pathPolygon([fa.edge, fa.esc, sA], wfA), width: wfA, label: `feed ${nA}` });
    items.push({ type: 'poly', layer: 'F.Cu', net: nA, pts: pathPolygon([sB, fb.esc, fb.edge], wfB), width: wfB, label: `feed ${nB}` });
    items.push({ type: 'port', name: nA, net: nA, x: fa.edge[0], y: yp, dir: [-1, 0], width: wfA, z0: pA.z });
    items.push({ type: 'port', name: nB, net: nA, x: fb.edge[0], y: yp, dir: [1, 0], width: wfB, z0: pB.z });
    nl.push(`T${nA}_f ${nA} ${nA}_e W=${r4(wfA)}mm len=${r4(feedLen + dist(fa.esc, sA))}mm`, `T${nA}_d ${nA}_e ${nA}_k W=${r4(W)}mm len=${r4(dist(sA, [0, y]))}mm`);
    nl.push(`T${nB}_d ${nB}_k ${nB}_e W=${r4(W)}mm len=${r4(dist(sB, [L, y]))}mm`, `T${nB}_f ${nB}_e ${nB} W=${r4(wfB)}mm len=${r4(feedLen + dist(fb.esc, sB))}mm`);
  });
  const x0 = -(pitch / 2 - yc) - feedLen, x1 = L + (pitch / 2 - yc) + feedLen;
  const outline = rect(x0, -pitch / 2 - margin, x1, pitch / 2 + margin);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [0, -yc - W / 2 - 1.2], b: [L, -yc - W / 2 - 1.2], text: `L ${r4(L)} mm` });
  dims.push({ a: [L / 2, yc + W / 2 + 1.2], b: [L / 2, yc + W / 2 + 1.2], text: `W ${r4(W)} · S ${r4(S)} mm`, dy: 0.6 });
  const netlist = [...header(d, 'coupler'), ...d.ports.map(p => `port ${p.node} ${p.z}`),
    `cline ${name} geom=msl W=${r4(W)}mm S=${r4(S)}mm`, `  len ${r4(L)}mm`, `  A ${a1}_k ${a2}_k`, `  B ${b1}_k ${b2}_k`, 'end', ...nl, ...analysisLines(d)].join('\n') + '\n';
  return { outline, items, dims, netlist, notes: [`ports on ${pitch} mm pitch; feeds ${feedLen} mm long at the port impedance`] };
}

// ---------------------------------------------------------------- Schiffman C-section + reference line
function schiffman(d, [cName, rName], o) {
  if (!cName || !rName) throw new Error('.layout schiffman needs the C-section and the reference line: .layout schiffman CS TREF');
  const C = getSection(d, cName, 'msl2'), R = getSection(d, rName, 'msl1');
  const [a1, a2] = C.ends.A, [b1, b2] = C.ends.B;
  if (b1 !== b2) throw new Error(`.layout schiffman: the far ends of ${cName} must be joined (same node on both lines at end B)`);
  const pa = needPort(d, a1, 'C-section port 1'), pb = needPort(d, a2, 'C-section port 2');
  const r1 = needPort(d, R.ends.A[0], 'reference input'), r2 = needPort(d, R.ends.B[0], 'reference output');
  const W = mm(C.geom.W), S = mm(C.geom.S), L = mm(C.len), f0 = C.geom.f0;
  const Wr = mm(R.geom.W), Lr = mm(R.len);
  const pitch = o.pitch ?? 10, feedLen = o.feed ?? 5, margin = o.margin ?? 4;
  const yc = (W + S) / 2;
  const items = [], dims = [], nl = [];
  const feeds = [];
  [[-yc, a1, pa], [yc, a2, pb]].forEach(([y, n, p], i) => {
    const yp = Math.sign(y) * pitch / 2;
    const fa = escapeFeed([0, y], yp, -1, W, 0, feedLen), wf = feedWidth(d, p.z, f0);
    const sp = splitPoint([0, y], fa.esc, 2 * yc, wf, Math.max(S, (d.substrate.fab.minSpace ?? 0) * 1e3));
    items.push({ type: 'poly', layer: 'F.Cu', net: a1, pts: pathPolygon([sp, [0, y], [L, y]], W), width: W, label: `C-section line ${i + 1}` });
    items.push({ type: 'poly', layer: 'F.Cu', net: a1, pts: pathPolygon([fa.edge, fa.esc, sp], wf), width: wf, label: `feed ${n}` });
    items.push({ type: 'port', name: n, net: a1, x: fa.edge[0], y: yp, dir: [-1, 0], width: wf, z0: p.z });
    feeds.push({ n, wf, diag: fa.diagLen });
    nl.push(`T${n}_f ${n} ${n}_e W=${r4(wf)}mm len=${r4(feedLen + dist(fa.esc, sp))}mm`, `T${n}_d ${n}_e ${n}_k W=${r4(W)}mm len=${r4(dist(sp, [0, y]))}mm`);
  });
  items.push({ type: 'poly', layer: 'F.Cu', net: a1, pts: rect(L, -yc - W / 2, L + W, yc + W / 2), width: W, label: 'C-section bridge' });
  // reference line, lengthened by the C-section's feed lengths so the designed phase difference is kept
  const x0 = -(pitch / 2 - yc) - feedLen;
  const extra = feeds.reduce((a, f) => a + feedLen + f.diag, 0);
  const Ltot = Lr + extra, yr = pitch / 2 + pitch;
  const x1 = x0 + Ltot;
  if (x1 < L + W + 2) throw new Error('.layout schiffman: the reference line is shorter than the C-section; check the reference length');
  items.push({ type: 'poly', layer: 'F.Cu', net: r1.node, pts: rect(x0, yr - Wr / 2, x1, yr + Wr / 2), width: Wr, label: 'reference line' });
  items.push({ type: 'port', name: r1.node, net: r1.node, x: x0, y: yr, dir: [-1, 0], width: Wr, z0: r1.z });
  items.push({ type: 'port', name: r2.node, net: r1.node, x: x1, y: yr, dir: [1, 0], width: Wr, z0: r2.z });
  const outline = rect(x0, -pitch / 2 - margin, x1, yr + margin);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [0, -yc - W / 2 - 1.2], b: [L, -yc - W / 2 - 1.2], text: `L ${r4(L)} mm` });
  dims.push({ a: [x0, yr + Wr / 2 + 1.2], b: [x1, yr + Wr / 2 + 1.2], text: `reference ${r4(Ltot)} mm (${r4(Lr)} + feeds ${r4(extra)})` });
  const netlist = [...header(d, 'Schiffman'), ...d.ports.map(p => `port ${p.node} ${p.z}`),
    `cline ${cName} geom=msl W=${r4(W)}mm S=${r4(S)}mm`, `  len ${r4(L)}mm`, `  A ${a1}_k ${a2}_k`, `  B ${b1} ${b2}`, 'end', ...nl,
    `T${rName} ${r1.node} ${r2.node} W=${r4(Wr)}mm len=${r4(Ltot)}mm`, ...analysisLines(d)].join('\n') + '\n';
  return { outline, items, dims, netlist, notes: [`reference line lengthened by the C-section feeds (${r4(extra)} mm) to keep the designed phase difference`, 'the bridge joining the C-section far ends is not modelled'] };
}

// ---------------------------------------------------------------- Marchand balun
function marchand(d, [n1, n2], o) {
  if (!n1 || !n2) throw new Error('.layout marchand needs both coupled sections: .layout marchand S1 S2');
  const S1 = getSection(d, n1, 'msl2'), S2 = getSection(d, n2, 'msl2');
  // main line: index m with S1.B[m] === S2.A[m] (continues through both sections)
  const m = [0, 1].find(i => S1.ends.B[i] === S2.ends.A[i]);
  if (m == null) throw new Error(`.layout marchand: no line continues from ${n1} end B into ${n2} end A`);
  const s = 1 - m;
  const inNode = S1.ends.A[m], pin = needPort(d, inNode, 'main-line input');
  if (!OPEN.has(S2.ends.B[m])) throw new Error(`.layout marchand: the main line must be open at ${n2} end B`);
  if (!isGroundNode(d, S1.ends.A[s]) || !isGroundNode(d, S2.ends.B[s])) throw new Error('.layout marchand: the secondary lines must be grounded at their outer ends');
  const op = needPort(d, S1.ends.B[s], `${n1} secondary output`), on = needPort(d, S2.ends.A[s], `${n2} secondary output`);
  const W1 = mm(S1.geom.W), Sg1 = mm(S1.geom.S), L1 = mm(S1.len), W2 = mm(S2.geom.W), Sg2 = mm(S2.geom.S), L2 = mm(S2.len), f0 = S1.geom.f0;
  if (Math.abs(W1 - W2) > 1e-6 || Math.abs(Sg1 - Sg2) > 1e-6) throw new Error('.layout marchand: both sections must have the same W and S in this template');
  const W = W1, Sg = Sg1;
  const pitch = o.pitch ?? 10, feedLen = o.feed ?? 5, margin = o.margin ?? 4;
  const fab = d.substrate.fab;
  const gap = o.gap ?? Math.max(0.5, (fab.minSpace ?? 0) * 1e3);
  const drill = o.drill ?? Math.max(0.3, (fab.minDrill ?? 0) * 1e3), viaPad = drill + 0.3, nv = Math.max(1, Math.round(o.vias ?? 2));
  const ys = W + Sg;                       // secondary centre line (main line at y = 0)
  const xs2 = L1 + gap, xend = xs2 + L2;
  const items = [], dims = [], nl = [];
  // main line with escaping input feed (upwards, away from the secondary)
  const wfi = feedWidth(d, pin.z, f0), yIn = -Math.max(2 * wfi, 2);
  const fi = escapeFeed([0, 0], yIn, -1, W, 0, feedLen);
  // only the main line moves away here, so the separation grows half as fast: split twice as far out
  const sp0 = splitPoint([0, 0], fi.esc, W + Sg, wfi, Math.max(Sg, (fab.minSpace ?? 0) * 1e3));
  const si = [2 * sp0[0], 2 * sp0[1]].map((v, i) => (Math.abs(v) > Math.abs(fi.esc[i]) ? fi.esc[i] : v));
  items.push({ type: 'poly', layer: 'F.Cu', net: inNode, pts: pathPolygon([si, [0, 0], [xend, 0]], W), width: W, label: 'main line' });
  items.push({ type: 'poly', layer: 'F.Cu', net: inNode, pts: pathPolygon([fi.edge, fi.esc, si], wfi), width: wfi, label: `feed ${inNode}` });
  items.push({ type: 'port', name: inNode, net: inNode, x: fi.edge[0], y: yIn, dir: [-1, 0], width: wfi, z0: pin.z });
  // secondary lines with grounded end pads
  const padLen = viaPad * 1.6;
  items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: rect(-padLen, ys - W / 2, L1, ys + W / 2), width: W, label: `${n1} secondary` });
  items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: rect(xs2, ys - W / 2, xend + padLen, ys + W / 2), width: W, label: `${n2} secondary` });
  const viaYs = nv === 1 || W < 2 * viaPad ? [ys] : Array.from({ length: nv }, (_, i) => ys - W / 2 + viaPad / 2 + i * (W - viaPad) / (nv - 1));
  for (const vy of viaYs) {
    items.push({ type: 'via', x: -padLen / 2, y: vy, drill, pad: viaPad, net: 'GND' });
    items.push({ type: 'via', x: xend + padLen / 2, y: vy, drill, pad: viaPad, net: 'GND' });
  }
  // output feeds: down from the secondary inner ends, then diverge to the bottom edge
  const xc = L1 + gap / 2, ybot0 = ys + W / 2 + Math.max(1, W);
  const outs = [];
  [[L1 - W / 2, xc - pitch / 2, op], [xs2 + W / 2, xc + pitch / 2, on]].forEach(([x, xt, p]) => {
    const wf = feedWidth(d, p.z, f0);
    const dx = xt - x, yd = ybot0 + Math.abs(dx), yedge = yd + feedLen;
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: pathPolygon([[x, ys], [x, ybot0], [xt, yd], [xt, yedge]], W), width: W, label: `feed ${p.node}` });
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: rect(xt - wf / 2, yd, xt + wf / 2, yedge), width: wf, label: `feed ${p.node}` });
    items.push({ type: 'port', name: p.node, net: 'GND', x: xt, y: yedge, dir: [0, 1], width: wf, z0: p.z });
    outs.push({ p, wf, stub: ybot0 - ys, diag: Math.hypot(dx, dx), yedge });
  });
  const x0 = fi.edge[0], x1 = Math.max(xend + padLen, xc + pitch / 2 + wfi) + margin;
  const y0 = yIn - margin, y1 = outs[0].yedge;
  const outline = rect(x0, y0, x1, y1);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [0, -W / 2 - 0.9], b: [L1, -W / 2 - 0.9], text: `L ${r4(L1)} mm` });
  dims.push({ a: [xs2, -W / 2 - 0.9], b: [xend, -W / 2 - 0.9], text: `L ${r4(L2)} mm` });
  // as-built netlist
  nl.push(`T${inNode}_f ${inNode} ${inNode}_e W=${r4(wfi)}mm len=${r4(feedLen + dist(fi.esc, si))}mm`, `T${inNode}_d ${inNode}_e ${inNode}_k W=${r4(W)}mm len=${r4(dist(si, [0, 0]))}mm`);
  nl.push(`Tgap m1 m2 W=${r4(W)}mm len=${r4(gap)}mm      # main line between the sections (uncoupled)`);
  outs.forEach(({ p, wf, stub, diag }) => {
    nl.push(`T${p.node}_s ${p.node}_k ${p.node}_e W=${r4(W)}mm len=${r4(stub + diag)}mm`, `T${p.node}_f ${p.node}_e ${p.node} W=${r4(wf)}mm len=${r4(feedLen)}mm`);
  });
  const A1 = [], B1 = [], A2 = [], B2 = [];
  A1[m] = `${inNode}_k`; A1[s] = '0'; B1[m] = 'm1'; B1[s] = `${op.node}_k`;
  A2[m] = 'm2'; A2[s] = `${on.node}_k`; B2[m] = '-'; B2[s] = '0';
  const netlist = [...header(d, 'Marchand'), ...d.ports.map(p => `port ${p.node} ${p.z}`),
    `cline ${n1} geom=msl W=${r4(W)}mm S=${r4(Sg)}mm`, `  len ${r4(L1)}mm`, `  A ${A1.join(' ')}`, `  B ${B1.join(' ')}`, 'end',
    `cline ${n2} geom=msl W=${r4(W)}mm S=${r4(Sg)}mm`, `  len ${r4(L2)}mm`, `  A ${A2.join(' ')}`, `  B ${B2.join(' ')}`, 'end',
    ...nl, '# grounded ends: ideal shorts here; via inductance comes with issue #5', ...analysisLines(d)].join('\n') + '\n';
  return { outline, items, dims, netlist, notes: [`sections separated by ${r4(gap)} mm (uncoupled main line) to bring the two outputs out`, `${nv} via(s) of ${drill} mm drill at each grounded end; via inductance not yet modelled (issue #5)`, 'outputs are DC-grounded through the secondary lines (net GND)'] };
}

const TEMPLATES = { coupler, schiffman, marchand };
export const templateNames = Object.keys(TEMPLATES);

// Build the layout for a parsed netlist with a .layout statement. Returns the layout with DRC results.
export function buildLayout(d) {
  if (!d.layout) throw new Error('no .layout statement');
  const t = TEMPLATES[d.layout.type];
  if (!t) throw new Error(`.layout: unknown template "${d.layout.type}" (available: ${templateNames.join(', ')})`);
  if (!d.substrate) throw new Error('.layout needs a .substrate');
  const L = t(d, d.layout.sections, d.layout.opts);
  L.title = d.title || `${d.layout.type} layout`;
  L.type = d.layout.type;
  L.substrate = d.substrate;
  L.errors = drc(L);
  const bb = bbox([L.outline]);
  L.size = [bb.x1 - bb.x0, bb.y1 - bb.y0];
  return L;
}
