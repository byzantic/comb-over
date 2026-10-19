// Touchstone import and data overlay (issue #17).  Run: node tests/touchstone.mjs
import { readFileSync } from 'node:fs';
import { touchstone, readTouchstone, renormalize, onSweep, portsFromName } from '../js/touchstone.js';
import { attachData } from '../js/data.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { parseExpr, evalTrace } from '../js/expr.js';
import { optimise, goalCost } from '../js/optimize.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const maxDiff = (r, ds) => { let m = 0; for (let k = 0; k < r.freq.length; k++) for (let i = 0; i < r.P; i++) for (let j = 0; j < r.P; j++) { const o = k * r.P * r.P + i * r.P + j; m = Math.max(m, Math.hypot(r.Sre[o] - ds.re[o], r.Sim[o] - ds.im[o])); } return m; };

// ---- round trip through our own writer ----
for (const [f, P] of [['transformers.cir', null], ['combline-4pole.cir', 2], ['coupler-10dB-microstrip.cir', 4], ['marchand-balun.cir', 3]]) {
  const d = parseNetlist(ex(f)), r = solve(d);
  for (const format of ['RI', 'MA', 'DB']) {
    const text = touchstone(r, d.ports, { format });
    const ds = readTouchstone(text, { nPorts: r.P });
    check(`${f}: ${r.P}-port ${format} round trip`, ds.P === r.P && ds.freq.length === r.freq.length && ds.freq.every((x, k) => near(x, r.freq[k], r.freq[k] * 1e-11)) && maxDiff(r, ds) < 1e-8, maxDiff(r, ds));
  }
}
{
  // mixed reference impedances → Touchstone 2.0 with [Reference]
  const d = parseNetlist(ex('marchand-balun.cir').replace(/^port outp\b.*$/m, 'port outp 25').replace(/^port outn\b.*$/m, 'port outn 25'));
  const r = solve(d), text = touchstone(r, d.ports);
  const ds = readTouchstone(text);
  check('v2.0 file: version, ports and per-port [Reference] read back', ds.version === 2 && ds.P === 3 && ds.z.join() === d.ports.map(p => p.z).join() && maxDiff(r, ds) < 1e-8);
}

// ---- format details ----
{
  const v1 = `! 2-port, MHz, DB
# MHz S DB R 50
100 -20 10 -1 20 -1.5 30 -25 40
200 -21 11 -1.1 21 -1.6 31 -26 41
! noise parameters follow (lower frequency restarts the table)
50 1.2 0.3 45 0.5
`;
  const ds = readTouchstone(v1, { nPorts: 2 });
  const at = (i, j) => { const o = 0 * 4 + i * 2 + j; return [20 * Math.log10(Math.hypot(ds.re[o], ds.im[o])), Math.atan2(ds.im[o], ds.re[o]) * 180 / Math.PI]; };
  check('v1.1 2-port order is 11 21 12 22; MHz and DB converted', ds.freq[0] === 100e6 && near(at(1, 0)[0], -1, 1e-9) && near(at(0, 1)[0], -1.5, 1e-9) && near(at(1, 1)[1], 40, 1e-9));
  check('v1.1 noise data after the network data is ignored', ds.freq.length === 2);
  check('port count guessed from the data when there is no extension', readTouchstone(v1).P === 2);
  const v2 = `[Version] 2.0
# GHz S RI R 50
[Number of Ports] 2
[Two-Port Data Order] 12_21
[Number of Frequencies] 1
[Network Data]
1 0.1 0 0.2 0 0.3 0 0.4 0
[End]`;
  const d2 = readTouchstone(v2);
  check('v2.0 [Two-Port Data Order] 12_21 honoured', near(d2.re[1], 0.2, 1e-12) && near(d2.re[2], 0.3, 1e-12));
  const v3 = `[Version] 2.0
# Hz S RI R 50
[Number of Ports] 3
[Number of Frequencies] 1
[Matrix Format] Lower
[Network Data]
1e9 0.1 0  0.2 0 0.3 0  0.4 0 0.5 0 0.6 0
[End]`;
  const d3 = readTouchstone(v3);
  check('v2.0 [Matrix Format] Lower fills the symmetric matrix', near(d3.re[0 * 3 + 1], 0.2, 1e-12) && near(d3.re[1 * 3 + 0], 0.2, 1e-12) && near(d3.re[2 * 3 + 1], 0.5, 1e-12) && near(d3.re[1 * 3 + 2], 0.5, 1e-12));
  check('Y/Z-parameter files are refused', throws(() => readTouchstone('# GHz Y RI R 50\n1 0.1 0\n', { nPorts: 1 }), /only S-parameter/));
  check('port count from the extension', portsFromName('board.S4P') === 4 && portsFromName('x.txt') === null);
}

// ---- renormalisation ----
{
  // a 1-port load Z: in 50 Ω, Γ = (Z−50)/(Z+50); renormalised to Z it must vanish
  const Z = 75, g = (Z - 50) / (Z + 50);
  const ds = { P: 1, freq: Float64Array.from([1e9]), re: Float64Array.from([g]), im: Float64Array.from([0]), z: [50] };
  const r = renormalize(ds, [75]);
  check('renormalising a 75 Ω load to 75 Ω gives S11 = 0', near(Math.hypot(r.re[0], r.im[0]), 0, 1e-12));
  const d = parseNetlist(ex('coupler-10dB-microstrip.cir')), res = solve(d);
  const ds4 = readTouchstone(touchstone(res, d.ports), { nPorts: 4 });
  const back = renormalize(renormalize(ds4, [25, 25, 100, 100]), [50, 50, 50, 50]);
  check('4-port renormalised away and back is unchanged', maxDiff(res, back) < 1e-9, maxDiff(res, back));
}

// ---- interpolation ----
{
  const ds = { P: 1, freq: Float64Array.from([1e9, 2e9]), re: Float64Array.from([0.5, 0]), im: Float64Array.from([0, 0.25]), z: [50] };
  const sw = onSweep(ds, Float64Array.from([0.5e9, 1e9, 1.5e9, 2e9, 3e9]));
  const s = sw.S(1, 1), mag = (k) => Math.hypot(s.re[k], s.im[k]), ph = (k) => Math.atan2(s.im[k], s.re[k]);
  check('interpolation: exact at data points', near(s.re[1], 0.5, 1e-12) && near(s.im[3], 0.25, 1e-12));
  check('interpolation: magnitude and phase linear in between', near(mag(2), 0.375, 1e-12) && near(ph(2), Math.PI / 4, 1e-12));
  check('outside the data: blank, and counted', Number.isNaN(s.re[0]) && Number.isNaN(s.re[4]) && sw.outside === 2);
}

// ---- in the netlist: the acceptance cases ----
{
  const src = ex('coupler-10dB-microstrip.cir');
  const d = parseNetlist(src), r = solve(d);
  const files = { 'coupler.s4p': touchstone(r, d.ports) };
  const d2 = parseNetlist(src + '\n.data meas coupler.s4p overlay\n'), r2 = solve(d2);
  const att = attachData(d2, r2.freq, files);
  check('.data parses: name, file, overlay', d2.data[0].name === 'meas' && d2.data[0].file === 'coupler.s4p' && d2.data[0].overlay);
  const ctx = { n: r2.freq.length, freq: r2.freq, S: (i, j) => r2.S(i, j), scope: d2.scope, data: att.data };
  const diff = evalTrace(parseExpr('mag(S31 - meas.S31)'), ctx).re;
  check('an exported file round-trips onto its own model (meas.S31 = S31)', att.warnings.length === 0 && Math.max(...diff) < 1e-8, Math.max(...diff));
  check('data in .goal: identical data gives zero cost', goalCost(parseNetlist(src + '\n.data meas coupler.s4p\n.goal db(S31)-db(meas.S31) = 0\n'), r2, att.data).cost < 1e-12);
  check('unloaded file is a warning, not an error', /not loaded/.test(attachData(d2, r2.freq, {}).warnings[0]));
  check('unknown data set in a trace is an error', throws(() => evalTrace(parseExpr('db(foo.S21)'), ctx), /unknown data set "foo"/));
  check('reference mismatch is flagged with the fix', /add z=50/.test(attachData(parseNetlist(src + '\n.data meas c.s4p\n'), r2.freq, { 'c.s4p': touchstone(r, d.ports.map(p => ({ ...p, z: 25 }))) }).warnings.join()));
  check('.data twice is an error', throws(() => parseNetlist(src + '\n.data m a.s2p\n.data m b.s2p\n'), /twice/));
}

// ---- fitting launch parasitics to "measured" data ----
{
  const net = (l, c) => `.freq 0.5G 6G 56
.substrate jlc-ro4350b-0.508
port a
L1 a x ${l}
C1 a 0 ${c}
T1 x b W=1.073mm len=20mm
R1 b 0 75
`;
  const meas = (() => { const d = parseNetlist(net('0.5n', '0.3p')); return touchstone(solve(d), d.ports); })();
  let text = `${net('sl', 'sc')}.param sl = 0.1n tune 1p 2n\n.param sc = 0.05p tune 1f 1p\n.data meas launch.s1p\n.goal mag(S11-meas.S11) < 0.001\n`;
  const files = { 'launch.s1p': meas };
  for (let round = 0; round < 3; round++) { const g = optimise(text, { maxiter: 400, files }); let s; while (!(s = g.next()).done) {} text = text.replace(/^\.param sl = \S+/m, `.param sl = ${s.value.best.sl}`).replace(/^\.param sc = \S+/m, `.param sc = ${s.value.best.sc}`); }
  const p = Object.fromEntries(parseNetlist(text, {}, { files }).params.map(x => [x.name, x.value]));
  check('optimiser fits series L and shunt C of a launch to measured S11 (0.5 nH, 0.3 pF)', near(p.sl, 0.5e-9, 0.01e-9) && near(p.sc, 0.3e-12, 0.01e-12), `${p.sl} ${p.sc}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
