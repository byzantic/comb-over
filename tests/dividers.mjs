// Power dividers and hybrids: ideal designs, microstrip, layout, KiCad (issue #39).  Run: node tests/dividers.mjs
import { readFileSync } from 'node:fs';
import { chebyshevTransformer, wilkinson, wilkinsonTree, branchline, ratrace, gysel } from '../js/dividers.js';
import { wilkinsonMsNetlist, realiseWilkinson, assessDivider } from '../js/dividers-ms.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { buildLayout } from '../js/layout-templates.js';
import { boardProject } from '../js/kicad.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const f0 = 2.4e9;
const at = (text, f) => { const r = solve(parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${f} ${f} 1`))); return (i, j) => { const s = r.S(i, j); return { db: 20 * Math.log10(Math.hypot(s.re[0], s.im[0])), ph: Math.atan2(s.im[0], s.re[0]) * 180 / Math.PI, re: s.re[0], im: s.im[0] }; }; };
const band = (text, lo, hi, n = 41) => { const r = solve(parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${lo} ${hi} ${n}`))); return (i, j) => { let m = -Infinity; const s = r.S(i, j); for (let k = 0; k < n; k++) m = Math.max(m, 20 * Math.log10(Math.hypot(s.re[k], s.im[k]))); return m; }; };
const ll = (t) => t.replace(/^(cline K\d+ geom=msl .*)$/mg, '$1\n  Q 1e30').replace(/^(T\S+ .* W=\S+ len=\S+)$/mg, '$1 Q=1e30');

// ---- ideal designs ----
{
  check('quarter-wave transformer: one section is √(Z0 ZL); a Chebyshev design is log-symmetric (Z_k Z_{N+1−k} = Z0 ZL)', near(chebyshevTransformer(100, 50, 1, 0.5)[0], Math.sqrt(5000), 1e-9) && [2, 3].every(N => { const Z = chebyshevTransformer(100, 50, N, 0.7); return Z.every((z, k) => near(z * Z[N - 1 - k], 5000, 1e-6)); }));
  let S = at(wilkinson({ f0 }).netlist, f0);
  check('Wilkinson, one section: −3.0103 dB to each output in phase, matched and isolated at f0', near(S(2, 1).db, -3.0103, 1e-3) && near(S(3, 1).db, -3.0103, 1e-3) && near(S(2, 1).ph, S(3, 1).ph, 1e-9) && S(1, 1).db < -100 && S(3, 2).db < -100 && S(2, 2).db < -100);
  for (const [n, fbw] of [[2, 0.6], [3, 0.9]]) {
    const w = wilkinson({ f0, sections: n, fbw }), B = band(w.netlist, f0 * (1 - fbw / 2), f0 * (1 + fbw / 2));
    check(`Wilkinson, ${n} sections over ±${fbw * 50} %: isolation and output match better than 28 dB, input better than 25 dB`, B(3, 2) < -28 && B(2, 2) < -28 && B(1, 1) < -25, `${B(3, 2)} ${B(2, 2)} ${B(1, 1)}`);
  }
  S = at(wilkinson({ f0, splitDb: 3 }).netlist, f0);
  check('unequal Wilkinson (Pozar §7.3), P3/P2 = 3 dB: the split, match and isolation at f0', near(S(3, 1).db - S(2, 1).db, 3, 1e-6) && near(10 ** (S(2, 1).db / 10) + 10 ** (S(3, 1).db / 10), 1, 1e-9) && S(1, 1).db < -100 && S(3, 2).db < -100);
  S = at(wilkinsonTree({ f0, ways: 4 }).netlist, f0);
  check('4-way Wilkinson tree: −6.02 dB to every output, matched, outputs isolated', [2, 3, 4, 5].every(j => near(S(j, 1).db, -6.0206, 1e-3)) && S(1, 1).db < -100 && S(3, 2).db < -100 && S(4, 2).db < -100);
  S = at(branchline({ f0 }).netlist, f0);
  check('branch-line: −3.01 dB through and coupled, 90° apart; input matched, port 4 isolated', near(S(2, 1).db, -3.0103, 1e-3) && near(S(3, 1).db, -3.0103, 1e-3) && near(((S(3, 1).ph - S(2, 1).ph + 540) % 360) - 180, -90, 1e-6) && S(1, 1).db < -100 && S(4, 1).db < -100);
  S = at(ratrace({ f0 }).netlist, f0);
  check('rat-race: Δ (port 1) out of phase to 2 and 4, port 3 isolated; Σ (port 3) in phase to 2 and 4', near(S(2, 1).db, -3.0103, 1e-3) && near(Math.abs(((S(2, 1).ph - S(4, 1).ph + 540) % 360) - 180), 180, 1e-6) && S(3, 1).db < -100 && near(S(2, 3).ph, S(4, 3).ph, 1e-6) && near(S(2, 3).db, -3.0103, 1e-3));
  const gy = gysel({ f0 });
  check('Gysel (from the even/odd analysis): Z1 = √2 R0, Z2 = √(R R0) = R0, R = R0', near(gy.values.z1, 70.7107, 1e-3) && near(gy.values.z2, 50, 1e-9) && near(gy.values.r, 50, 1e-9));
  const lossy = gy.netlist.replace(/len=(\d+)deg$/mg, 'len=$1deg Q=1000');
  S = at(lossy, f0);
  check('Gysel with line Q 1000 at f0: matched at all ports, isolated, −3.02 dB split', S(1, 1).db < -60 && S(2, 2).db < -60 && S(3, 2).db < -60 && near(S(2, 1).db, -3.02, 0.01), `${S(1, 1).db} ${S(2, 2).db} ${S(3, 2).db} ${S(2, 1).db}`);
  S = at(gy.netlist, f0 * (1 + 1e-4));
  check('Gysel, lossless, 1e-4 from f0: isolated (the trapped even-mode resonance of Z3 sits exactly at f0)', S(3, 2).db < -80 && S(2, 2).db < -90);
}

// ---- compact Wilkinson in microstrip (the example) ----
{
  const text = ex('wilkinson-2g4-ro4350b-1524.cir'), lo = 2.16e9, hi = 2.64e9;
  const a = assessDivider(ll(text), lo, hi, 3);
  check(`compact Wilkinson, coupled arms, ±10 %: return loss ≥ 20 dB at every port, isolation ≥ 20 dB, split within 0.06 dB of −3.01 (${a.rl.map(x => x.toFixed(2))}, ${a.iso.toFixed(2)})`, a.rl[0] >= 20 && a.rl[1] >= 20 && a.iso >= 20 && a.split[0] > -3.07 && a.split[1] < -2.95);
  // the coupling matters: the design that ignores it, evaluated with it
  const u = realiseWilkinson({ f0, sections: 1, fbw: 0.2 }, { substrate: 'jlc-ro4350b-1.524', coupled: false });
  check('the uncoupled-arm design is the committed comparison example', u.netlist === ex('wilkinson-2g4-ro4350b-1524-uncoupled.cir'));
  const asCoupled = assessDivider(wilkinsonMsNetlist(u.spec, u.sub, { ...u.state, coupled: true }, { lossless: true, goals: false }), lo, hi, 3);
  check(`ignoring the arm coupling costs input match (${u.assess.rl[0].toFixed(2)} → ${asCoupled.rl[0].toFixed(2)} dB) and isolation (${u.assess.iso.toFixed(2)} → ${asCoupled.iso.toFixed(2)} dB)`, asCoupled.rl[0] < u.assess.rl[0] - 5 && asCoupled.iso < u.assess.iso - 2);
  const L = buildLayout(parseNetlist(text));
  check('layout: DRC clean, no warnings; one 0603 resistor part across the gap; in/o1/o2 tied', L.errors.length === 0 && L.warnings.length === 0 && L.parts.length === 1 && L.parts[0].kind === 'res' && L.core.ties[0].length === 3, JSON.stringify(L.errors));
  const inPad = L.core.pads.find(pd => pd.node === 'in').polys[0], wfIn = L.items.find(i => i.role === 'feed' && i.node === 'in').width;
  check('the input stub outlasts the feed track\'s round end cap (KiCad would short it to the arms)', Math.max(...inPad.map(q => q[0])) - Math.min(...inPad.map(q => q[0])) > wfIn / 2 + 0.1);
  const b = assessDivider(ll(L.netlist), lo, hi, 3);
  check('as built ≈ design: return loss and isolation within 0.2 dB', Math.abs(b.rl[0] - a.rl[0]) < 0.2 && Math.abs(b.iso - a.iso) < 0.2, JSON.stringify([a, b]));
  const pcb = boardProject(L, { source: text, date: '2026-01-01' });
  const fp = pcb.board.split(/\n\t\(footprint /).find(f => /"Reference" "RI1"/.test(f));
  check('KiCad: RES_0603 RI1 with pad 1 on o1 and pad 2 on o2; courtyard rule for RI*; no via-hole rule', /RES_0603"/.test(fp) && /\(pad "1"[\s\S]*?\(net \d+ "o1"\)/.test(fp) && /\(pad "2"[\s\S]*?\(net \d+ "o2"\)/.test(fp) && /Reference == 'RI\*'/.test(pcb.files[Object.keys(pcb.files).find(k => k.endsWith('.kicad_dru'))]) && !/hole_clearance/.test(pcb.files[Object.keys(pcb.files).find(k => k.endsWith('.kicad_dru'))]));
}

// ---- branch-line in microstrip (the example) ----
{
  const text = ex('branchline-2g4-ro4350b-1524.cir'), a = assessDivider(ll(text), 2.28e9, 2.52e9, 4);
  check(`branch-line, ±5 %: return loss and isolation ≥ 20 dB, through/coupled within ±0.3 dB of −3.01, 90 ± 0.5° (${a.rl[0].toFixed(2)}, ${a.iso.toFixed(2)}, ${a.phase.map(x => x.toFixed(2))})`, a.rl[0] >= 19.99 && a.iso >= 20 && a.split[0] > -3.31 && a.split[1] < -2.71 && a.phase.every(p => Math.abs(p + 90) < 0.5));
  const L = buildLayout(parseNetlist(text));
  check('branch-line layout: DRC clean; four ports on the edges, one tie of four', L.errors.length === 0 && L.items.filter(i => i.type === 'port').length === 4 && L.core.ties[0].length === 4);
  const b = assessDivider(ll(L.netlist), 2.28e9, 2.52e9, 4);
  check('branch-line as built ≈ design (0.05 dB, 0.1°)', Math.abs(b.rl[0] - a.rl[0]) < 0.05 && Math.abs(b.iso - a.iso) < 0.05 && Math.abs(b.phase[0] - a.phase[0]) < 0.1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
