// Synthesis tests.  Run: node tests/synth.mjs
import { gValues, design, assess, returnLossDb } from '../js/synth.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { optimise, writeBack } from '../js/optimize.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- prototype tables (Matthaei Table 4.05-2) ----
{
  const g = gValues('chebyshev', 4, 0.1);
  const want = [1, 1.1088, 1.3061, 1.7703, 0.8180, 1.3554];
  check('Chebyshev 0.1 dB n=4 g-values', g.every((x, i) => near(x, want[i], 2e-4)), g.map(x => x.toFixed(4)).join(' '));
  const g3 = gValues('chebyshev', 3, 0.5);
  check('Chebyshev 0.5 dB n=3 g-values', [1, 1.5963, 1.0967, 1.5963, 1].every((x, i) => near(g3[i], x, 2e-4)));
  const gb = gValues('butterworth', 3);
  check('Butterworth n=3 g-values', [1, 1, 2, 1, 1].every((x, i) => near(gb[i], x, 1e-12)));
  const ge = gValues('chebyshev', 6, 0.2);
  check('Chebyshev even n: g_n g_n+1 = g_0 g_1', near(ge[6] * ge[7], ge[1], 1e-12));
}

// ---- comb pair split frequencies: analytic model vs. full engine ----
{
  // two comb resonators, others absent; weakly probed at the open ends
  const Ya = 1 / 70, Ym = 1.5e-3, eta = 376.730313668, th0 = 45, f0 = 1e9, Cl = Ya / Math.tan(Math.PI / 4) / (2 * Math.PI * f0);
  const net = `.freq 0.85G 1.15G 30001\n.ref 1G\nport r1 1e7\nport r2 1e7
cline P\n  len ${th0}deg\n  Cg ${(Ya - Ym) * eta} ${(Ya - Ym) * eta}\n  Cm ${Ym * eta}\n  A 0 0\n  B r1 r2\nend\nC1 r1 0 ${Cl}\nC2 r2 0 ${Cl}`;
  const r = solve(parseNetlist(net)), s = r.S(2, 1);
  const m = Array.from(r.freq, (_, k) => Math.hypot(s.re[k], s.im[k]));
  const peaks = []; for (let k = 1; k < m.length - 1; k++) if (m[k] > m[k - 1] && m[k] >= m[k + 1] && m[k] > 0.5) peaks.push(r.freq[k]);
  // analytic: ωCl − (Ya ± Ym) cot θ = 0
  const root = (Y) => { let lo = 0.5e9, hi = 1.5e9; for (let i = 0; i < 100; i++) { const f = (lo + hi) / 2; (2 * Math.PI * f * Cl - Y / Math.tan(Math.PI / 4 * f / f0) > 0) ? hi = f : lo = f; } return (lo + hi) / 2; };
  const fe = root(Ya - Ym), fo = root(Ya + Ym);
  check('comb pair: engine resonances match analytic split', peaks.length === 2 && near(peaks[0], fe, 2e4) && near(peaks[1], fo, 2e4), `${peaks} vs ${fe} ${fo}`);
}

// ---- full designs ----
for (const structure of ['comb', 'interdigital']) {
  for (const fbw of [0.05, 0.15]) {
    const r = design({ structure, n: 5, fbw, f0: 2e9, ripple: 0.0432, theta0Deg: 40 });
    const a = assess(r);
    check(`${structure} ${fbw * 100}%: centre within 0.05 %`, near(a.fc, 2e9, 1e6), a.fc);
    check(`${structure} ${fbw * 100}%: −3 dB bandwidth within 0.5 %`, near(a.bw3 / a.bw3ideal, 1, 5e-3), `${a.bw3} vs ${a.bw3ideal}`);
    check(`${structure} ${fbw * 100}%: in-band return loss ≥ 13 dB before polishing`, a.rlCore >= 13, a.rlCore);
    check(`${structure} ${fbw * 100}%: split-mode k matches target`, r.achieved.k.every((k, i) => near(k, r.k[i], 1e-9)));
    check(`${structure} ${fbw * 100}%: tap-loaded Qe matches target`, near(r.tapReport.Qe / r.Qe, 1, 1e-3));
    const opt = optimise(r.netlist, { maxiter: 600 }); let s; while (!(s = opt.next()).done) {}
    const b = assess({ ...r, netlist: writeBack(r.netlist, s.value.best) });
    check(`${structure} ${fbw * 100}%: optimiser polish reaches ≥ ${returnLossDb(0.0432).toFixed(1)} dB return loss`, b.rlCore >= returnLossDb(0.0432) - 0.3, b.rlCore);
  }
}
{
  const r = design({ structure: 'comb', type: 'butterworth', n: 3, fbw: 0.08, refine: false });
  const d = parseNetlist(r.netlist);
  check('Butterworth closed-form netlist parses and solves', solve(d).failures === 0 && d.ports.length === 2);
}
{
  let msg = '';
  try { design({ structure: 'comb', n: 4, fbw: 0.6, Zr: 30 }); } catch (e) { msg = e.message; }
  const r = msg ? null : design({ structure: 'comb', n: 4, fbw: 0.6, Zr: 30 });
  check('impossible design is reported (error or warning)', msg || r.warnings.length, msg);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
