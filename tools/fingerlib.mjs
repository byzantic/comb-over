// Shared code for the finger-loaded coupled-line tools (issue #41): one openEMS case of a finger pair
// between coupled feeds, running it, and fitting per-length C and L to its 4-port result.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fingerPair } from '../js/fingers.js';
import { makeSubstrate } from '../js/substrates.js';
import { openemsExport } from '../js/openems.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';
import { solve as solve2d, microstrip, stripsFromWS } from '../solver/mtl2d.js';

const C0 = 299792458;
const r6 = (x) => +x.toFixed(6);

// write case DIR/NAME: P = { W, G, wf, lf, p } (mm), n cells; opts { sub, bare, full, fine, fmin, fmax, lossy }
export function genCase(dir, name, P, n, opts = {}) {
  const subId = opts.sub ?? 'jlc-ro4350b-0.508', sub = makeSubstrate(subId), h = sub.dielectric.h * 1e3;
  const fmin = opts.fmin ?? 0.5e9, fmax = opts.fmax ?? 6e9, Lp = 3, Lf = r6(Lp + 3 * h + 1.5);   // feeds: port plane, then 3h + 1.5 mm to the section
  const fp0 = fingerPair({ ...P, n });
  const fp = opts.bare ? { ...fp0, polys: [[[0, -P.G / 2 - P.W], [fp0.len, -P.G / 2 - P.W], [fp0.len, -P.G / 2], [0, -P.G / 2]], [[0, P.G / 2], [fp0.len, P.G / 2], [fp0.len, P.G / 2 + P.W], [0, P.G / 2 + P.W]]] } : fp0;
  const len = fp.len, y1 = -P.G / 2 - P.W / 2, y2 = P.G / 2 + P.W / 2, rect = (a, b, c, d) => [[a, b], [c, b], [c, d], [a, d]];
  const items = [
    { type: 'poly', role: 'core', pts: fp.polys[0] }, { type: 'poly', role: 'core', pts: fp.polys[1] },
    ...[['p1', -Lf, 0, y1], ['p3', -Lf, 0, y2], ['p2', len + Lf, len, y1], ['p4', len + Lf, len, y2]].map(([node, xe, xi, y]) => (
      { type: 'poly', role: 'feed', node, width: P.W, pts: rect(Math.min(xe, xi), y - P.W / 2, Math.max(xe, xi), y + P.W / 2), path: [[xe, y], [xi, y]] })),
  ];
  // the export needs a T…_f line per port (it shortens them to the planes); the fit writes its own comparison
  const exportNet = ['.title finger pair', `.freq ${fmin} ${fmax} 201`, `.substrate ${subId}`, ...['p1', 'p2', 'p3', 'p4'].map(q => `port ${q} 50`),
    ...['p1', 'p2', 'p3', 'p4'].map(q => `T${q}_f ${q} ${q}_k W=${P.W}mm len=${Lf}mm`)].join('\n') + '\n';
  // the edge cell from the smallest finger feature (finger width, side gap, tip gap, overlap), not the backbone
  const fine = opts.fine ?? Math.min(P.wf, fp0.side, fp0.tip, Math.max(fp0.overlap, P.wf), P.G) / 3;
  // the pair is unchanged by a 180° rotation (p1 ↔ p4, p2 ↔ p3): driving p1 and p2 is enough (full: all four)
  const sym = opts.full ? {} : { excite: '1,2', perm: [4, 3, 2, 1] };
  const g = openemsExport(exportNet, { layout: { items, parts: [], substrate: sub, netlist: exportNet, errors: [], title: `fingers ${name}` }, lossless: !opts.lossy, fine, ...sym });
  const d = join(dir, name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'f.py'), g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'"));
  const c = { ...P, n, len, bare: !!opts.bare, sub: subId, h, fmin, fmax, Lf, Lp: g.info.ports[0].Lp, cells: g.info.cells, overlap: fp0.overlap, side: fp0.side, tip: fp0.tip, fine };
  writeFileSync(join(d, 'case.json'), JSON.stringify(c));
  return c;
}

export function runCase(d) {
  if (existsSync(join(d, 'f.s4p'))) return { ok: true, cached: true, s: 0 };
  const t0 = Date.now(), r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', ['f.py'], { cwd: d, encoding: 'utf8', maxBuffer: 1 << 28 });
  writeFileSync(join(d, 'run.log'), r.stdout + r.stderr);
  return { ok: r.status === 0 && !/-nan/.test(r.stdout) && existsSync(join(d, 'f.s4p')), s: (Date.now() - t0) / 1000 };
}

// comb-over's model of a case: plain coupled feeds (from the port planes) + the section as a cline with C, L (SI)
// c.feedCL: the feeds' per-length C, L (e.g. fitted to a bare openEMS run, fitBare); else comb-over's microstrip model
export function model(c, C, L, freq = `${c.fmin} ${c.fmax} 11`) {
  const fl = r6(c.Lf - c.Lp), m = (x) => x.toPrecision(8);
  const feed = (nm, a, b) => c.feedCL
    ? [`cline ${nm}`, `  C [${m(c.feedCL.C[0][0])} ${m(c.feedCL.C[0][1])}; ${m(c.feedCL.C[1][0])} ${m(c.feedCL.C[1][1])}]`, `  L [${m(c.feedCL.L[0][0])} ${m(c.feedCL.L[0][1])}; ${m(c.feedCL.L[1][0])} ${m(c.feedCL.L[1][1])}]`, `  len ${fl}mm`, '  Q 1e30', `  A ${a}`, `  B ${b}`, 'end']
    : [`cline ${nm} geom=msl W=${c.W}mm S=${c.G}mm`, `  len ${fl}mm`, '  Q 1e30', `  A ${a}`, `  B ${b}`, 'end'];
  return ['.title finger pair model', `.freq ${freq}`, `.substrate ${c.sub}`, ...['p1', 'p2', 'p3', 'p4'].map(q => `port ${q} 50`),
    ...feed('FA', 'p1 p3', 'a1 a3'),
    'cline K', `  C [${m(C[0][0])} ${m(C[0][1])}; ${m(C[1][0])} ${m(C[1][1])}]`, `  L [${m(L[0][0])} ${m(L[0][1])}; ${m(L[1][0])} ${m(L[1][1])}]`, `  len ${c.len}mm`, '  Q 1e30', '  A a1 a3', '  B b1 b3', 'end',
    ...feed('FB', 'b1 b3', 'p2 p4')].join('\n') + '\n';
}
const PAIRS = [1, 2, 3, 4].flatMap(i => [1, 2, 3, 4].map(j => [i, j]));
export function errOf(c, F, em, C, L) {
  const r = solve(parseNetlist(model(c, C, L)), F); let e = 0;
  for (const [i, j] of PAIRS) { const a = r.S(i, j), b = em.S(i, j); for (let k = 0; k < F.length; k++) e += (a.re[k] - b.re[k]) ** 2 + (a.im[k] - b.im[k]) ** 2; }
  return Math.sqrt(e / F.length / PAIRS.length);
}
// symmetric pair: even/odd impedance and εeff from per-length C and L
export function modes(C, L) {
  const Ce = C[0][0] + C[0][1], Co = C[0][0] - C[0][1], Le = L[0][0] + L[0][1], Lo = L[0][0] - L[0][1];
  return { Ze: Math.sqrt(Le / Ce), Zo: Math.sqrt(Lo / Co), ee: Le * Ce * C0 * C0, eo: Lo * Co * C0 * C0 };
}
export function nm(fn, x0, iters = 400, step = 0.1) {
  const n = x0.length; let P = [x0]; for (let i = 0; i < n; i++) { const q = [...x0]; q[i] += step; P.push(q); }
  let V = P.map(fn);
  for (let it = 0; it < iters; it++) {
    const o = V.map((_, i) => i).sort((a, b) => V[a] - V[b]); P = o.map(i => P[i]); V = o.map(i => V[i]);
    const c = Array.from({ length: n }, (_, j) => P.slice(0, n).reduce((s, q) => s + q[j], 0) / n), at = (t) => c.map((v, j) => v + t * (P[n][j] - v));
    const r = at(-1), fr = fn(r);
    if (fr < V[0]) { const e = at(-2), fe = fn(e); if (fe < fr) { P[n] = e; V[n] = fe; } else { P[n] = r; V[n] = fr; } }
    else if (fr < V[n - 1]) { P[n] = r; V[n] = fr; }
    else { const k = at(0.5), fk = fn(k); if (fk < V[n]) { P[n] = k; V[n] = fk; } else for (let i = 1; i <= n; i++) { P[i] = P[i].map((v, j) => P[0][j] + 0.5 * (v - P[0][j])); V[i] = fn(P[i]); } }
  }
  const b = V.indexOf(Math.min(...V)); return { x: P[b], v: V[b] };
}
export function loadCase(d) {
  const c = JSON.parse(readFileSync(join(d, 'case.json'), 'utf8')), ds = readTouchstone(readFileSync(join(d, 'f.s4p'), 'utf8'), { nPorts: 4, name: 'f' });
  const F = Float64Array.from({ length: 12 }, (_, i) => c.fmin * 1.01 + (c.fmax * 0.99 - c.fmin * 1.01) * i / 11);
  return { c, F, em: onSweep(ds, F) };
}
export const bareCL = (c) => { const sub = makeSubstrate(c.sub); return solve2d(stripsFromWS([c.W * 1e-3, c.W * 1e-3], c.G * 1e-3, 0), microstrip({ h: sub.dielectric.h, er: sub.dielectric.er })); };
const toCL = (x) => [[[Math.exp(x[0]), -Math.exp(x[1])], [-Math.exp(x[1]), Math.exp(x[0])]], [[Math.exp(x[2]), Math.exp(x[3])], [Math.exp(x[3]), Math.exp(x[2])]]];
// fit per-length C and L to a case: first C with L of the bare backbones, then all four (log parameters)
export function fitCase(d) {
  const A = loadCase(d), bare = bareCL(A.c);
  const x0 = [Math.log(bare.C[0][0]), Math.log(-bare.C[0][1]), Math.log(bare.L[0][0]), Math.log(bare.L[0][1])];
  const fC = nm((x) => errOf(A.c, A.F, A.em, ...toCL([x[0], x[1], x0[2], x0[3]])), x0.slice(0, 2));
  const fA = nm((x) => errOf(A.c, A.F, A.em, ...toCL(x)), [fC.x[0], fC.x[1], x0[2], x0[3]], 600, 0.05);
  const [Cc, Lc] = toCL([fC.x[0], fC.x[1], x0[2], x0[3]]), [C, L] = toCL(fA.x);
  return { c: A.c, bare, fitC: { C: Cc, L: Lc, rms: fC.v }, C, L, rms: fA.v, modes: modes(C, L), A };
}

// de-embedded even/odd εeff from two cases that differ only in cell count (same ends): the median over fmin..fmax
// of the Bloch phase of T_A·T_B⁻¹ (tools/fingerbloch.py, with OPENEMS_PYTHON's numpy)
export function bloch(dA, dB, fmin = 1e9, fmax = 6e9) {
  const a = JSON.parse(readFileSync(join(dA, 'case.json'), 'utf8')), b = JSON.parse(readFileSync(join(dB, 'case.json'), 'utf8'));
  const r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', [new URL('./fingerbloch.py', import.meta.url).pathname, join(dA, 'f.s4p'), join(dB, 'f.s4p'), String(a.n - b.n), String(a.p), String(fmin), String(fmax)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fingerbloch: ${r.stderr}`);
  const o = JSON.parse(r.stdout), med = (v) => { const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
  if (!o.f.length) throw new Error('fingerbloch: no frequency gave two even and two odd eigenvalues');
  return { ee: med(o.ee), eo: med(o.eo), f: o.f, eeF: o.ee, eoF: o.eo };
}
// per-length C, L of a symmetric pair from Ze, Zo and εe, εo
export function clFromModes(Ze, Zo, ee, eo) {
  const Ce = Math.sqrt(ee) / (C0 * Ze), Co = Math.sqrt(eo) / (C0 * Zo), Le = Ze * Math.sqrt(ee) / C0, Lo = Zo * Math.sqrt(eo) / C0;
  return [[[(Ce + Co) / 2, (Ce - Co) / 2], [(Ce - Co) / 2, (Ce + Co) / 2]], [[(Le + Lo) / 2, (Le - Lo) / 2], [(Le - Lo) / 2, (Le + Lo) / 2]]];
}
// Ze, Zo fitted to a case with εe, εo held at the de-embedded values
export function fitZ(d, ee, eo, Z0 = [69, 37]) {
  const A = loadCase(d), f = nm((x) => errOf(A.c, A.F, A.em, ...clFromModes(Math.exp(x[0]), Math.exp(x[1]), ee, eo)), Z0.map(Math.log), 200, 0.05);
  const [Ze, Zo] = f.x.map(Math.exp), [C, L] = clFromModes(Ze, Zo, ee, eo);
  return { Ze, Zo, ee, eo, C, L, rms: f.v };
}

// The finger section's ends (#41): the lines' fingers are offset by p/2, so at each end one line's first finger is
// p/4 in and the other's 3p/4. Modelled as shunt capacitance at each end of the section — Ca on the line whose
// first finger is nearer the end, Cb on the other, Cm between them (any sign; swapped at the far end, as the pair's
// 180° rotation requires) — plus a length offset δ at each end. Added to a parsed netlist as admittance blocks.
// e = { Ca, Cb, Cm (F), delta (mm) }; A = [line 1, line 2] nodes at the section's start, B at its end (line 1 is the
// one whose first finger is p/4 from the start).
export function addEnds(d, A, B, e) {
  const blk = (name, nodes, c1, c2) => ({ type: 'ends', name, nodes, y: (f) => { const w = 2 * Math.PI * f;
    return { re: new Float64Array(4), im: Float64Array.from([w * (c1 + e.Cm), -w * e.Cm, -w * e.Cm, w * (c2 + e.Cm)]), n: 2 }; } });
  (d.blocks ??= []).push(blk('ENDA', A, e.Ca, e.Cb), blk('ENDB', B, e.Cb, e.Ca));
  return d;
}
// the straight case's model with ends: feeds + ends + section (length + 2δ) + ends + feeds
export function modelEnds(c, C, L, e, freq) {
  const net = model({ ...c, len: r6(c.len + 2 * (e.delta ?? 0)) }, C, L, freq);
  return addEnds(parseNetlist(net), ['a1', 'a3'], ['b1', 'b3'], e);
}
function errD(A, d) {
  const r = solve(d, A.F); let s = 0;
  for (const [i, j] of PAIRS) { const a = r.S(i, j), b = A.em.S(i, j); for (let k = 0; k < A.F.length; k++) s += (a.re[k] - b.re[k]) ** 2 + (a.im[k] - b.im[k]) ** 2; }
  return Math.sqrt(s / A.F.length / PAIRS.length);
}
// Ze, Zo and the ends fitted jointly to two lengths of the same geometry (εe, εo held: de-embedded from the pair)
export function fitEnds(dShort, dLong, feedCL) {
  const b = bloch(dLong, dShort), cases = [loadCase(dShort), loadCase(dLong)].map(a => feedCL ? { ...a, c: { ...a.c, feedCL } } : a), z = fitZ(dLong, b.ee, b.eo);
  const P = (x) => ({ Ze: Math.exp(x[0]), Zo: Math.exp(x[1]), e: { Ca: x[2] * 1e-15, Cb: x[3] * 1e-15, Cm: x[4] * 1e-15, delta: x[5] * 1e-2 } });   // fF, 10 µm
  const err = (x) => { const q = P(x), [C, L] = clFromModes(q.Ze, q.Zo, b.ee, b.eo);
    return Math.hypot(...cases.map(a => errD(a, modelEnds(a.c, C, L, q.e)))) / Math.SQRT2; };
  const x0 = [Math.log(z.Ze), Math.log(z.Zo), 0, 0, 0, 0];
  let f = nm(err, x0, 800, 0.2); f = nm(err, f.x, 800, 0.05);
  const q = P(f.x), [C, L] = clFromModes(q.Ze, q.Zo, b.ee, b.eo);
  return { ee: b.ee, eo: b.eo, Ze: q.Ze, Zo: q.Zo, ends: q.e, C, L, rms: f.v, rms0: err(x0),
    each: cases.map(a => errD(a, modelEnds(a.c, C, L, q.e))) };
}

// a bare case (backbones only) is one uniform coupled line from port plane to port plane: its per-length C, L
// fitted directly, with no feed model in the way — the feeds' C, L as openEMS sees them
export function fitBare(d) {
  const A = loadCase(d), b = bareCL(A.c), x0 = [Math.log(b.C[0][0]), Math.log(-b.C[0][1]), Math.log(b.L[0][0]), Math.log(b.L[0][1])];
  const CL = (x) => ({ C: [[Math.exp(x[0]), -Math.exp(x[1])], [-Math.exp(x[1]), Math.exp(x[0])]], L: [[Math.exp(x[2]), Math.exp(x[3])], [Math.exp(x[3]), Math.exp(x[2])]] });
  const err = (x) => { const q = CL(x); return errD(A, parseNetlist(model({ ...A.c, feedCL: q }, q.C, q.L))); };   // feeds and section alike
  let f = nm(err, x0, 600, 0.05); f = nm(err, f.x, 400, 0.01);
  return { ...CL(f.x), rms: f.v, modes: modes(CL(f.x).C, CL(f.x).L) };
}
