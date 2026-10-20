// Edge-coupled and hairpin filters: synthesis, layout, KiCad (issue #38).  Run: node tests/hairpin.mjs
import { readFileSync } from 'node:fs';
import { ecPrototype, realiseEdgeCoupled } from '../js/synth-ec.js';
import { gValues } from '../js/synth.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { buildLayout } from '../js/layout-templates.js';
import { boardProject } from '../js/kicad.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) || (console.log('       ', e.message), false); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const lossless = (t) => t.replace(/^(cline S\d+ geom=msl .*)$/mg, '$1\n  Q 1e30').replace(/^  geom msl$/mg, '  geom msl\n  Q 1e30');
const db = (r, i, j, k) => { const s = r.S(i, j); return 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); };
// −3 dB edges, centre and width of a netlist's lossless response
function shape(text, f0, span) {
  const r = solve(parseNetlist(lossless(text).replace(/^\.freq .*$/m, `.freq ${f0 * (1 - span)} ${f0 * (1 + span)} 2001`))), F = r.freq;
  let k0 = -1, k1 = -1; for (let k = 0; k < F.length; k++) if (db(r, 2, 1, k) > -3) { if (k0 < 0) k0 = k; k1 = k; }
  const fc = Math.sqrt(F[k0] * F[k1]);
  return { fc, bw: (F[k1] - F[k0]) / fc };
}

// ---- inverters (Matthaei, Young & Jones §10.03) ----
{
  const n = 5, D = 0.1, P = ecPrototype({ n, fbw: D, ripple: 0.1 }), g = gValues('chebyshev', n, 0.1);
  check('J01 Z0 = √(πΔ/2g0g1), J12 Z0 = πΔ/(2√(g1g2)), Jn,n+1 by symmetry', near(P.J[0], Math.sqrt(Math.PI * D / (2 * g[0] * g[1])), 1e-15) && near(P.J[1], Math.PI * D / (2 * Math.sqrt(g[1] * g[2])), 1e-15) && near(P.J[5], P.J[0], 1e-12));
  check('Z0e/Z0o = Z0(1 ± JZ0 + J²Z0²); Z0e − Z0o = 2 J Z0²', P.Ze.every((z, k) => near(z - P.Zo[k], 2 * P.J[k] * 50, 1e-9)) && near(P.Ze[0], 50 * (1 + P.J[0] + P.J[0] ** 2), 1e-12));
  check('bad inputs refused', throws(() => ecPrototype({ n: 3, fbw: 0.5 }), /between 0 and 40 %/) && throws(() => ecPrototype({ n: 0, fbw: 0.1 }), /order n/));
}

// ---- edge-coupled on 1.524 mm RO4350B (the example) ----
{
  const t0 = Date.now();
  const g = realiseEdgeCoupled({ type: 'chebyshev', n: 5, ripple: 0.1, f0: 2.4e9, fbw: 0.1 }, { substrate: 'jlc-ro4350b-1.524' });
  const a = g.assess;
  console.log(`       (edge-coupled: ${((Date.now() - t0) / 1000).toFixed(1)} s; ${g.report[2]})`);
  check('edge-coupled: centre within 0.2 %, −3 dB width within −3 % … +3 % of ideal, core RL ≥ ideal − 0.3 dB, no warnings',
    Math.abs(a.fc / 2.4e9 - 1) < 2e-3 && Math.abs(a.bw3 / a.bw3ideal - 1) < 0.03 && a.rlCore >= a.rlTarget - 0.3 && g.warnings.length === 0, JSON.stringify([a, g.warnings]));
  check('edge-coupled: the committed example is this synthesis', g.netlist === ex('edgecoupled-5pole-2g4-ro4350b-1524.cir'));
  const d = parseNetlist(g.netlist);
  check('edge-coupled netlist: 6 coupled-microstrip sections, 12 open-end capacitors, .layout edgecoupled', d.sections.filter(s => s.geom?.kind === 'msl2').length === 6 && (g.netlist.match(/^Coe_/mg) || []).length === 12 && d.layout?.type === 'edgecoupled');
  check('edge-coupled: the spurious passband near 2f0 is reported (microstrip passes there)', g.spurious.f > 1.9 * 2.4e9 && g.spurious.f < 2.2 * 2.4e9 && g.spurious.peak > -3 && /spurious passband near 2f0/.test(g.report.join()));
  // the same inverters in homogeneous TEM: a transmission zero at 2f0
  const P = ecPrototype({ n: 5, fbw: 0.1 }), mid = (j) => (j === 0 ? 'in' : j === 6 ? 'out' : `j${j}`);
  const L = ['.freq 4.8G 4.8G 1', '.ref 2.4G', 'port in', 'port out'];
  for (let k = 0; k <= 5; k++) L.push(`cline S${k}`, `  Zeo ${P.Ze[k]} ${P.Zo[k]}`, '  er 3', '  len 90deg', `  A ${mid(k)} -`, `  B - ${mid(k + 1)}`, 'end');
  check('homogeneous TEM, same inverters: no transmission at 2f0 (< −100 dB)', db(solve(parseNetlist(L.join('\n') + '\n')), 2, 1, 0) < -100);
  // layout
  const Ly = buildLayout(d);
  check('edge-coupled layout: DRC clean, 7 conductors (2 port lines + 5 resonators), no net tie', Ly.errors.length === 0 && Ly.core.pads.length === 7 && Ly.core.ties.length === 0, JSON.stringify(Ly.errors));
  const sd = shape(g.netlist, 2.4e9, 0.3), sb = shape(Ly.netlist, 2.4e9, 0.3);
  check('edge-coupled as built ≈ design (lossless): centre within 0.05 %, −3 dB width within 1.5 %', Math.abs(sb.fc / sd.fc - 1) < 5e-4 && Math.abs(sb.bw / sd.bw - 1) < 0.015, JSON.stringify([sd, sb]));
  check('edge-coupled layout errors: a section not open where it must be', throws(() => buildLayout(parseNetlist(g.netlist.replace(/^  A in o1a$/m, '  A in in'))), /open at B|open|port/));
}

// ---- hairpin (the committed example; the synthesis itself takes about a minute and a half) ----
{
  const text = ex('hairpin-5pole-2g4-ro4350b-1524.cir'), d = parseNetlist(text);
  check('hairpin netlist: 10 arms in one field-solved array, 10 bends (U bottoms), 2 tees, 10 open ends, .layout hairpin',
    d.sections.filter(s => s.geom?.kind === 'mslN').every(s => s.geom.W.length === 10) && d.blocks.filter(b => b.type === 'bend').length === 10 && d.blocks.filter(b => b.type === 'tee').length === 2 && (text.match(/^Coe\d+ /mg) || []).length === 10 && d.layout?.type === 'hairpin');
  const sh = shape(text, 2.4e9, 0.3);
  check(`hairpin (lossless): centre within 0.3 % of 2.4 GHz, −3 dB width within −5 % … +3 % of ideal 11.35 % (${(sh.fc / 1e9).toFixed(5)} GHz, ${(sh.bw * 100).toFixed(3)} %)`, Math.abs(sh.fc / 2.4e9 - 1) < 3e-3 && sh.bw / 0.11347 > 0.95 && sh.bw / 0.11347 < 1.03);
  const Ly = buildLayout(d);
  check('hairpin layout: DRC clean; 5 conductors, the tapped ones on the port nets, no net tie', Ly.errors.length === 0 && new Set(Ly.core.pads.map(p => p.node)).size === 5 && Ly.core.pads.filter(p => /^t\d$/.test(p.node)).length === 4 && Ly.core.ties.length === 0, JSON.stringify(Ly.errors));
  const bottoms = Ly.items.filter(i => /hairpin \d bottom/.test(i.label ?? ''));
  // simple polygons (KiCad needs each custom pad to resolve to one polygon): no two non-adjacent edges cross
  const simple = (P) => { const n = P.length, X = (a, b, c, d) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0; }; for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) { if (i === 0 && j === n - 1) continue; if (X(P[i], P[(i + 1) % n], P[j], P[(j + 1) % n])) return false; } return true; };
  const arms = Ly.items.filter(i => /^resonator \d+$/.test(i.label ?? ''));
  check('hairpin layout: 5 U bottoms with chamfered outer corners; bottoms and arms are simple polygons (one KiCad pad shape each)', bottoms.length === 5 && bottoms.every(b => b.pts.length >= 4 && b.pts.length <= 6 && simple(b.pts)) && arms.every(a => simple(a.pts)));
  check('hairpin layout: at W/h ≈ 2.4 the optimum mitre (c = 2MW > W) carries on into the arms\' outer end corners', arms.filter(a => a.pts.length === 5).length === 10);
  const sb = shape(Ly.netlist, 2.4e9, 0.3);
  check('hairpin as built ≈ design (lossless): centre within 0.05 %, −3 dB width within 1 %', Math.abs(sb.fc / sh.fc - 1) < 5e-4 && Math.abs(sb.bw / sh.bw - 1) < 0.01, JSON.stringify([sh, sb]));
  check('hairpin layout errors: U bottoms not flipped between neighbours', throws(() => {
    // hairpin 2 the same way round as hairpin 1: its arms' array ends swapped (open ↔ U bottom)
    const t2 = text.replace(/^(  A u1a u1b) o3 o4 /m, '$1 u2a u2b ').replace(/^(  B .*) u2a u2b (.*)$/m, '$1 o3 o4 $2');
    if (t2 === text) throw new Error('test construction failed');
    buildLayout(parseNetlist(t2));
  }, /flipped/));
  check('hairpin layout errors: a U bottom line that does not match the arm spacing', throws(() => buildLayout(parseNetlist(text.replace(/^(T1_u v1a v1b W=w1 len=)g1$/m, '$1g1*1.2'))), /arms are [\d.]+ mm apart/));
  // KiCad
  const b = boardProject(Ly, { source: text, date: '2026-01-01' }), pcb = b.board;
  check('hairpin board: nets t1, t5, h2…h4; no net-tie group in the part; a fence ring of vias', ['t1', 't5', 'h2', 'h3', 'h4'].every(n => pcb.includes(`(net_name "${n}")`) || pcb.includes(`"${n}")`)) && !/net_tie_pad_groups/.test(Object.values(b.files).join()) && (pcb.match(/\n\t\(via\n/g) || []).length >= 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
