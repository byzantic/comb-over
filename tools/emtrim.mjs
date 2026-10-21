// Trim a compact Wilkinson against openEMS by output space mapping (issue #47).
// Usage:
//   node tools/emtrim.mjs SPEC.json --substrate ID --out DIR [--rounds 4] [--target -20] [--e24]
// Needs openEMS's Python modules (OPENEMS_PYTHON selects the interpreter, default python3).
//
// Each round: lay out the design, simulate it in openEMS (all ports), take the complex difference
// delta(f) = S_openEMS − S_comb-over for S11, S21, S31, S22, S32 at the same reference planes, and re-optimise
// the arm width, arm length, resistor and input taper so that comb-over + delta meets the goals (match and
// isolation 3 dB inside the target, split no worse than −3.15 dB). It stops when openEMS itself meets the
// target over the band. With --e24 the resistor is rounded to the nearest E24 value and verified once more.
// Writes DIR/NAME.cir (the trimmed design, with its .layout), DIR/em/ (the openEMS result and the
// comparison netlist of the final design) and DIR/trim.log.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realiseWilkinson, wilkinsonMsNetlist } from '../js/dividers-ms.js';
import { openemsExport } from '../js/openems.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';

const args = process.argv.slice(2), get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const specFile = args[0], out = get('out'), subId = get('substrate'), rounds = Number(get('rounds', 4)), target = Number(get('target', -20)), e24 = args.includes('--e24');
if (!specFile || !out || !subId) { console.error('usage: node tools/emtrim.mjs SPEC.json --substrate ID --out DIR [--rounds 4] [--target -20] [--e24]'); process.exit(2); }
mkdirSync(out, { recursive: true });
const log = (s) => { console.log(s); appendFileSync(join(out, 'trim.log'), s + '\n'); };
writeFileSync(join(out, 'trim.log'), '');

const spec0 = JSON.parse(readFileSync(specFile, 'utf8'));
const R0 = realiseWilkinson(spec0, { substrate: subId });
const sub = R0.sub, spec = R0.spec, lo = spec.f0 * (1 - spec.fbw / 2), hi = spec.f0 * (1 + spec.fbw / 2);
const F = Float64Array.from({ length: 13 }, (_, k) => lo + (hi - lo) * k / 12);
const PAIRS = [[1, 1], [2, 1], [3, 1], [2, 2], [3, 2]];
const dB = ([a, b]) => 20 * Math.log10(Math.hypot(a, b));
const net = (st, o = {}) => wilkinsonMsNetlist(spec, sub, st, { layout: true, ...o });
const sample = (S) => Object.fromEntries(PAIRS.map(([i, j]) => { const s = S(i, j); return [`${i}${j}`, Array.from(F, (_, k) => [s.re[k], s.im[k]])]; }));
const model = (st) => sample(solve(parseNetlist(openemsExport(net(st)).compare.replace(/^\.data .*$/m, '')), F).S);
const add = (A, D) => Object.fromEntries(Object.keys(A).map(k => [k, A[k].map((v, i) => [v[0] + D[k][i][0], v[1] + D[k][i][1]])]));
const worst = (S) => ({ s11: Math.max(...S['11'].map(dB)), s22: Math.max(...S['22'].map(dB)), s32: Math.max(...S['32'].map(dB)), split: [Math.min(...S['21'].map(dB)), Math.max(...S['21'].map(dB))] });
const fmtW = (w) => `S11 ${w.s11.toFixed(2)}, S22 ${w.s22.toFixed(2)}, S32 ${w.s32.toFixed(2)} dB; S21 ${w.split[0].toFixed(3)} … ${w.split[1].toFixed(3)} dB`;
const meets = (w) => w.s11 <= target && w.s22 <= target && w.s32 <= target;
const cost = (S) => { let c = 0; for (const k of ['11', '22', '32']) for (const v of S[k]) c += Math.max(0, dB(v) - (target - 3)) ** 2; for (const k of ['21', '31']) for (const v of S[k]) c += 4 * Math.max(0, -3.15 - dB(v)) ** 2; return c; };

function simulate(st, tag) {
  const g = openemsExport(net(st)), d = join(out, `round-${tag}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${g.name}.py`), g.script); writeFileSync(join(d, 'compare.cir'), g.compare); writeFileSync(join(d, 'design.cir'), net(st));
  const t0 = Date.now(), r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', [join(d, `${g.name}.py`)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0 || /-nan/.test(r.stdout)) throw new Error(`openEMS failed in ${d}:\n${(r.stderr || r.stdout).slice(-2000)}`);
  const tsn = readdirSync(d).find(f => /\.s3p$/.test(f)), ds = readTouchstone(readFileSync(join(d, tsn), 'utf8'), { nPorts: 3, name: tsn });
  log(`  openEMS ${tag}: ${g.info.cells} cells, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return { E: sample(onSweep(ds, F).S), dir: d, name: g.name };
}

// Nelder–Mead on a box-normalised space
function nm(fn, x0, lo_, hi_, iters = 200) {
  const n = x0.length, u2x = (u) => u.map((v, i) => lo_[i] + (hi_[i] - lo_[i]) * Math.min(1, Math.max(0, v))), x2u = (x) => x.map((v, i) => (v - lo_[i]) / (hi_[i] - lo_[i]));
  let P = [x2u(x0)]; for (let i = 0; i < n; i++) { const p = [...P[0]]; p[i] += 0.08; P.push(p); }
  let V = P.map(p => fn(u2x(p)));
  for (let it = 0; it < iters; it++) {
    const ord = V.map((_, i) => i).sort((a, b) => V[a] - V[b]); P = ord.map(i => P[i]); V = ord.map(i => V[i]);
    const c = Array.from({ length: n }, (_, j) => P.slice(0, n).reduce((s, p) => s + p[j], 0) / n), at = (t) => c.map((v, j) => v + t * (P[n][j] - v));
    const r = at(-1), fr = fn(u2x(r));
    if (fr < V[0]) { const e = at(-2), fe = fn(u2x(e)); if (fe < fr) { P[n] = e; V[n] = fe; } else { P[n] = r; V[n] = fr; } }
    else if (fr < V[n - 1]) { P[n] = r; V[n] = fr; }
    else { const k = at(0.5), fk = fn(u2x(k)); if (fk < V[n]) { P[n] = k; V[n] = fk; } else for (let i = 1; i <= n; i++) { P[i] = P[i].map((v, j) => P[0][j] + 0.5 * (v - P[0][j])); V[i] = fn(u2x(P[i])); } }
  }
  const b = V.indexOf(Math.min(...V)); return { x: u2x(P[b]), v: V[b] };
}
if (spec.sections !== 1) { console.error('emtrim: one-section Wilkinsons only'); process.exit(2); }
const withX = (st, [w, l, r, lt]) => ({ ...st, W: [w], L: [l], R: [r], lt });
const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
const nearestE24 = (r) => { const dec = 10 ** Math.floor(Math.log10(r)); return [...E24.map(v => v * dec / 10), 10 * dec].reduce((a, b) => (Math.abs(Math.log(b / r)) < Math.abs(Math.log(a / r)) ? b : a)); };

let st = { ...R0.state }, sim, history = [];
log(`${basename(specFile)} on ${subId}: f0 ${spec.f0 / 1e9} GHz, ±${spec.fbw * 50} %, target ${target} dB`);
for (let k = 0; ; k++) {
  log(`round ${k}: W ${st.W[0].toFixed(4)} mm, L ${st.L[0].toFixed(4)} mm, R ${st.R[0].toFixed(2)} Ω, taper ${st.lt.toFixed(3)} mm`);
  const M = model(st); sim = simulate(st, k);
  const wm = worst(M), we = worst(sim.E);
  log(`  comb-over: ${fmtW(wm)}`); log(`  openEMS:   ${fmtW(we)}`);
  history.push({ k, st: { W: st.W[0], L: st.L[0], R: st.R[0], lt: st.lt }, comb: wm, em: we });
  if (meets(we) || k >= rounds) break;
  const D = Object.fromEntries(Object.keys(M).map(q => [q, M[q].map((v, i) => [sim.E[q][i][0] - v[0], sim.E[q][i][1] - v[1]])]));
  const x0 = [st.W[0], st.L[0], st.R[0], st.lt], res = nm((x) => cost(add(model(withX(st, x)), D)), x0, [x0[0] * 0.6, x0[1] * 0.8, x0[2] * 0.5, 0.5], [x0[0] * 1.5, x0[1] * 1.2, x0[2] * 2, 8]);
  st = withX(st, res.x);
  log(`  predicted next: ${fmtW(worst(add(model(st), D)))}`);
}
let final = history.at(-1);
if (e24) {
  const r = nearestE24(st.R[0]);
  if (Math.abs(r - st.R[0]) > 1e-9) {
    st = { ...st, R: [r] }; log(`E24: R ${final.st.R.toFixed(2)} → ${r} Ω`);
    const M = model(st); sim = simulate(st, 'e24');
    final = { k: 'e24', st: { W: st.W[0], L: st.L[0], R: r, lt: st.lt }, comb: worst(M), em: worst(sim.E) };
    log(`  comb-over: ${fmtW(final.comb)}`); log(`  openEMS:   ${fmtW(final.em)}`); history.push(final);
  }
}
// the trimmed design: no goals (comb-over alone does not predict its match); the trim recorded in the header
st.report = [
  ...R0.state.report.filter(l => !/^lossless/.test(l)).map(l => (/^sections:/.test(l) ? l.replace(/^sections: [^;]*;/, `sections: W ${st.W[0].toFixed(4)} mm, ${st.L[0].toFixed(4)} mm, R ${st.R[0]} Ω (trimmed);`) : /^input: a [\d.]+ mm/.test(l) ? l.replace(/^input: a [\d.]+ mm/, `input: a ${st.lt.toFixed(3)} mm`) : l)),
  `trimmed against openEMS by output space mapping (tools/emtrim.mjs, ${history.length} simulations): arms, resistor and input taper chosen so that openEMS meets the goals`,
  `openEMS, ${(lo / 1e9).toFixed(3)}–${(hi / 1e9).toFixed(3)} GHz (worst): ${fmtW(final.em)}`,
  `comb-over alone predicts ${fmtW(final.comb)}: its bend and output-split models miss part of what openEMS sees (#47)`,
];
const name = basename(specFile).replace(/\.json$/, '');
writeFileSync(join(out, `${name}.cir`), net(st, { goals: false }) + '.plot ylim=-50,0 db(S11) db(S21) db(S31) db(S22) db(S32)\n');
writeFileSync(join(out, 'history.json'), JSON.stringify(history, null, 1));
log(`wrote ${join(out, `${name}.cir`)}; final openEMS run in ${sim.dir}${meets(final.em) ? '' : ' — TARGET NOT MET'}`);
process.exit(meets(final.em) ? 0 : 1);
