// Geometry synthesis for comb-line / interdigital arrays (issue #13).  Run: node tests/synth-geom.mjs
import { design, assess } from '../js/synth.js';
import { realise, physContext, pairK, syncCap, mapGeometry, charY } from '../js/synth-geom.js';
import { Section, fromCnorm, maxwellFromGroundMutual } from '../js/section.js';
import { makeSubstrate } from '../js/substrates.js';
import { fieldLines } from '../js/fieldlines.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const rel = (a, b) => Math.abs(a / b - 1);

// ---- the coupled-resonator measurements, on the homogeneous design (where the synthesis is exact) ----
for (const spec of [
  { structure: 'comb', type: 'chebyshev', n: 5, ripple: 0.1, f0: 2e9, fbw: 0.05, theta0Deg: 45, Zr: 60, er: 3.66, R0: 50 },
  { structure: 'interdigital', type: 'chebyshev', n: 4, ripple: 0.1, f0: 1.5e9, fbw: 0.12, Zr: 55, er: 2.2, R0: 50 },
]) {
  const r = design(spec), n = spec.n, f0 = r.spec.f0;
  const Cm = Array.from({ length: n }, () => new Array(n).fill(0));
  r.Cm.forEach((v, i) => { Cm[i][i + 1] = Cm[i + 1][i] = v; });
  const CL = fromCnorm(maxwellFromGroundMutual(r.Cg, Cm), r.spec.er), thDeg = r.theta0 * 180 / Math.PI;
  const sec = new Section({ name: 'h', C: CL.C, L: CL.L, Q: Infinity, len: (s) => thDeg / 360 * s.v[0] / f0 });
  const ctx = physContext(r, makeSubstrate('jlc-ro4350b-0.762'), null);
  const zero = new Array(n).fill(0);
  if (spec.structure === 'comb') {
    const cl = Array.from({ length: n }, (_, i) => syncCap(ctx, sec, i, zero, f0));
    check('comb: synchronous tuning from the section admittance reproduces the design\'s loading capacitor', cl.every(c => rel(c, r.Cl) < 1e-9), cl.map(c => c / r.Cl));
    const k = r.Ym.map((_, i) => pairK(ctx, sec, i, cl, f0));
    check('comb: split-mode k from the section admittance = the synthesis\'s pair split (1e-7)', k.every((v, i) => rel(v, r.achieved.k[i]) < 1e-7), k.map((v, i) => v / r.achieved.k[i]));
  } else {
    const k = r.Ym.map((_, i) => pairK(ctx, sec, i, zero, f0));
    check('interdigital: split-mode k from the section admittance = the synthesis\'s pair split (1e-7)', k.every((v, i) => rel(v, r.achieved.k[i]) < 1e-7), k.map((v, i) => v / r.achieved.k[i]));
  }
}

// ---- step 1: widths and gaps reproduce the design's Y0 (diagonal and adjacent couplings) ----
{
  const r = design({ structure: 'comb', type: 'chebyshev', n: 5, ripple: 0.1, f0: 2e9, fbw: 0.05, theta0Deg: 45, Zr: 60, er: 3.66, R0: 50 });
  const sub = makeSubstrate('jlc-ro4350b-0.762'), warnings = [];
  const g = mapGeometry(r, sub, warnings), n = 5;
  const W = Array.from({ length: n }, (_, i) => g.Wh[Math.min(i, n - 1 - i)]), S = Array.from({ length: n - 1 }, (_, i) => g.Sh[Math.min(i, n - 2 - i)]);
  const fl = fieldLines({ W, S, sub, f0: 2e9 }), Y = charY(fl.C, fl.L);
  const e = Math.max(...Array.from({ length: n }, (_, i) => rel(Y[i][i], r.Ya)), ...r.Ym.map((y, i) => rel(-Y[i][i + 1], y)));
  check('Y0 mapping: field-solved Yc (1 oz copper) matches the design on the diagonal and adjacent entries to 1e-6', e < 1e-6 && warnings.length === 0, e);
  const wr = [];
  mapGeometry(design({ structure: 'interdigital', type: 'chebyshev', n: 3, ripple: 0.1, f0: 1e9, fbw: 0.5, Zr: 50, er: 4.5, R0: 50 }), makeSubstrate('jlc-fr4-0.4'), wr);
  check('a gap below the fab minimum is clamped with a warning', wr.some(w => /below the minimum space 0.1 mm; clamped/.test(w)), wr);
}

// ---- acceptance: realised responses in the physical model, with vias and open ends ----
const accept = (name, spec, sub, lim) => {
  const t0 = Date.now();
  const r = design(spec), g = realise(r, { substrate: sub });
  const a = g.assess, T = r.spec.target;
  console.log(`       (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s; ${g.report[1]}; ${g.report[2]})`);
  console.log(`       (${g.report.find(x => x.startsWith('realised'))})`);
  check(`${name}: return loss over the central 80 % of the ripple band ≥ ideal − 0.3 dB (lossless; ideal ${a.rlTarget.toFixed(2)} dB)`, a.rlCore >= a.rlTarget - 0.3, a.rlCore);
  check(`${name}: centre within 0.2 % of f0`, Math.abs(a.fc / T.f0 - 1) < 2e-3, a.fc);
  check(`${name}: −3 dB bandwidth within −2 % … +${lim} % of the ideal`, a.bw3 / a.bw3ideal > 0.98 && a.bw3 / a.bw3ideal < 1 + lim / 100, a.bw3 / a.bw3ideal);
  check(`${name}: no warnings`, g.warnings.length === 0, g.warnings);
  const d = parseNetlist(g.netlist);
  check(`${name}: netlist is physical — field-solved arrays, a via at every shorted end, open-end fringing, a tee at each tap, .layout`,
    d.sections.filter(s => s.N > 1).every(s => s.geom?.kind === 'mslN' && s.geom.model === 'field') && d.elements.filter(e => e.via).length === spec.n && (g.netlist.match(/^Coe\d/mg) || []).length === spec.n
      && (d.blocks ?? []).filter(b => b.type === 'tee').length === 2 && d.layout?.type === spec.structure && d.substrate.id === sub);
  const res = solve(parseNetlist(g.netlist.replace(/^\.freq .*$/m, `.freq ${T.f0} ${T.f0} 1`))), s21 = res.S(2, 1);
  const il = -20 * Math.log10(Math.hypot(s21.re[0], s21.im[0]));
  check(`${name}: with the substrate's loss, insertion loss at f0 is finite and as reported (${il.toFixed(2)} dB)`, il > 0.1 && il < 6 && g.report.some(x => x.includes(`insertion loss at f0 ${+il.toPrecision(3)} dB`)), il);
  return g;
};
accept('5-pole comb-line, 2 GHz 5 %, 0.762 mm RO4350B', { structure: 'comb', type: 'chebyshev', n: 5, ripple: 0.1, f0: 2e9, fbw: 0.05, theta0Deg: 45, Zr: 60, er: 3.66, R0: 50 }, 'jlc-ro4350b-0.762', 4);
accept('3-pole interdigital, 1.5 GHz 10 %, FR-4 1.6 mm', { structure: 'interdigital', type: 'chebyshev', n: 3, ripple: 0.1, f0: 1.5e9, fbw: 0.1, Zr: 50, er: 4.5, R0: 50 }, 'jlc-fr4-1.6', 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
