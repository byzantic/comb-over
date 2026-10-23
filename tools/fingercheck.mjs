// Finger-loaded coupled lines against openEMS (issue #41, stage 1): extract per-length C and L, then check.
//   node tools/fingercheck.mjs gen DIR [--W 0.6 --G 1 --wf 0.2 --lf 0.7 --p 0.8 --n 12,24 --sub ID]
//   node tools/fingercheck.mjs run DIR                 run every case without a result (OPENEMS_PYTHON)
//   node tools/fingercheck.mjs fit DIR                 fit C, L to the shortest case; predict the others
// Each case: the finger-loaded section between plain coupled backbones (the feeds) to four ports:
// p1 / p2 line 1 left / right, p3 / p4 line 2 left / right. All four ports are driven in turn.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fingerPair } from '../js/fingers.js';
import { makeSubstrate } from '../js/substrates.js';
import { openemsExport } from '../js/openems.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';
import { solve as solve2d, microstrip, stripsFromWS } from '../solver/mtl2d.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const C0 = 299792458, MU0 = 4e-7 * Math.PI;
const r6 = (x) => +x.toFixed(6);

function gen() {
  const P = { W: +opt('W', 0.6), G: +opt('G', 1), wf: +opt('wf', 0.2), lf: +opt('lf', 0.7), p: +opt('p', 0.8) }, subId = opt('sub', 'jlc-ro4350b-0.508');
  const sub = makeSubstrate(subId), h = sub.dielectric.h * 1e3, fmin = 0.5e9, fmax = 6e9;
  for (const n of opt('n', '12,24').split(',').map(Number)) {
    const Lp = 3, Lf = r6(Lp + 3 * h + 1.5);                     // feeds: port plane, then 3h + 1.5 mm to the section
    const fp = fingerPair({ ...P, n }), len = fp.len, y1 = -P.G / 2 - P.W / 2, y2 = P.G / 2 + P.W / 2;
    const rect = (a, b, c, d) => [[a, b], [c, b], [c, d], [a, d]];
    const items = [
      { type: 'poly', role: 'core', pts: fp.polys[0] }, { type: 'poly', role: 'core', pts: fp.polys[1] },
      ...[['p1', -Lf, 0, y1], ['p3', -Lf, 0, y2], ['p2', len + Lf, len, y1], ['p4', len + Lf, len, y2]].map(([node, xe, xi, y]) => (
        { type: 'poly', role: 'feed', node, width: P.W, pts: rect(Math.min(xe, xi), y - P.W / 2, Math.max(xe, xi), y + P.W / 2), path: [[xe, y], [xi, y]] })),
    ];
    // the export needs a T…_f line per port (it shortens them to the planes); this tool writes its own comparison
    const exportNet = ['.title finger pair', `.freq ${fmin} ${fmax} 201`, `.substrate ${subId}`, ...['p1', 'p2', 'p3', 'p4'].map(q => `port ${q} 50`),
      ...['p1', 'p2', 'p3', 'p4'].map(q => `T${q}_f ${q} ${q}_k W=${P.W}mm len=${Lf}mm`)].join('\n') + '\n';
    // the edge cell from the smallest finger feature (finger width, side gap, tip gap, overlap), not the backbone
    const fine = +(opt('fine', Math.min(P.wf, fp.side, fp.tip, Math.max(fp.overlap, P.wf)) / 3));
    const g = openemsExport(exportNet, { layout: { items, parts: [], substrate: sub, netlist: exportNet, errors: [], title: `fingers n${n}` }, lossless: true, fine });
    const Lps = Object.fromEntries(g.info.ports.map(q => [q.node, q.Lp]));
    const name = `n${n}`, d = join(dir, name); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'f.py'), g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'"));
    writeFileSync(join(d, 'case.json'), JSON.stringify({ ...P, n, len, sub: subId, h, fmin, fmax, Lf, Lp: Lps.p1, cells: g.info.cells, overlap: fp.overlap, side: fp.side, tip: fp.tip }));
    console.log(name, `${len} mm section, ${g.info.cells} cells; overlap ${fp.overlap} mm, side gap ${fp.side} mm, tip gap ${fp.tip} mm`);
  }
}

function run() {
  for (const name of readdirSync(dir).sort()) {
    const d = join(dir, name);
    if (!existsSync(join(d, 'f.py')) || existsSync(join(d, 'f.s4p'))) continue;
    const t0 = Date.now(), r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', ['f.py'], { cwd: d, encoding: 'utf8', maxBuffer: 1 << 28 });
    writeFileSync(join(d, 'run.log'), r.stdout + r.stderr);
    console.log(name, r.status === 0 && !/-nan/.test(r.stdout) ? 'ok' : 'FAILED', `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}

// comb-over's model of a case: plain coupled feeds (from the port planes) + the section as a cline with C, L (SI)
const model = (c, C, L) => {
  const fl = r6(c.Lf - c.Lp), m = (x) => x.toPrecision(8);
  return ['.title finger pair model', `.freq ${c.fmin} ${c.fmax} 11`, `.substrate ${c.sub}`, ...['p1', 'p2', 'p3', 'p4'].map(q => `port ${q} 50`),
    `cline FA geom=msl W=${c.W}mm S=${c.G}mm`, `  len ${fl}mm`, '  Q 1e30', '  A p1 p3', '  B a1 a3', 'end',
    'cline K', `  C [${m(C[0][0])} ${m(C[0][1])}; ${m(C[1][0])} ${m(C[1][1])}]`, `  L [${m(L[0][0])} ${m(L[0][1])}; ${m(L[1][0])} ${m(L[1][1])}]`, `  len ${c.len}mm`, '  Q 1e30', '  A a1 a3', '  B b1 b3', 'end',
    `cline FB geom=msl W=${c.W}mm S=${c.G}mm`, `  len ${fl}mm`, '  Q 1e30', '  A b1 b3', '  B p2 p4', 'end'].join('\n') + '\n';
};
const PAIRS = [1, 2, 3, 4].flatMap(i => [1, 2, 3, 4].map(j => [i, j]));
function errOf(c, F, em, C, L) {
  const r = solve(parseNetlist(model(c, C, L)), F); let e = 0;
  for (const [i, j] of PAIRS) { const a = r.S(i, j), b = em.S(i, j); for (let k = 0; k < F.length; k++) e += (a.re[k] - b.re[k]) ** 2 + (a.im[k] - b.im[k]) ** 2; }
  return Math.sqrt(e / F.length / PAIRS.length);
}
const modes = (C, L) => {   // symmetric pair: even/odd Z and εeff
  const Ce = C[0][0] + C[0][1], Co = C[0][0] - C[0][1], Le = L[0][0] + L[0][1], Lo = L[0][0] - L[0][1];
  return { Ze: Math.sqrt(Le / Ce), Zo: Math.sqrt(Lo / Co), ee: Le * Ce * C0 * C0, eo: Lo * Co * C0 * C0 };
};
function nm(fn, x0, iters = 400, step = 0.1) {
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

function fit() {
  const cases = readdirSync(dir).filter(n => existsSync(join(dir, n, 'f.s4p'))).map(n => ({ name: n, c: JSON.parse(readFileSync(join(dir, n, 'case.json'), 'utf8')) })).sort((a, b) => a.c.n - b.c.n);
  if (!cases.length) { console.error('no results'); process.exit(2); }
  const load = (k) => { const c = cases[k].c, ds = readTouchstone(readFileSync(join(dir, cases[k].name, 'f.s4p'), 'utf8'), { nPorts: 4, name: 'f' }), F = Float64Array.from({ length: 12 }, (_, i) => c.fmin * 1.01 + (c.fmax * 0.99 - c.fmin * 1.01) * i / 11); return { c, F, em: onSweep(ds, F) }; };
  const A = load(0), c = A.c, sub = makeSubstrate(c.sub);
  // the bare backbones (2-D solver): the issue's assumption is L′ = L′(bare), C′ = C′(bare) + the fingers' share
  const bare = solve2d(stripsFromWS([c.W * 1e-3, c.W * 1e-3], c.G * 1e-3, 0), microstrip({ h: sub.dielectric.h, er: sub.dielectric.er }));
  const show = (label, C, L, e) => { const m = modes(C, L); console.log(`${label.padEnd(30)} C11 ${(C[0][0] * 1e12).toFixed(2)} C12 ${(C[0][1] * 1e12).toFixed(2)} pF/m  L11 ${(L[0][0] * 1e9).toFixed(1)} L12 ${(L[0][1] * 1e9).toFixed(1)} nH/m | Ze ${m.Ze.toFixed(1)} Zo ${m.Zo.toFixed(1)} Ω, εe ${m.ee.toFixed(3)} εo ${m.eo.toFixed(3)}${e != null ? ` | rms ΔS ${e.toFixed(4)}` : ''}`); };
  const toCL = (x) => [[[Math.exp(x[0]), -Math.exp(x[1])], [-Math.exp(x[1]), Math.exp(x[0])]], [[Math.exp(x[2]), Math.exp(x[3])], [Math.exp(x[3]), Math.exp(x[2])]]];
  show('bare backbones (2-D solver)', bare.C, bare.L, errOf(c, A.F, A.em, bare.C, bare.L));
  // fit C only, L held at the bare backbones' (the homogenised model of the issue), then all four
  const x0 = [Math.log(bare.C[0][0]), Math.log(-bare.C[0][1]), Math.log(bare.L[0][0]), Math.log(bare.L[0][1])];
  const fC = nm((x) => errOf(c, A.F, A.em, ...toCL([x[0], x[1], x0[2], x0[3]])), x0.slice(0, 2));
  const [Cc, Lc] = toCL([fC.x[0], fC.x[1], x0[2], x0[3]]);
  show(`fit C, L bare (${cases[0].name})`, Cc, Lc, fC.v);
  const fA = nm((x) => errOf(c, A.F, A.em, ...toCL(x)), [fC.x[0], fC.x[1], x0[2], x0[3]], 600, 0.05);
  const [Ca, La] = toCL(fA.x);
  show(`fit C and L (${cases[0].name})`, Ca, La, fA.v);
  for (let k = 1; k < cases.length; k++) {
    const B = load(k);
    console.log(`  predict ${cases[k].name} (${B.c.len} mm): bare ${errOf(B.c, B.F, B.em, bare.C, bare.L).toFixed(4)}, fit C ${errOf(B.c, B.F, B.em, Cc, Lc).toFixed(4)}, fit C and L ${errOf(B.c, B.F, B.em, Ca, La).toFixed(4)} (rms complex ΔS over all 16)`);
    const r = solve(parseNetlist(model(B.c, Ca, La)), B.F), db = (x, q) => 20 * Math.log10(Math.hypot(x.re[q], x.im[q]));
    for (const q of [0, 5, 11]) console.log(`    ${(B.F[q] / 1e9).toFixed(2)} GHz  S31 ${db(r.S(3, 1), q).toFixed(2)} | ${db(B.em.S(3, 1), q).toFixed(2)}  S41 ${db(r.S(4, 1), q).toFixed(2)} | ${db(B.em.S(4, 1), q).toFixed(2)}  S21 ${db(r.S(2, 1), q).toFixed(3)} | ${db(B.em.S(2, 1), q).toFixed(3)}  (model | openEMS)`);
  }
  writeFileSync(join(dir, 'fit.json'), JSON.stringify({ bare: { C: bare.C, L: bare.L }, fitC: { C: Cc, L: Lc, rms: fC.v }, fitCL: { C: Ca, L: La, rms: fA.v } }, null, 1));
}

const fn = { gen, run, fit }[cmd];
if (!fn || !dir) { console.error('usage: node tools/fingercheck.mjs gen|run|fit DIR [options]'); process.exit(2); }
fn();
