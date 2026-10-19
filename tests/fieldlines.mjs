// N-line microstrip geometry through the field solver (issue #12).  Run: node tests/fieldlines.mjs
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { solve as solveNet } from '../js/solver.js';
import { mslineLoss, mscoupled } from '../js/microstrip.js';
import { fieldLines, clearFieldCache } from '../js/fieldlines.js';
import { solve, microstrip, stripsFromWS } from '../solver/mtl2d.js';
import { optimise } from '../js/optimize.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const rel = (a, b) => Math.abs(a / b - 1);
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');

const net = (cl, n, sub = 'jlc-ro4350b-0.508 t=0') => `.freq 1G 3G 3\n.substrate ${sub}\n${Array.from({ length: 2 * n }, (_, i) => `port p${i}`).join('\n')}\ncline K ${cl}\n  len 15mm\n  A ${Array.from({ length: n }, (_, i) => `p${i}`).join(' ')}\n  B ${Array.from({ length: n }, (_, i) => `p${i + n}`).join(' ')}\nend\n`;

// ---- a pair: field solver vs the closed-form path ----
{
  let w = 0, wq = 0;
  for (const [W, S] of [['1.1mm', '0.2mm'], ['0.6mm', '0.3mm'], ['1.5mm', '0.15mm']]) {
    const a = parseNetlist(net(`geom=msl W=${W} S=${S} f0=0.5G`, 2)).sections[0], b = parseNetlist(net(`geom=msl W=${W} S=${S} f0=0.5G model=field`, 2)).sections[0];
    w = Math.max(w, rel(a.geom.Ze, b.geom.Ze), rel(a.geom.Zo, b.geom.Zo), rel(a.geom.epse, b.geom.epse), rel(a.geom.epso, b.geom.epso));
    wq = Math.max(wq, ...a.Qm.map((q, i) => rel(q, b.Qm[i])));
  }
  check('symmetric pair, t = 0: model=field agrees with Kirschning–Jansen within 1 % (Ze, Zo, εe, εo)', w < 0.01, w);
  check('… and the per-mode Q (Wheeler matrix + filling factor) within 1 %', wq < 0.01, wq);
  const g = parseNetlist(net('geom=msl W=1.1mm S=0.2mm model=field', 2)).sections[0].geom;
  check('a field-solved symmetric pair keeps the msl2 geometry record (for the layout templates)', g.kind === 'msl2' && g.model === 'field' && g.W === 1.1e-3);
}

// ---- N lines ----
{
  const d = parseNetlist(net('W=[0.8mm 1.2mm 0.8mm] S=[0.2mm 0.3mm]', 3)), s = d.sections[0];
  const ref = solve(stripsFromWS([0.8e-3, 1.2e-3, 0.8e-3], [0.2e-3, 0.3e-3]), microstrip({ h: 0.508e-3, er: 3.66 }));
  check('W=[…] S=[…] gives a 3-line section with the solver\'s C and L', s.N === 3 && s.geom.kind === 'mslN' && s.C.every((r, i) => r.every((v, j) => rel(v, ref.C[i][j]) < 1e-12)) && s.L.every((r, i) => r.every((v, j) => rel(v, ref.L[i][j]) < 1e-12)));
  check('block form (W [..] / S ..) and inline form agree; a single S fills every gap', (() => {
    const t = `.freq 1G 3G 3\n.substrate jlc-ro4350b-0.508 t=0\nport a\nport b\nport c\nport e\nport f\nport g\ncline K\n  geom msl\n  W [0.8mm 1mm 0.8mm]\n  S 0.25mm\n  len 15mm\n  A a b c\n  B e f g\nend\n`;
    const x = parseNetlist(t).sections[0], y = parseNetlist(net('W=[0.8mm 1mm 0.8mm] S=[0.25mm 0.25mm]', 3)).sections[0];
    return x.C.every((r, i) => r.every((v, j) => v === y.C[i][j]));
  })());
  check('a single W with a list of gaps gives equal widths', parseNetlist(net('W=1mm S=[0.2mm 0.3mm]', 3)).sections[0].geom.W.join() === [1e-3, 1e-3, 1e-3].join());
  check('the 3-line section solves', (() => { const r = solveNet(d); return [1, 2, 3].every(j => Number.isFinite(r.S(1, j).re[0])); })());
  check('params in the lists: W=[w 1.2mm w]', rel(parseNetlist(`.param w = 0.9mm\n${net('W=[w 1.2mm w] S=0.2mm', 3)}`).sections[0].geom.W[2], 0.9e-3) < 1e-12);
}

// ---- loss: limits ----
{
  // widely spaced: every mode → the single line's Q
  const far = parseNetlist(net('W=[1mm 1mm 1mm] S=[30mm 30mm] f0=2G', 3)).sections[0];
  const sub = parseNetlist(net('W=1mm S=1mm', 2)).substrate;
  const single = mslineLoss({ W: 1e-3, h: sub.dielectric.h, t: 0, er: sub.dielectric.er, tand: sub.dielectric.tand, sigma: sub.copper.sigma, rough: sub.copper.roughness || 0, f: 2e9 });
  check('widely spaced lines: every modal Q → the single line\'s Q (1 %)', far.Qm.every(q => rel(q, single.Q) < 0.01), `${far.Qm} vs ${single.Q}`);
  // dielectric only: perfect conductor
  const pec = parseNetlist(net('W=[0.8mm 1.2mm 0.8mm] S=[0.2mm 0.3mm]', 3, 'jlc-ro4350b-0.508 t=0 sigma=1e30')).sections[0];
  const er = 3.66, tand = sub.dielectric.tand;
  check('perfect conductor: Q = 1/(tanδ · filling factor) for each mode', pec.Qm.every((q, k) => { const e = pec.epsEff[k]; return rel(q, e * (er - 1) / (tand * er * (e - 1))) < 1e-9; }));
  check('the centre-against-outer mode (current crowding in both gaps) is lossier than the in-phase mode', (() => { const s = parseNetlist(net('W=[1mm 1mm 1mm] S=0.15mm', 3)).sections[0]; const m = s.modalInfo(); const even = m.findIndex(x => x.vector.every(v => v > 0)), odd = m.findIndex(x => x.vector[1] > 0 && x.vector[0] < 0 && x.vector[2] < 0); return odd >= 0 && s.Qm[odd] < s.Qm[even]; })());
}

// ---- thickness warning ----
{
  const w1 = parseNetlist(net('W=[0.8mm 0.8mm 0.8mm] S=0.12mm', 3, 'jlc-ro4350b-0.508')).warnings.join('\n');
  check('t > 0 with a tight gap: the zero-thickness estimate is reported', /zero-thickness strips; .* about \d+\.\d % \(worst mode of the pair at the tightest gap, 0\.120 mm\)/.test(w1), w1);
  check('t = 0: no thickness warning', !/zero-thickness/.test(parseNetlist(net('W=[0.8mm 0.8mm 0.8mm] S=0.12mm', 3)).warnings.join()));
  const pct = (t) => +/about (\d+\.\d) %/.exec(t)[1];
  const w2 = parseNetlist(net('W=[0.8mm 0.8mm 0.8mm] S=1.5mm', 3, 'jlc-ro4350b-0.508')).warnings.join();
  check('the estimate is smaller for wide gaps (what remains is the width effect on each line)', pct(w2) < pct(w1), `${pct(w2)} vs ${pct(w1)}`);
}

// ---- errors ----
{
  check('model=closed with lists is an error', throws(() => parseNetlist(net('W=[1mm 1mm 1mm] S=0.2mm model=closed', 3)), /closed-form model is for a symmetric pair/));
  check('gap count must match', throws(() => parseNetlist(net('W=[1mm 1mm 1mm] S=[0.2mm]', 3)), /3 strips need 2 gaps/));
  check('model= without a geometry is an error', throws(() => parseNetlist(`.freq 1G 2G 3\nport a\nport b\nport c\nport e\ncline K model=field\n  Zeo 60 40\n  len 10mm\n  A a b\n  B c e\nend\n`), /model= applies to a geometry/));
  check('unknown model is an error', throws(() => parseNetlist(net('W=[1mm 1mm] S=0.2mm model=fdtd', 2)), /model is closed/));
  check('section/line count mismatch is still caught', throws(() => parseNetlist(net('W=[1mm 1mm 1mm] S=0.2mm', 3).replace('A p0 p1 p2', 'A p0 p1')), /A lists 2 nodes/));
  check('zero gap is refused', throws(() => parseNetlist(net('W=[1mm 1mm] S=0', 2)), /S must be > 0/));
}

// ---- cache ----
{
  clearFieldCache();
  const sub = parseNetlist(net('W=1mm S=1mm', 2)).substrate;
  const a = fieldLines({ W: [1e-3, 1e-3, 1e-3, 1e-3], S: [0.2e-3, 0.2e-3, 0.2e-3], sub, f0: 2e9 });
  const t0 = performance.now(), b = fieldLines({ W: [1e-3, 1e-3, 1e-3, 1e-3], S: [0.2e-3, 0.2e-3, 0.2e-3], sub, f0: 2e9 }), dt = performance.now() - t0;
  check('the same geometry is served from the cache', a === b && dt < 1, dt);
}

// ---- Example 7 is regenerated from a real geometry ----
{
  const d = parseNetlist(ex('three-line-CL.cir')), s = d.sections[0];
  const ref = solve(stripsFromWS([0.8e-3, 0.8e-3, 0.8e-3], 0.15e-3), microstrip({ h: 0.508e-3, er: 3.66 }));
  check('Example 7\'s C and L are the solver\'s for 3 × 0.8 mm, 0.15 mm gaps on 0.508 mm RO4350B (8 digits)', s.C.every((r, i) => r.every((v, j) => rel(v, ref.C[i][j]) < 1e-7)) && s.L.every((r, i) => r.every((v, j) => rel(v, ref.L[i][j]) < 1e-7)));
  const g = parseNetlist(ex('three-line-CL.cir').replace(/^\.ref 3G$/m, '.ref 3G\n.substrate jlc-ro4350b-0.508 t=0').replace(/^  C \[.*$/m, '  geom msl\n  W [0.8mm 0.8mm 0.8mm]\n  S 0.15mm').replace(/^  L \[.*\n/m, '')).sections[0];
  check('… and the geometry form gives the same modes', g.epsEff.every((e, i) => rel(e, s.epsEff[i]) < 1e-7));
}

// ---- the optimiser can tune widths of an N-line section ----
{
  let text = `.freq 2.9G 3.1G 3\n.ref 3G\n.substrate jlc-ro4350b-0.508 t=0\n.param wc = 1.4mm tune 0.5mm 1.6mm\nport c_in\nport c_out\nport l_cpl\nport l_iso\nport r_cpl\nport r_iso\ncline TL3\n  geom msl\n  W [0.8mm wc 0.8mm]\n  S 0.15mm\n  len 90deg\n  A l_cpl c_in r_cpl\n  B l_iso c_out r_iso\nend\n.goal db(S11) < -30 2.95G 3.05G\n`;
  const g = optimise(text, { maxiter: 60 }); let st; while (!(st = g.next()).done) { /* run */ }
  const wc = st.value.best.wc;
  check('optimiser tunes the centre width of a 3-line section for a match (wc moves from 1.4 mm towards ~0.8 mm)', wc > 0.6e-3 && wc < 1.0e-3, wc);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
