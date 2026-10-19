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

const TEMPLATES = { coupler, schiffman, marchand };
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
