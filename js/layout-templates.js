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

import { rect, pathPolygon, pathLength, bbox, drc, cutPath, unit } from './layout.js';
import { synthMsline, fromSubstrate } from './microstrip.js';
import { toDirective } from './substrates.js';
import { GROUND, OPEN } from './netlist.js';
import { openEnd, viaL } from './discontinuities.js';
const viaLpH = (drillMm, h, n) => viaL({ d: drillMm / 1e3, h, n }).L * 1e12;
import { getConnector, launchCopper, minFeed, thicknessWarning, LAUNCH_MODES } from './connectors.js';
import { capGeometry, smdForCeff, printedSize } from './capacitors.js';

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

function coreNetlist(d, what, body) {
  const fr = d.freq;
  return [
    `.title ${d.title ? d.title + ' — ' : ''}core (${what}), between the footprint reference planes`,
    '# Generated with the KiCad part: ports are at the pad edges where the board feeds attach.',
    '# Bends, steps and the coupling of the diverging lines near the coupled section are not modelled.',
    `.freq ${fr.start} ${fr.stop} ${fr.n}${fr.log ? ' log' : ''}`,
    `.ref ${d.fref}`,
    toDirective(d.substrate),
    ...d.ports.map(p => `port ${p.node} ${p.z}`),
    ...body,
    ...analysisLines(d),
  ].join('\n') + '\n';
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
const portNum = (d, node) => String(d.ports.findIndex(p => p.node === node) + 1);

// Core description (issue #22): the part between the reference planes, as KiCad pads.
//   pads:  [{ num, node, polys, at }]  one or more polygons per pad (custom pad primitives)
//   vias:  [{ num, node, x, y, drill, pad }]  thru-hole pads (grounding)
//   ties:  [[num, …]]  net-tie groups: pads joined by copper (DC path between different nets)
//   refs:  [{ num, node, at, dir, wCore, wFeed, z0 }]  reference planes, dir pointing out of the core
//   netlist: core-only netlist, ports at the reference planes
// A conductor carrying two ports is cut at its mid-length into two abutting pads in one tie group.
function splitConductor(d, path, W, nodeA, nodeB) {
  const [pa, pb] = cutPath(dedupe(path), 0.5);
  const inset = (pts) => { const u = unit(pts[0], pts[1]); const a = Math.min(W / 4, 0.05); return [pts[0][0] + u[0] * a, pts[0][1] + u[1] * a]; };
  return [
    { num: portNum(d, nodeA), node: nodeA, polys: [pathPolygon(pa, W)], at: inset(pa) },
    { num: portNum(d, nodeB), node: nodeB, polys: [pathPolygon(pb, W)], at: inset([...pb].reverse()) },
  ];
}
// Linear width taper from the line width W at P to the feed width wf, along the unit direction u
// (pointing away from the part). Replaces the abrupt step at the reference plane.
// Length max(wf, 3|wf − W|), limited to maxLen. Returns { T (taper end), poly, Lt }.
function taper(P, u, W, wf, maxLen) {
  if (Math.abs(wf - W) < 1e-3 || !(maxLen > 0)) return { T: P, poly: null, Lt: 0 };
  const Lt = Math.min(Math.max(wf, 3 * Math.abs(wf - W)), maxLen);
  const n = [-u[1], u[0]], T = [P[0] + u[0] * Lt, P[1] + u[1] * Lt];
  const poly = [[P[0] + n[0] * W / 2, P[1] + n[1] * W / 2], [T[0] + n[0] * wf / 2, T[1] + n[1] * wf / 2], [T[0] - n[0] * wf / 2, T[1] - n[1] * wf / 2], [P[0] - n[0] * W / 2, P[1] - n[1] * W / 2]];
  return { T, poly, Lt };
}
// Netlist for a taper as N stepped sections, from node `a` (width wa) to node `b` (width wb).
function taperNl(name, a, b, wa, wb, Lt, N = 3) {
  if (!(Lt > 0)) return [`wire ${a} ${b}`];
  const out = [];
  for (let k = 0; k < N; k++) {
    const w = wa + (wb - wa) * (k + 0.5) / N;
    out.push(`T${name}_t${k + 1} ${k ? `${name}_tp${k}` : a} ${k === N - 1 ? b : `${name}_tp${k + 1}`} W=${r4(w)}mm len=${r4(Lt / N)}mm`);
  }
  return out;
}
const refOf = (d, node, at, dir, wCore, wFeed) => ({ num: portNum(d, node), node, at, dir, wCore, wFeed, z0: portOf(d, node).z });
const dedupe = (pts) => pts.filter((q, k) => k === 0 || dist(q, pts[k - 1]) > 1e-9);

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
  const core = { pads: [], vias: [], ties: [], refs: [], nl: [] };
  const lines = [[-yc, a1, b1, P[0], P[1]], [yc, a2, b2, P[2], P[3]]];
  lines.forEach(([y, nA, nB, pA, pB], i) => {
    const yp = Math.sign(y) * pitch / 2;
    const fa = escapeFeed([0, y], yp, -1, W, 0, feedLen), fb = escapeFeed([L, y], yp, +1, W, 0, feedLen);
    const wfA = feedWidth(d, pA.z, f0), wfB = feedWidth(d, pB.z, f0);
    const gapMin = Math.max(S, (d.substrate.fab.minSpace ?? 0) * 1e3);
    const sA = splitPoint([0, y], fa.esc, 2 * yc, wfA, gapMin), sB = splitPoint([L, y], fb.esc, 2 * yc, wfB, gapMin);
    const linePath = [sA, [0, y], [L, y], sB];
    const uA = unit([0, y], fa.esc), uB = unit([L, y], fb.esc);
    const ta = taper(sA, uA, W, wfA, 0.8 * dist(sA, fa.esc)), tb = taper(sB, uB, W, wfB, 0.8 * dist(sB, fb.esc));
    items.push({ type: 'poly', layer: 'F.Cu', net: nA, pts: pathPolygon(linePath, W), width: W, label: `line ${i + 1}`, role: 'core' });
    for (const t of [ta, tb]) if (t.poly) items.push({ type: 'poly', layer: 'F.Cu', net: nA, pts: t.poly, width: W, label: `taper ${i + 1}`, role: 'core' });
    items.push({ type: 'poly', layer: 'F.Cu', net: nA, pts: pathPolygon(dedupe([fa.edge, fa.esc, ta.T]), wfA), width: wfA, label: `feed ${nA}`, role: 'feed', node: nA, path: dedupe([fa.edge, fa.esc, ta.T]) });
    items.push({ type: 'poly', layer: 'F.Cu', net: nA, pts: pathPolygon(dedupe([tb.T, fb.esc, fb.edge]), wfB), width: wfB, label: `feed ${nB}`, role: 'feed', node: nB, path: dedupe([fb.edge, fb.esc, tb.T]) });
    const halves = splitConductor(d, linePath, W, nA, nB);
    if (ta.poly) halves[0].polys.push(ta.poly);
    if (tb.poly) halves[1].polys.push(tb.poly);
    core.pads.push(...halves);
    core.ties.push([portNum(d, nA), portNum(d, nB)]);
    core.refs.push(refOf(d, nA, ta.T, uA, wfA, wfA), refOf(d, nB, tb.T, uB, wfB, wfB));
    core.nl.push(...taperNl(nA, nA, `${nA}_s`, wfA, W, ta.Lt), `T${nA}_d ${nA}_s ${nA}_k W=${r4(W)}mm len=${r4(dist(sA, [0, y]))}mm`,
      `T${nB}_d ${nB}_k ${nB}_s W=${r4(W)}mm len=${r4(dist(sB, [L, y]))}mm`, ...taperNl(nB, `${nB}_s`, nB, W, wfB, tb.Lt));
    items.push({ type: 'port', name: nA, net: nA, x: fa.edge[0], y: yp, dir: [-1, 0], width: wfA, z0: pA.z });
    items.push({ type: 'port', name: nB, net: nA, x: fb.edge[0], y: yp, dir: [1, 0], width: wfB, z0: pB.z });
    nl.push(`T${nA}_f ${nA} ${nA}_e W=${r4(wfA)}mm len=${r4(feedLen + dist(fa.esc, ta.T))}mm`, ...taperNl(nA, `${nA}_e`, `${nA}_s`, wfA, W, ta.Lt), `T${nA}_d ${nA}_s ${nA}_k W=${r4(W)}mm len=${r4(dist(sA, [0, y]))}mm`);
    nl.push(`T${nB}_d ${nB}_k ${nB}_s W=${r4(W)}mm len=${r4(dist(sB, [L, y]))}mm`, ...taperNl(nB, `${nB}_s`, `${nB}_e`, W, wfB, tb.Lt), `T${nB}_f ${nB}_e ${nB} W=${r4(wfB)}mm len=${r4(feedLen + dist(fb.esc, tb.T))}mm`);
  });
  const x0 = -(pitch / 2 - yc) - feedLen, x1 = L + (pitch / 2 - yc) + feedLen;
  const outline = rect(x0, -pitch / 2 - margin, x1, pitch / 2 + margin);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [0, -yc - W / 2 - 1.2], b: [L, -yc - W / 2 - 1.2], text: `L ${r4(L)} mm` });
  dims.push({ a: [L / 2, yc + W / 2 + 1.2], b: [L / 2, yc + W / 2 + 1.2], text: `W ${r4(W)} · S ${r4(S)} mm`, dy: 0.6 });
  const coupled = [`cline ${name} geom=msl W=${r4(W)}mm S=${r4(S)}mm`, `  len ${r4(L)}mm`, `  A ${a1}_k ${a2}_k`, `  B ${b1}_k ${b2}_k`, 'end'];
  const netlist = [...header(d, 'coupler'), ...d.ports.map(p => `port ${p.node} ${p.z}`), ...coupled, ...nl, ...analysisLines(d)].join('\n') + '\n';
  core.netlist = coreNetlist(d, 'coupler', [...coupled, ...core.nl]);
  return { outline, items, dims, netlist, core, notes: [`ports on ${pitch} mm pitch; feeds ${feedLen} mm long at the port impedance`] };
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
  const core = { pads: [], vias: [], ties: [], refs: [], nl: [] };
  const feeds = [];
  [[-yc, a1, pa], [yc, a2, pb]].forEach(([y, n, p], i) => {
    const yp = Math.sign(y) * pitch / 2;
    const fa = escapeFeed([0, y], yp, -1, W, 0, feedLen), wf = feedWidth(d, p.z, f0);
    const sp = splitPoint([0, y], fa.esc, 2 * yc, wf, Math.max(S, (d.substrate.fab.minSpace ?? 0) * 1e3));
    const linePath = dedupe([sp, [0, y], [L, y]]);
    const uo = unit([0, y], fa.esc), tp = taper(sp, uo, W, wf, 0.8 * dist(sp, fa.esc));
    items.push({ type: 'poly', layer: 'F.Cu', net: a1, pts: pathPolygon(linePath, W), width: W, label: `C-section line ${i + 1}`, role: 'core' });
    if (tp.poly) items.push({ type: 'poly', layer: 'F.Cu', net: a1, pts: tp.poly, width: W, label: `taper ${n}`, role: 'core' });
    items.push({ type: 'poly', layer: 'F.Cu', net: a1, pts: pathPolygon(dedupe([fa.edge, fa.esc, tp.T]), wf), width: wf, label: `feed ${n}`, role: 'feed', node: n, path: dedupe([fa.edge, fa.esc, tp.T]) });
    items.push({ type: 'port', name: n, net: a1, x: fa.edge[0], y: yp, dir: [-1, 0], width: wf, z0: p.z });
    feeds.push({ n, wf, diag: fa.diagLen, lf: feedLen + dist(fa.esc, tp.T) });
    const u = unit(linePath[0], linePath[1]);
    core.pads.push({ num: portNum(d, n), node: n, polys: [pathPolygon(linePath, W), ...(tp.poly ? [tp.poly] : [])], at: [sp[0] + u[0] * Math.min(W / 4, 0.05), sp[1] + u[1] * Math.min(W / 4, 0.05)] });
    core.refs.push(refOf(d, n, tp.T, uo, wf, wf));
    nl.push(`T${n}_f ${n} ${n}_e W=${r4(wf)}mm len=${r4(feedLen + dist(fa.esc, tp.T))}mm`, ...taperNl(n, `${n}_e`, `${n}_s`, wf, W, tp.Lt), `T${n}_d ${n}_s ${n}_k W=${r4(W)}mm len=${r4(dist(sp, [0, y]))}mm`);
    core.nl.push(...taperNl(n, n, `${n}_s`, wf, W, tp.Lt), `T${n}_d ${n}_s ${n}_k W=${r4(W)}mm len=${r4(dist(sp, [0, y]))}mm`);
  });
  const bridge = rect(L, -yc - W / 2, L + W, yc + W / 2);
  items.push({ type: 'poly', layer: 'F.Cu', net: a1, pts: bridge, width: W, label: 'C-section bridge', role: 'core' });
  core.pads[0].polys.push(bridge);
  core.ties.push([portNum(d, a1), portNum(d, a2)]);
  // reference line, lengthened by the C-section's feed lengths so the designed phase difference is kept
  const x0 = -(pitch / 2 - yc) - feedLen;
  const extra = feeds.reduce((a, f) => a + feedLen + f.diag, 0);
  const Ltot = Lr + extra, yr = pitch / 2 + pitch;
  const x1 = x0 + Ltot;
  if (x1 < L + W + 2) throw new Error('.layout schiffman: the reference line is shorter than the C-section; check the reference length');
  items.push({ type: 'poly', layer: 'F.Cu', net: r1.node, pts: rect(x0, yr - Wr / 2, x1, yr + Wr / 2), width: Wr, label: 'reference line', role: 'core' });
  // core part of the reference line: the board feeds on it match the C-section feeds in length, so
  // the phase difference between the paths is set by the core alone
  const lf = feeds[0].lf, xr0 = x0 + lf, xr1 = x1 - lf;
  if (xr1 - xr0 < 2 * Wr) throw new Error('.layout schiffman: the reference line is too short to carry feeds matching the C-section feeds');
  items.at(-1).feeds = [{ node: r1.node, path: [[x0, yr], [xr0, yr]], width: Wr }, { node: r2.node, path: [[x1, yr], [xr1, yr]], width: Wr }];
  core.pads.push(...splitConductor(d, [[xr0, yr], [xr1, yr]], Wr, r1.node, r2.node));
  core.ties.push([portNum(d, r1.node), portNum(d, r2.node)]);
  core.refs.push(refOf(d, r1.node, [xr0, yr], [-1, 0], Wr, Wr), refOf(d, r2.node, [xr1, yr], [1, 0], Wr, Wr));
  core.nl.push(`T${rName} ${r1.node} ${r2.node} W=${r4(Wr)}mm len=${r4(xr1 - xr0)}mm`);
  items.push({ type: 'port', name: r1.node, net: r1.node, x: x0, y: yr, dir: [-1, 0], width: Wr, z0: r1.z });
  items.push({ type: 'port', name: r2.node, net: r1.node, x: x1, y: yr, dir: [1, 0], width: Wr, z0: r2.z });
  const outline = rect(x0, -pitch / 2 - margin, x1, yr + margin);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [0, -yc - W / 2 - 1.2], b: [L, -yc - W / 2 - 1.2], text: `L ${r4(L)} mm` });
  dims.push({ a: [x0, yr + Wr / 2 + 1.2], b: [x1, yr + Wr / 2 + 1.2], text: `reference ${r4(Ltot)} mm (${r4(Lr)} + feeds ${r4(extra)})` });
  const coupled = [`cline ${cName} geom=msl W=${r4(W)}mm S=${r4(S)}mm`, `  len ${r4(L)}mm`, `  A ${a1}_k ${a2}_k`, `  B ${b1} ${b2}`, 'end'];
  const netlist = [...header(d, 'Schiffman'), ...d.ports.map(p => `port ${p.node} ${p.z}`), ...coupled, ...nl,
    `T${r1.node}_f ${r1.node} ${r1.node}_e W=${r4(Wr)}mm len=${r4(lf)}mm`, `T${rName} ${r1.node}_e ${r2.node}_e W=${r4(Wr)}mm len=${r4(xr1 - xr0)}mm`,
    `T${r2.node}_f ${r2.node}_e ${r2.node} W=${r4(Wr)}mm len=${r4(lf)}mm`, ...analysisLines(d)].join('\n') + '\n';
  core.netlist = coreNetlist(d, 'Schiffman', [...coupled, ...core.nl]);
  return { outline, items, dims, netlist, core, notes: [`reference line lengthened by the C-section feeds (${r4(extra)} mm) to keep the designed phase difference`, 'the bridge joining the C-section far ends is not modelled'] };
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
  const core = { pads: [], vias: [], ties: [], refs: [], nl: [] };
  const G = String(d.ports.length + 1);         // pad number of the grounding pads
  // main line with escaping input feed (upwards, away from the secondary)
  const wfi = feedWidth(d, pin.z, f0), yIn = -Math.max(2 * wfi, 2);
  const fi = escapeFeed([0, 0], yIn, -1, W, 0, feedLen);
  // only the main line moves away here, so the separation grows half as fast: split twice as far out
  const sp0 = splitPoint([0, 0], fi.esc, W + Sg, wfi, Math.max(Sg, (fab.minSpace ?? 0) * 1e3));
  const si = [2 * sp0[0], 2 * sp0[1]].map((v, i) => (Math.abs(v) > Math.abs(fi.esc[i]) ? fi.esc[i] : v));
  const mainPath = dedupe([si, [0, 0], [xend, 0]]);
  const ui = unit([0, 0], fi.esc), ti = taper(si, ui, W, wfi, 0.8 * dist(si, fi.esc));
  items.push({ type: 'poly', layer: 'F.Cu', net: inNode, pts: pathPolygon(mainPath, W), width: W, label: 'main line', role: 'core' });
  if (ti.poly) items.push({ type: 'poly', layer: 'F.Cu', net: inNode, pts: ti.poly, width: W, label: `taper ${inNode}`, role: 'core' });
  items.push({ type: 'poly', layer: 'F.Cu', net: inNode, pts: pathPolygon(dedupe([fi.edge, fi.esc, ti.T]), wfi), width: wfi, label: `feed ${inNode}`, role: 'feed', node: inNode, path: dedupe([fi.edge, fi.esc, ti.T]) });
  { const u = unit(mainPath[0], mainPath[1]), a = Math.min(W / 4, 0.05);
    core.pads.push({ num: portNum(d, inNode), node: inNode, polys: [pathPolygon(mainPath, W), ...(ti.poly ? [ti.poly] : [])], at: [si[0] + u[0] * a, si[1] + u[1] * a] });
    core.refs.push(refOf(d, inNode, ti.T, ui, wfi, wfi)); }
  items.push({ type: 'port', name: inNode, net: inNode, x: fi.edge[0], y: yIn, dir: [-1, 0], width: wfi, z0: pin.z });
  // secondary lines with grounded end pads
  const padLen = viaPad * 1.6;
  items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: rect(-padLen, ys - W / 2, L1, ys + W / 2), width: W, label: `${n1} secondary`, role: 'core' });
  items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: rect(xs2, ys - W / 2, xend + padLen, ys + W / 2), width: W, label: `${n2} secondary`, role: 'core' });
  // each secondary: grounded half (pad G, with the vias) and output half (output port pad), tied
  const xm1 = L1 / 2, xm2 = xs2 + L2 / 2;
  core.pads.push({ num: G, node: 'GND', polys: [rect(-padLen, ys - W / 2, xm1, ys + W / 2)], at: [-padLen / 2, ys] });
  core.pads.push({ num: G, node: 'GND', polys: [rect(xm2, ys - W / 2, xend + padLen, ys + W / 2)], at: [xend + padLen / 2, ys] });
  const viaYs = nv === 1 || W < 2 * viaPad ? [ys] : Array.from({ length: nv }, (_, i) => ys - W / 2 + viaPad / 2 + i * (W - viaPad) / (nv - 1));
  for (const vy of viaYs) {
    items.push({ type: 'via', x: -padLen / 2, y: vy, drill, pad: viaPad, net: 'GND', role: 'core' });
    items.push({ type: 'via', x: xend + padLen / 2, y: vy, drill, pad: viaPad, net: 'GND', role: 'core' });
    core.vias.push({ num: G, node: 'GND', x: -padLen / 2, y: vy, drill, pad: viaPad }, { num: G, node: 'GND', x: xend + padLen / 2, y: vy, drill, pad: viaPad });
  }
  // output feeds: down from the secondary inner ends, then diverge to the bottom edge
  const xc = L1 + gap / 2, ybot0 = ys + W / 2 + Math.max(1, W);
  const outs = [];
  [[L1 - W / 2, xc - pitch / 2, op, [xm1, L1]], [xs2 + W / 2, xc + pitch / 2, on, [xs2, xm2]]].forEach(([x, xt, p, [xa, xb]]) => {
    const wf = feedWidth(d, p.z, f0);
    const dx = xt - x, yd = ybot0 + Math.abs(dx);
    // the stub turns vertical (W/2) before the taper, so the taper starts square to the feed;
    // the straight feed (feedLen) starts after the taper
    const yv = yd + W / 2, stub = dedupe([[x, ys], [x, ybot0], [xt, yd], [xt, yv]]);
    const to = taper([xt, yv], [0, 1], W, wf, Infinity), yedge = to.T[1] + feedLen;
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: pathPolygon(stub, W), width: W, label: `output line ${p.node}`, role: 'core' });
    if (to.poly) items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: to.poly, width: W, label: `taper ${p.node}`, role: 'core' });
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: rect(xt - wf / 2, to.T[1], xt + wf / 2, yedge), width: wf, label: `feed ${p.node}`, role: 'feed', node: p.node, path: [[xt, yedge], to.T] });
    core.pads.push({ num: portNum(d, p.node), node: p.node, polys: [rect(xa, ys - W / 2, xb, ys + W / 2), pathPolygon(stub, W), ...(to.poly ? [to.poly] : [])], at: [xt, yd - Math.min(W / 4, 0.05)] });
    core.refs.push(refOf(d, p.node, to.T, [0, 1], wf, wf));
    items.push({ type: 'port', name: p.node, net: 'GND', x: xt, y: yedge, dir: [0, 1], width: wf, z0: p.z });
    outs.push({ p, wf, stub: ybot0 - ys, diag: Math.hypot(dx, dx) + W / 2, yedge, Lt: to.Lt, feed: yedge - to.T[1] });
  });
  const x0 = fi.edge[0], x1 = Math.max(xend + padLen, xc + pitch / 2 + wfi) + margin;
  const y0 = yIn - margin, y1 = outs[0].yedge;
  const outline = rect(x0, y0, x1, y1);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [0, -W / 2 - 0.9], b: [L1, -W / 2 - 0.9], text: `L ${r4(L1)} mm` });
  dims.push({ a: [xs2, -W / 2 - 0.9], b: [xend, -W / 2 - 0.9], text: `L ${r4(L2)} mm` });
  // as-built netlist
  nl.push(`T${inNode}_f ${inNode} ${inNode}_e W=${r4(wfi)}mm len=${r4(feedLen + dist(fi.esc, ti.T))}mm`, ...taperNl(inNode, `${inNode}_e`, `${inNode}_s`, wfi, W, ti.Lt), `T${inNode}_d ${inNode}_s ${inNode}_k W=${r4(W)}mm len=${r4(dist(si, [0, 0]))}mm`);
  nl.push(`Tgap m1 m2 W=${r4(W)}mm len=${r4(gap)}mm      # main line between the sections (uncoupled)`);
  outs.forEach(({ p, wf, stub, diag, Lt, feed }) => {
    nl.push(`T${p.node}_s ${p.node}_k ${p.node}_v W=${r4(W)}mm len=${r4(stub + diag)}mm`, ...taperNl(p.node, `${p.node}_v`, `${p.node}_e`, W, wf, Lt), `T${p.node}_f ${p.node}_e ${p.node} W=${r4(wf)}mm len=${r4(feed)}mm`);
    core.nl.push(`T${p.node}_s ${p.node}_k ${p.node}_v W=${r4(W)}mm len=${r4(stub + diag)}mm`, ...taperNl(p.node, `${p.node}_v`, p.node, W, wf, Lt));
  });
  core.nl.unshift(...taperNl(inNode, inNode, `${inNode}_s`, wfi, W, ti.Lt), `T${inNode}_d ${inNode}_s ${inNode}_k W=${r4(W)}mm len=${r4(dist(si, [0, 0]))}mm`, `Tgap m1 m2 W=${r4(W)}mm len=${r4(gap)}mm`);
  core.ties.push([portNum(d, op.node), portNum(d, on.node), G]);
  const A1 = [], B1 = [], A2 = [], B2 = [];
  A1[m] = `${inNode}_k`; A1[s] = 'g1'; B1[m] = 'm1'; B1[s] = `${op.node}_k`;
  A2[m] = 'm2'; A2[s] = `${on.node}_k`; B2[m] = 'moe'; B2[s] = 'g2';
  // discontinuities (#5): grounded ends = via-pad stub + vias (Goldfarb–Pucel); open end = Δl (KJK)
  const sub = d.substrate, oe = openEnd({ W: W / 1e3, h: sub.dielectric.h, er: sub.dielectric.er, t: sub.copper.t });
  const disc = [
    `T${n1}_gs g1 g1v W=${r4(W)}mm len=${r4(padLen / 2)}mm     # secondary to the via centre`,
    `via V${n1} g1v d=${r4(drill)}mm n=${nv}`,
    `T${n2}_gs g2 g2v W=${r4(W)}mm len=${r4(padLen / 2)}mm`,
    `via V${n2} g2v d=${r4(drill)}mm n=${nv}`,
    `Tmain_oe moe - W=${r4(W)}mm len=${r4(oe.dl * 1e3)}mm     # open-end extension Δl (Kirschning–Jansen–Koster)`,
  ];
  const coupled = [`cline ${n1} geom=msl W=${r4(W)}mm S=${r4(Sg)}mm`, `  len ${r4(L1)}mm`, `  A ${A1.join(' ')}`, `  B ${B1.join(' ')}`, 'end',
    `cline ${n2} geom=msl W=${r4(W)}mm S=${r4(Sg)}mm`, `  len ${r4(L2)}mm`, `  A ${A2.join(' ')}`, `  B ${B2.join(' ')}`, 'end'];
  const netlist = [...header(d, 'Marchand'), ...d.ports.map(p => `port ${p.node} ${p.z}`), ...coupled,
    ...nl, ...disc, ...analysisLines(d)].join('\n') + '\n';
  core.netlist = coreNetlist(d, 'Marchand', [...coupled, ...core.nl, ...disc]);
  return { outline, items, dims, netlist, core, notes: [`sections separated by ${r4(gap)} mm (uncoupled main line) to bring the two outputs out`, `${nv} via(s) of ${drill} mm drill at each grounded end, modelled as ${viaLpH(drill, sub.dielectric.h, nv).toFixed(0)} pH (Goldfarb–Pucel); main-line open end Δl ${r4(oe.dl * 1e3)} mm (Kirschning–Jansen–Koster)`, 'outputs are DC-grounded through the secondary lines (net GND)'] };
}

// Edge-launch connectors at every port: launch copper in the layout, and the as-built netlist's
// feed split into connector pad + launch taper + the rest of the feed.
function addConnectors(d, L, conn, mode) {
  L.connector = conn;
  const ports = L.items.filter(i => i.type === 'port');
  let lines = L.netlist.split('\n');
  for (const p of ports) {
    const lc = launchCopper(conn, [p.x, p.y], p.dir, p.width, mode);
    p.connector = conn.id; p.launch = lc;
    lc.sig.forEach(pts => L.items.push({ type: 'poly', layer: 'F.Cu', net: p.net, pts, width: lc.pw, label: `${conn.mpn} ${p.name} signal`, role: 'connector', edgeOk: true }));
    lc.gnd.forEach(pts => L.items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts, width: conn.ground.w, label: `${conn.mpn} ${p.name} ground`, role: 'connector', edgeOk: true }));
    // courtyard (connector-local x0..x1 × ±y, +x out of the board), for the overlap check
    const cy = conn.courtyard, [ux, uy] = p.dir, P = (x, y) => [p.x + ux * x - uy * y, p.y + uy * x + ux * y];
    L.items.push({ type: 'courtyard', name: `${conn.mpn} ${p.name}`, pts: [P(cy.x0 - lc.Lt, -cy.y), P(cy.x1, -cy.y), P(cy.x1, cy.y), P(cy.x0 - lc.Lt, cy.y)] });
    const re = new RegExp(`^T${p.name}_f (\\S+) (\\S+) W=([\\d.]+)mm len=([\\d.]+)mm`);
    const i = lines.findIndex(l => re.test(l));
    if (i < 0) throw new Error(`.layout: no feed line for port ${p.name}`);
    const [, a, b, w, len] = lines[i].match(re);
    const rest = +len - conn.signal.l - lc.Lt;
    if (rest < 0) throw new Error(`.layout: the feed at ${p.name} is ${len} mm, shorter than the ${conn.mpn} pad + launch taper (${r4(conn.signal.l + lc.Lt)} mm); increase feed=`);
    const fwd = a === p.name;                               // port node first?
    const pc = `${p.name}_pc`, lt = `${p.name}_lc`;
    const px = `${p.name}_x`;                              // behind the launch placeholder L/C
    const pad = `T${p.name}_pad ${fwd ? `${px} ${pc}` : `${pc} ${px}`} W=${r4(lc.pw)}mm len=${r4(conn.signal.l)}mm`;
    const launch = [`L${p.name}_sma ${p.name} ${px} sma_l`, `C${p.name}_sma ${p.name} 0 sma_c`];
    const tap = fwd ? taperNl(`${p.name}_l`, pc, lt, lc.pw, +w, lc.Lt) : taperNl(`${p.name}_l`, lt, pc, +w, lc.pw, lc.Lt);
    const feed = `T${p.name}_f ${fwd ? `${lt} ${b}` : `${a} ${lt}`} W=${w}mm len=${r4(rest)}mm`;
    lines.splice(i, 1, ...(fwd ? [...launch, pad, ...tap, feed] : [feed, ...tap, pad, ...launch]));
  }
  const at = lines.findIndex(l => l.startsWith('.substrate'));
  lines.splice(at + 1, 0, `# ports: ${conn.name}; its pad and launch taper are line sections. The connector transition is a`,
    '# placeholder series L / shunt C per port (sma_l, sma_c): effectively zero by default; tune or fit them to EM or measured data',
    '.param sma_l = 1p tune 1p 2n', '.param sma_c = 1f tune 1f 1p');
  L.netlist = lines.join('\n');
  const Lts = [...new Set(ports.map(p => r4(p.launch.Lt)))];
  L.notes.push(mode === 'library'
    ? `${conn.name} at each port: KiCad's ${conn.signal.w} × ${conn.signal.l} mm signal pad, then a ${Lts.join('/')} mm taper to the feed width`
    : `${conn.name} at each port: signal pad ${conn.signal.l} mm long at the feed width (launch=matched)`);
  const warn = thicknessWarning(conn, d.substrate);
  L.warnings = warn ? [warn] : [];
}

// ---------------------------------------------------------------- comb-line / interdigital arrays (#15)
//   .layout comb [cap=smd-0603|smd-0402|smd-0805|trimmer|printed] [stub=1mm] [feed=..] [margin=..]
//   .layout interdigital …
// For the netlists the synthesis writes (js/synth-geom.js): N coupled lines given by W/S lists in
// cascaded `cline … geom msl` sections, `via` elements at the shorted ends, tap ports on the outer
// lines through `tee` junctions, loading capacitors (`cap` or ideal `C`) at the open ends of a comb.
// Lines run along y (end A at y = 0); the taps leave sideways to edge ports. The whole array is one
// DC-connected piece of copper with the ground (net GND in the preview; in KiCad the port nets are
// joined to GND by a net tie in the part).
function resonatorArray(d, kind, o) {
  const secs = d.sections.filter(s => s.geom?.kind === 'mslN');
  if (!secs.length) throw new Error(`.layout ${kind}: needs coupled-line sections given by W=[…] S=[…] lists (synthesise with "Realise in microstrip")`);
  const W = secs[0].geom.W.map(mm), S = secs[0].geom.S.map(mm), N = W.length;
  for (const s of secs) if (s.geom.W.some((w, i) => Math.abs(mm(w) - W[i]) > 1e-6) || s.geom.S.some((g, i) => Math.abs(mm(g) - S[i]) > 1e-6)) throw new Error(`.layout ${kind}: all sections must have the same widths and gaps`);
  // cascade: section k's B nodes continue as section k+1's A nodes (a tapped line skips its junction)
  const ys = [0]; secs.forEach(s => ys.push(ys.at(-1) + mm(s.len)));
  const Ltot = ys.at(-1);
  const xs = []; { let x = 0; W.forEach((w, i) => { xs.push(x + w / 2); x += w + (S[i] ?? 0); }); const mid = (xs[0] + xs.at(-1)) / 2; xs.forEach((_, i) => { xs[i] -= mid; }); }
  const vias = d.elements.filter(e => e.via);
  const viaAt = (node) => vias.find(e => e.a === node);
  const endA = (i) => secs[0].ends.A[i], endB = (i) => secs.at(-1).ends.B[i];
  // hairpin (#38): the "special" end of a line is its U bottom (a bend element) instead of a via
  const hairpin = kind === 'hairpin';
  const bends = (d.blocks ?? []).filter(b => b.type === 'bend');
  const bendAt = (node) => bends.find(b => b.nodes[0] === node || b.nodes[1] === node);
  const isShort = (node) => (hairpin ? !!bendAt(node) : GROUND.has(node) || !!viaAt(node));
  const shortTop = Array.from({ length: N }, (_, i) => {
    const a = isShort(endA(i)), b = isShort(endB(i));
    if (a === b) throw new Error(hairpin ? `.layout hairpin: line ${i + 1} must end in a U bottom (bend) at exactly one end` : `.layout ${kind}: line ${i + 1} must be shorted (via) at exactly one end`);
    return a;
  });
  // hairpin: U bottoms — bend, inner line, bend — joining lines 2k and 2k+1 at the same end
  const ubots = [];
  if (hairpin) {
    if (N % 2) throw new Error('.layout hairpin: needs an even number of lines (two arms per hairpin)');
    for (let k = 0; k < N / 2; k++) {
      const i = 2 * k, j = i + 1, top = shortTop[i];
      if (shortTop[j] !== top) throw new Error(`.layout hairpin: arms ${i + 1} and ${j + 1} must have their U bottom at the same end`);
      if (k > 0 && top === shortTop[i - 1]) throw new Error('.layout hairpin: consecutive hairpins must be flipped (U bottoms at alternate ends)');
      const ea = top ? endA(i) : endB(i), eb = top ? endA(j) : endB(j);
      const b1 = bendAt(ea), b2 = bendAt(eb), va = b1.nodes[0] === ea ? b1.nodes[1] : b1.nodes[0], vb = b2.nodes[0] === eb ? b2.nodes[1] : b2.nodes[0];
      const line = d.sections.find(sc => sc.geom?.kind === 'msl1' && ((sc.ends.A[0] === va && sc.ends.B[0] === vb) || (sc.ends.A[0] === vb && sc.ends.B[0] === va)));
      if (!line) throw new Error(`.layout hairpin: no line joins the U bottom of arms ${i + 1} and ${j + 1} (bend ${b1.name} … bend ${b2.name})`);
      const g = xs[j] - xs[i] - (W[i] + W[j]) / 2;
      if (Math.abs(mm(line.len) - g) > 0.01) throw new Error(`.layout hairpin: U bottom line ${line.name} is ${r4(mm(line.len))} mm but the arms are ${r4(g)} mm apart`);
      if (Math.abs(W[i] - W[j]) > 1e-6 || Math.abs(mm(line.geom.W) - W[i]) > 1e-6) throw new Error(`.layout hairpin: hairpin ${k + 1} must have one width for both arms and its bottom`);
      ubots.push({ k, i, j, top, mitre: b1.geo.mitre, M: b1.geo.M });
    }
  }
  if (kind === 'comb' && shortTop.some(t => t !== shortTop[0])) throw new Error('.layout comb: all lines must be shorted at the same end (this netlist is interdigital: use .layout interdigital)');
  if (kind === 'interdigital' && shortTop.some((t, i) => i > 0 && t === shortTop[i - 1])) throw new Error('.layout interdigital: lines must be shorted at alternate ends');
  // taps: tee junctions on the outer lines
  const tees = (d.blocks ?? []).filter(b => b.type === 'tee');
  const taps = tees.map(t => {
    const [na, nb, side] = t.nodes;
    let line = -1, ya = null, yb = null;
    secs.forEach((s, k) => s.ends.B.forEach((n, i) => { if (n === na || n === nb) { line = i; (n === na ? (ya = ys[k + 1]) : (yb = ys[k + 1])); } }));
    secs.forEach((s, k) => s.ends.A.forEach((n, i) => { if (n === na || n === nb) { line = i; (n === na ? (ya = ys[k]) : (yb = ys[k])); } }));
    if (line < 0 || ya == null || yb == null) throw new Error(`.layout ${kind}: tee ${t.name} does not sit on a resonator line`);
    if (line !== 0 && line !== N - 1) throw new Error(`.layout ${kind}: taps must be on the outer lines (tee ${t.name} is on line ${line + 1})`);
    const p = needPort(d, side, `tee ${t.name} side arm`);
    return { line, y: (ya + yb) / 2, wJ: Math.abs(yb - ya), wf: mm(t.geo.W2), port: p, tee: t, dir: line === 0 ? -1 : 1 };
  });
  if (taps.length !== 2 || taps[0].line === taps[1].line) throw new Error(`.layout ${kind}: needs one tap on each outer line`);
  taps.forEach(t => { if (Math.abs(t.wJ - t.wf) > 0.01) throw new Error(`.layout ${kind}: tee ${t.tee.name} spans ${r4(t.wJ)} mm of line but its feed is ${r4(t.wf)} mm wide`); });
  // loading capacitors at the open ends: `cap` elements, or ideal C (realised as cap=… here)
  const openNode = (i) => (shortTop[i] ? endB(i) : endA(i));
  const capOpt = (o.cap ?? 'smd-0603').split('-');
  const caps = [];
  for (let i = 0; i < N && !hairpin; i++) {
    const node = openNode(i);
    const part = (d.caps ?? []).find(c => c.node === node && c.type !== 'ideal');
    const ideal = d.elements.find(e => e.type === 'C' && e.a === node && GROUND.has(e.b) && !/^Coe/i.test(e.name) && !/_pad$|_c$/.test(e.name));
    const idealCap = (d.caps ?? []).find(c => c.node === node && c.type === 'ideal');
    if (part) caps.push({ line: i, node, name: part.name, type: part.type, pkg: part.pkg, a: part.a, via: part.via ? { d: part.via.d * 1e3, n: part.via.n } : null, C: part.C });
    else if (ideal || idealCap) {
      const Ceff = ideal ? ideal.value : idealCap.C, name = ideal ? ideal.name : idealCap.name;
      const [type, pkg] = capOpt, v = viaAt(endA(i)) ?? viaAt(endB(i)) ?? vias[0];
      const via = { d: v ? v.via.d * 1e3 : 0.3, n: v ? v.via.n : 2 };
      let C = Ceff;
      if (type === 'smd') { const x = smdForCeff({ Ceff, pkg: pkg ?? '0603', sub: d.substrate, via: { d: via.d / 1e3, n: via.n }, f: d.fref }); if (!(x.C > 0)) throw new Error(`.layout ${kind}: ${name}: ${x.why}`); C = x.C; }
      caps.push({ line: i, node, name, type, pkg: pkg ?? '0603', via, C, Ceff, realised: true, ideal: !!ideal });
    }
  }
  const sub = d.substrate, fab = sub.fab;
  // board room for a via fence: the KiCad export keeps the F.Cu pour max(3h, 1) mm off the part (RF
  // keepout) and places stitching vias only outside it, so the board extends a via row beyond that
  // (unless margin= / feed= are given)
  const fenceRoom = Math.max(3 * sub.dielectric.h * 1e3, 1) + 2, given = d.layout.opts ?? {};
  const stub = o.stub ?? 1, feedLen = given.feed ?? Math.max(o.feed ?? 5, fenceRoom), margin = given.margin ?? Math.max(o.margin ?? 4, fenceRoom);
  const items = [], dims = [], notes = [];
  const core = { pads: [], vias: [], ties: [], refs: [], nl: [] };
  const G = String(d.ports.length + 1);
  // lines, with a via land at the shorted end
  const lands = [];
  for (let i = 0; i < N; i++) {
    const x = xs[i], w = W[i], ysh = shortTop[i] ? 0 : Ltot;
    const polys = [rect(x - w / 2, 0, x + w / 2, Ltot)];
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: polys[0], width: w, label: `resonator ${i + 1}`, role: 'core' });
    const v = hairpin ? null : viaAt(shortTop[i] ? endA(i) : endB(i));
    if (v) {
      const dr = v.via.d * 1e3, nv = v.via.n, vp = dr + 0.3, gv = 0.2;
      const row = nv * vp + (nv - 1) * gv, pw = Math.max(w, row + 0.2), ext = vp / 2 + 0.1;
      const landFull = rect(x - pw / 2, Math.min(ysh - ext, ysh + ext), x + pw / 2, Math.max(ysh - ext, ysh + ext));
      polys.push(landFull);
      lands.push({ line: i, pw });
      items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: landFull, width: pw, label: `via land ${i + 1}`, role: 'core' });
      for (let k = 0; k < nv; k++) {
        const vx = x - row / 2 + vp / 2 + k * (vp + gv);
        items.push({ type: 'via', x: vx, y: ysh, drill: dr, pad: vp, net: 'GND', role: 'core' });
        core.vias.push({ num: G, node: 'GND', x: vx, y: ysh, drill: dr, pad: vp });
      }
    } else if (!hairpin && !GROUND.has(shortTop[i] ? endA(i) : endB(i))) throw new Error(`.layout ${kind}: line ${i + 1} has no via at its shorted end`);
    core.pads.push({ num: G, node: 'GND', polys, at: [x, Ltot / 2] });
  }
  // comb-line with capacitors: each untapped resonator is its own net (r2, …), tied to GND in the part,
  // so that its capacitor joins two nets (a GND–GND part would be an unrouted connection to KiCad)
  let nextNum = +G;
  const ownNet = kind === 'comb' && caps.length > 0;
  // taps: feed stub in the part, feed to the board edge
  const feedItems = [];
  for (const t of taps) {
    const i = t.line, xe = xs[i] + t.dir * W[i] / 2, xr = xe + t.dir * stub, xedge = xr + t.dir * feedLen;
    const stubPoly = rect(Math.min(xe, xr), t.y - t.wf / 2, Math.max(xe, xr), t.y + t.wf / 2);
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: stubPoly, width: t.wf, label: `tap ${t.port.node}`, role: 'core' });
    const path = [[xedge, t.y], [xr, t.y]];
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: rect(Math.min(xedge, xr), t.y - t.wf / 2, Math.max(xedge, xr), t.y + t.wf / 2), width: t.wf, label: `feed ${t.port.node}`, role: 'feed', node: t.port.node, path });
    items.push({ type: 'port', name: t.port.node, net: 'GND', x: xedge, y: t.y, dir: [t.dir, 0], width: t.wf, z0: t.port.z });
    // the tapped resonator is the port's pad in the part (its copper, land and stub)
    const pad = core.pads[i];
    pad.num = portNum(d, t.port.node); pad.node = t.port.node; pad.polys.push(stubPoly);
    pad.at = [xr - t.dir * Math.min(t.wf / 4, 0.05), t.y];
    core.refs.push(refOf(d, t.port.node, [xr, t.y], [t.dir, 0], t.wf, t.wf));
    feedItems.push({ t, xedge });
  }
  if (ownNet) core.pads.forEach((p, i) => { if (p.num === G) { p.num = String(++nextNum); p.node = openNode(i); } });
  if (hairpin) {
    // each hairpin is one conductor, DC-isolated from the others: the tapped ones are their ports' nets,
    // the rest nets of their own (h2, …); the U bottom belongs to the first arm's pad; no net tie
    for (const u of ubots) {
      const pa = core.pads[u.i], pb = core.pads[u.j], tapped = [pa, pb].find(p => p.num !== G);
      const num = tapped ? tapped.num : String(++nextNum), node = tapped ? tapped.node : `h${u.k + 1}`;
      pa.num = pb.num = num; pa.node = pb.node = node;
      // U bottom: the strip under both arms, its two outer corners chamfered by c = 2MW along each edge
      // (Douville–James optimum M). For M > 0.5 the chamfer reaches past the corner square into the arm
      // (c > W): the arm's outer end corner gets the matching cut, so the copper is one polygon.
      const xL = xs[u.i] - W[u.i] / 2, xR = xs[u.j] + W[u.j] / 2, w = W[u.i], y0 = u.top ? 0 : Ltot, s = u.top ? -1 : 1, ye = y0 + s * w;
      const c = 2 * (u.M ?? 0) * w, over = Math.max(0, c - w);
      const left = c > 0 ? (c < w ? [[xL, y0], [xL, ye - s * c], [xL + c, ye]] : [[xL + over, y0], [xL + c, ye]]) : [[xL, y0], [xL, ye]];
      const right = c > 0 ? (c < w ? [[xR - c, ye], [xR, ye - s * c], [xR, y0]] : [[xR - c, ye], [xR - over, y0]]) : [[xR, ye], [xR, y0]];
      const poly = [...left, ...right].map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
      items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: poly, width: w, label: `hairpin ${u.k + 1} bottom`, role: 'core' });
      pa.polys.push(poly);
      if (over > 0) {
        // the arms' outer end corners: (outer edge, y0) → (outer edge, y0 − s·over) and (outer edge ± over, y0)
        for (const [arm, xo, dir] of [[u.i, xL, 1], [u.j, xR, -1]]) {
          const pad = core.pads[arm], strip = pad.polys[0];
          // replace the corner vertex by two points, the one on the outer edge next to the neighbour on that edge
          const cut = strip.flatMap(([x, y], q) => {
            if (!(Math.abs(x - xo) < 1e-9 && Math.abs(y - y0) < 1e-9)) return [[x, y]];
            const prev = strip[(q + strip.length - 1) % strip.length], onEdge = [x, y - s * over], onEnd = [x + dir * over, y];
            return Math.abs(prev[0] - xo) < 1e-9 ? [onEdge, onEnd] : [onEnd, onEdge];
          });
          const item = items.find(it => it.pts === strip);
          pad.polys[0] = cut; if (item) item.pts = cut;
        }
      }
    }
  } else core.ties.push([...taps.map(t => portNum(d, t.port.node)), G, ...core.pads.filter(p => +p.num > +G).map(p => p.num)]);
  // end extensions (open single-line stubs at an open end: the interdigital end trim)
  for (let i = 0; i < N; i++) {
    const node = openNode(i);
    const ext = d.sections.find(s => s.geom?.kind === 'msl1' && ((s.ends.A[0] === node && OPEN.has(s.ends.B[0])) || (s.ends.B[0] === node && OPEN.has(s.ends.A[0]))));
    if (!ext) continue;
    const le = mm(ext.len), we = mm(ext.geom.W), top = !shortTop[i];
    const poly = top ? rect(xs[i] - we / 2, -le, xs[i] + we / 2, 0) : rect(xs[i] - we / 2, Ltot, xs[i] + we / 2, Ltot + le);
    items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: poly, width: we, label: `extension ${i + 1}`, role: 'core' });
    core.pads[i].polys.push(poly);
    notes.push(`line ${i + 1} extends ${r4(le)} mm beyond the array (${ext.name}, modelled as an uncoupled open stub)`);
  }
  // capacitors: separate parts on the board, in the capacitor-local frame of js/capacitors.js
  const parts = [];
  for (const c of caps) {
    const i = c.line, top = !shortTop[i], yo = top ? 0 : Ltot, dir = [0, top ? -1 : 1];
    const a = c.type === 'printed' ? (c.a ?? printedSize({ C: c.C, sub, f: d.fref }).a) : undefined;
    const g = capGeometry({ type: c.type, pkg: c.pkg, a, via: c.via ?? { d: 0.3, n: 2 } });
    const T = ([u, v]) => [xs[i] + dir[0] * u - dir[1] * v, yo + dir[1] * u + dir[0] * v];     // local +x along dir
    const tp = (poly) => poly.map(T);
    g.hot.forEach(poly => items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: tp(poly), width: Math.min(...[0, 1].map(k => Math.max(...poly.map(p => p[k])) - Math.min(...poly.map(p => p[k])))), label: `${c.name} pad 1`, role: 'part' }));
    g.cold.forEach(poly => items.push({ type: 'poly', layer: 'F.Cu', net: 'GND', pts: tp(poly), width: Math.min(...[0, 1].map(k => Math.max(...poly.map(p => p[k])) - Math.min(...poly.map(p => p[k])))), label: `${c.name} pad 2`, role: 'part' }));
    g.vias.forEach(v => { const [vx, vy] = T([v.x, v.y]); items.push({ type: 'via', x: vx, y: vy, drill: v.drill, pad: v.pad, net: 'GND', role: 'part' }); });
    items.push({ type: 'courtyard', name: c.name, pts: tp(g.crt) });
    parts.push({ kind: 'cap', name: c.name, type: c.type, pkg: c.pkg, a, via: c.via ?? { d: 0.3, n: 2 }, at: [xs[i], yo], dir, node: core.pads[i].node, C: c.C, Ceff: c.Ceff, bbox: tp(g.crt) });
  }
  // board
  const allPts = items.filter(it => it.pts).flatMap(it => it.pts).concat(items.filter(it => it.type === 'via').map(v => [v.x, v.y]));
  const ymin = Math.min(...allPts.map(p => p[1])) - margin, ymax = Math.max(...allPts.map(p => p[1])) + margin;
  const x0 = Math.min(...feedItems.map(f => f.xedge)), x1 = Math.max(...feedItems.map(f => f.xedge));
  const outline = rect(x0, ymin, x1, ymax);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [xs[0] - W[0] / 2 - 1.2, 0], b: [xs[0] - W[0] / 2 - 1.2, Ltot], text: `ℓ ${r4(Ltot)} mm` });
  dims.push({ a: [xs[0], Ltot / 2], b: [xs.at(-1), Ltot / 2], text: `W ${W.map(r4).join('/')} · S ${S.map(r4).join('/')} mm`, dy: 0.6 });
  // netlists: the source netlist with the feeds (as built, with connectors added later) / feed stubs
  // (core, between the part's reference planes), and the capacitors realised where they were ideal
  const transform = (feed) => {
    let lines = d.text.split(/\r?\n/).filter(l => !/^\s*\.layout\b/i.test(l));
    for (const t of taps) {
      const ti = lines.findIndex(l => new RegExp(`^\\s*tee\\s+${t.tee.name}\\b`, 'i').test(l));
      lines[ti] = lines[ti].replace(new RegExp(`(\\s)${t.port.node}(\\s)`), `$1${t.port.node}_k$2`);
      lines.splice(ti + 1, 0, `T${t.port.node}_f ${t.port.node} ${t.port.node}_k W=${r4(t.wf)}mm len=${r4(feed(t))}mm`);
    }
    for (const c of caps.filter(c => c.realised)) {
      const re = c.ideal ? new RegExp(`^\\s*${c.name}\\s+${c.node}\\s+0\\s`) : new RegExp(`^\\s*cap\\s+${c.name}\\s`, 'i');
      const ci = lines.findIndex(l => re.test(l));
      if (ci < 0) continue;
      const v = c.via;
      lines[ci] = `cap ${c.name} ${c.node} C=${+(c.C * 1e12).toPrecision(6)}p type=${c.type}${c.type === 'smd' ? ` pkg=${c.pkg}` : ''}${c.type === 'printed' ? '' : ` d=${v.d}mm n=${v.n}`}   # realised from the ideal ${+(c.Ceff * 1e12).toPrecision(6)} pF (effective at f0)`;
    }
    return lines;
  };
  const asBuilt = transform(t => feedLen + stub);
  const ti = asBuilt.findIndex(l => /^\s*\.title\b/i.test(l));
  if (ti >= 0) asBuilt[ti] = asBuilt[ti].replace(/^\s*\.title\s+/i, '.title as built: ');
  const netlist = asBuilt.join('\n') + '\n';
  const coreLines = transform(() => stub);
  if (ti >= 0) coreLines[ti] = coreLines[ti].replace(/^\s*\.title\s+/i, '.title core (between the part reference planes): ');
  core.netlist = coreLines.join('\n') + '\n';
  const realised = caps.filter(c => c.realised);
  if (realised.length) notes.push(`ideal loading capacitors realised as ${capOpt.join(' ')} parts, nominal values for the same effective capacitance at f0 (${realised.map(c => `${c.name} ${r4(c.C * 1e12)} pF`).join(', ')}); exact values: use E24 parts plus trimming, or trimmers`);
  const wide = lands.filter(l => l.pw > W[l.line] + 1e-6);
  if (wide.length) notes.push(`via lands wider than their lines (${wide.map(l => `line ${l.line + 1}: ${r4(l.pw)} mm`).join(', ')}): not modelled`);
  notes.push(`taps: Hammerstad tee (as Qucs) with ${taps.map(t => r4(t.wf)).join('/')} mm feeds; the part includes a ${r4(stub)} mm feed stub at each tap`);
  return { outline, items, dims, netlist, core, notes, parts, fence: true };
}
// ---------------------------------------------------------------- edge-coupled (#38)
// The coupled sections of the edge-coupled (parallel-coupled) filter as a staircase: section k couples
// resonator k (its line 1, open at B) and resonator k+1 (line 2, open at A); each resonator is one strip
// whose halves may differ in width (a `step` element between them when modelled). The ports sit on the
// first section's line 1 (A) and the last section's line 2 (B); each gets a linear taper to the feed
// width and a feed to the edge connector. Every resonator is its own conductor (h1, …; no net tie).
function edgecoupled(d, _, o) {
  const secs = d.sections.filter(s => s.geom?.kind === 'msl2');
  if (secs.length < 2) throw new Error('.layout edgecoupled: needs two or more coupled-microstrip sections (geom=msl W= S=; synthesise with "Realise in microstrip")');
  const steps = (d.blocks ?? []).filter(b => b.type === 'step');
  const joined = (a, b) => a === b || steps.some(st => (st.nodes[0] === a && st.nodes[1] === b) || (st.nodes[0] === b && st.nodes[1] === a));
  const isOpen = (node) => node === '-' || !d.ports.some(p => p.node === node) && !d.elements.some(e => (e.a === node || e.b === node) && !/^Coe/i.test(e.name)) && !secs.some(s2 => s2.ends.A.concat(s2.ends.B).filter(x => x === node).length > 1);
  for (let k = 0; k < secs.length; k++) {
    const s = secs[k];
    if (!isOpen(s.ends.B[0]) || !isOpen(s.ends.A[1])) throw new Error(`.layout edgecoupled: section ${s.name} must have line 1 open at B and line 2 open at A`);
    if (k > 0 && !joined(secs[k - 1].ends.B[1], s.ends.A[0])) throw new Error(`.layout edgecoupled: section ${secs[k - 1].name} line 2 (B) must continue as ${s.name} line 1 (A)`);
  }
  const pin = needPort(d, secs[0].ends.A[0], 'first section, line 1 end A'), pout = needPort(d, secs.at(-1).ends.B[1], 'last section, line 2 end B');
  const sub = d.substrate, f0 = d.fref, fenceRoom = Math.max(3 * sub.dielectric.h * 1e3, 1) + 2, given = d.layout.opts ?? {};
  const feedLen = given.feed ?? Math.max(o.feed ?? 5, fenceRoom), margin = given.margin ?? Math.max(o.margin ?? 4, fenceRoom);
  const W = secs.map(s => mm(s.geom.W)), S = secs.map(s => mm(s.geom.S)), Ls = secs.map(s => mm(s.len));
  const xs = [0]; Ls.forEach(l => xs.push(xs.at(-1) + l));
  // centre lines: line 1 / line 2 of each section. A resonator's two halves differ in width; they are
  // aligned on the edge that faces no other line (upper edges where it widens, lower where it narrows),
  // so every coupled edge keeps its gap and no open-end corner meets a neighbour
  const y1 = [0], y2 = [];
  secs.forEach((_, k) => { y2.push(y1[k] + W[k] + S[k]); if (k < secs.length - 1) y1.push(y2[k] + Math.abs(W[k + 1] - W[k]) / 2); });
  const ys = [...y1, y2.at(-1)];                                   // ports: input line 0, output line n+1
  const items = [], dims = [], notes = [];
  const core = { pads: [], vias: [], ties: [], refs: [], nl: [] };
  const n = secs.length - 1;
  const strip = (k, line) => { const y = line ? y2[k] : y1[k]; return rect(xs[k], y - W[k] / 2, xs[k + 1], y + W[k] / 2); };
  // resonators 0 (input line) … n+1 (output line): polygons
  const polys = Array.from({ length: n + 2 }, () => []);
  secs.forEach((_, k) => { polys[k].push(strip(k, 0)); polys[k + 1].push(strip(k, 1)); });
  // feeds: taper W → wf, then the feed to the edge
  const feed = (p, P, u, w) => {
    const wf = feedWidth(d, p.z, f0), tp = taper(P, u, w, wf, Math.max(w, 3 * Math.abs(wf - w)));
    const edge = [tp.T[0] + u[0] * feedLen, tp.T[1]];
    items.push({ type: 'poly', layer: 'F.Cu', net: p.node, pts: pathPolygon([tp.T, edge], wf), width: wf, label: `feed ${p.node}`, role: 'feed', node: p.node, path: [edge, tp.T] });
    items.push({ type: 'port', name: p.node, net: p.node, x: edge[0], y: edge[1], dir: u, width: wf, z0: p.z });
    core.refs.push(refOf(d, p.node, tp.T, u, wf, wf));
    return { tp, wf, edge };
  };
  const fi = feed(pin, [xs[0], ys[0]], [-1, 0], W[0]), fo = feed(pout, [xs.at(-1), ys.at(-1)], [1, 0], W.at(-1));
  if (fi.tp.poly) polys[0].push(fi.tp.poly);
  if (fo.tp.poly) polys[n + 1].push(fo.tp.poly);
  polys.forEach((ps, j) => {
    const port = j === 0 ? pin : j === n + 1 ? pout : null, node = port ? port.node : `h${j}`;
    const num = port ? portNum(d, port.node) : String(d.ports.length + j);
    ps.forEach(pts => items.push({ type: 'poly', layer: 'F.Cu', net: node, pts, width: Math.min(...W), label: port ? `line ${node}` : `resonator ${j}`, role: 'core' }));
    core.pads.push({ num, node, polys: ps, at: port ? (j === 0 ? [xs[0] + 0.05, ys[0]] : [xs.at(-1) - 0.05, ys.at(-1)]) : [xs[j], y2[j - 1]] });
  });
  // board
  const allPts = items.filter(it => it.pts).flatMap(it => it.pts);
  const x0 = fi.edge[0], x1 = fo.edge[0], ymin = Math.min(...allPts.map(q => q[1])) - margin, ymax = Math.max(...allPts.map(q => q[1])) + margin;
  const outline = rect(x0, ymin, x1, ymax);
  items.unshift({ type: 'zone', layer: 'B.Cu', net: 'GND', pts: outline });
  dims.push({ a: [xs[0], ys.at(-1) + W.at(-1) + 1.2], b: [xs.at(-1), ys.at(-1) + W.at(-1) + 1.2], text: `${r4(xs.at(-1))} mm` });
  dims.push({ a: [xs[0], ys[0] - W[0] - 1.2], b: [xs.at(-1), ys[0] - W[0] - 1.2], text: `W ${W.map(r4).join('/')} · S ${S.map(r4).join('/')} mm`, dy: 0.6 });
  // netlists: the source with the port nodes moved behind a taper (core) plus the feed (as built)
  const transform = (asBuilt) => {
    const lines = d.text.split(/\r?\n/).filter(l => !/^\s*\.layout\b/i.test(l));
    for (const [p, fd, sec, end] of [[pin, fi, secs[0], 'A'], [pout, fo, secs.at(-1), 'B']]) {
      const si = lines.findIndex(l => new RegExp(`^\\s*cline\\s+${sec.name}\\b`, 'i').test(l));
      let ei = si; while (!new RegExp(`^\\s*${end}\\s`).test(lines[ei])) ei++;
      lines[ei] = lines[ei].replace(new RegExp(`(\\s)${p.node}(\\s|$)`), `$1${p.node}_k$2`);
      const w = end === 'A' ? W[0] : W.at(-1), add = [];
      if (asBuilt) add.push(`T${p.node}_f ${p.node} ${p.node}_e W=${r4(fd.wf)}mm len=${r4(feedLen)}mm`, ...taperNl(p.node, `${p.node}_e`, `${p.node}_k`, fd.wf, w, fd.tp.Lt));
      else add.push(...taperNl(p.node, p.node, `${p.node}_k`, fd.wf, w, fd.tp.Lt));
      let endi = ei; while (!/^\s*end\b/i.test(lines[endi])) endi++;
      lines.splice(endi + 1, 0, ...add);
    }
    const ti = lines.findIndex(l => /^\s*\.title\b/i.test(l));
    if (ti >= 0) lines[ti] = lines[ti].replace(/^\s*\.title\s+/i, asBuilt ? '.title as built: ' : '.title core (between the part reference planes): ');
    return lines.join('\n') + '\n';
  };
  core.netlist = transform(false);
  notes.push(`${n} resonators on a ${r4(xs.at(-1))} mm staircase; each port has a ${r4(fi.tp.Lt)}/${r4(fo.tp.Lt)} mm taper to the feed width (modelled as three stepped sections)`);
  const unmod = secs.slice(1).map((s2, k) => [W[k], W[k + 1]]).filter(([a2, b2]) => Math.abs(a2 / b2 - 1) > 1e-3 && Math.max(a2, b2) / Math.min(a2, b2) < 1.5);
  if (unmod.length) notes.push(`${unmod.length} width step(s) under 1.5:1 at the resonator middles are not modelled (outside the step model's range)`);
  notes.push('the width steps are drawn one-sided (edges facing no other line aligned); the step model is symmetric');
  return { outline, items, dims, netlist: transform(true), core, notes, fence: true };
}

const comb = (d, _, o) => resonatorArray(d, 'comb', o);
const interdigital = (d, _, o) => resonatorArray(d, 'interdigital', o);
const hairpin = (d, _, o) => resonatorArray(d, 'hairpin', o);

const TEMPLATES = { coupler, schiffman, marchand, comb, interdigital, hairpin, edgecoupled };
export const templateNames = Object.keys(TEMPLATES);

// Build the layout for a parsed netlist with a .layout statement. Returns the layout with DRC results.
export function buildLayout(d) {
  if (!d.layout) throw new Error('no .layout statement');
  const t = TEMPLATES[d.layout.type];
  if (!t) throw new Error(`.layout: unknown template "${d.layout.type}" (available: ${templateNames.join(', ')})`);
  if (!d.substrate) throw new Error('.layout needs a .substrate');
  // connector (issue #8): its size sets the default port pitch, board margin and straight feed length
  const o = { ...d.layout.opts };
  const conn = getConnector(o.connector);
  if (conn) {
    const wf50 = feedWidth(d, d.ports[0]?.z ?? 50, d.fref);
    o.pitch ??= Math.ceil(conn.width + 0.5);
    o.margin ??= Math.ceil(conn.ground.y + conn.ground.w / 2 + 0.5);
    o.launch ??= 'matched';
    if (!LAUNCH_MODES.includes(o.launch)) throw new Error(`.layout: launch=${o.launch} (use ${LAUNCH_MODES.join(' or ')})`);
    o.feed ??= Math.ceil(minFeed(conn, wf50, o.launch) * 2) / 2;
  }
  const L = t(d, d.layout.sections, o);
  L.opts = o;
  if (conn) addConnectors(d, L, conn, o.launch);
  L.title = d.title || `${d.layout.type} layout`;
  L.type = d.layout.type;
  L.substrate = d.substrate;
  L.errors = drc(L);
  L.warnings ??= [];
  L.feeds = [...L.items.filter(i => i.role === 'feed').map(i => ({ node: i.node, path: i.path, width: i.width })), ...L.items.flatMap(i => i.feeds || [])];
  L.core.f0 = d.fref;
  const bb = bbox([L.outline]);
  L.size = [bb.x1 - bb.x0, bb.y1 - bb.y0];
  return L;
}
