// Discontinuity models (issue #5).  Run: node tests/discontinuities.mjs
import { readFileSync } from 'node:fs';
import { openEnd, viaL } from '../js/discontinuities.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { buildLayout } from '../js/layout-templates.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');

// ---- open end ----
{
  // Kirschning–Jansen–Koster against Hammerstad's older formula: close for moderate W/h
  const cases = [[1, 9.9], [0.94, 9.8], [1.88, 4.5], [2.11, 3.66], [0.5, 2.2], [3, 10.2]];
  const dev = cases.map(([u, er]) => { const o = openEnd({ W: u * 1e-3, h: 1e-3, er }); return Math.abs(o.dl / o.dlH - 1); });
  check('open end: KJK within 5 % of Hammerstad for 0.5 ≤ W/h ≤ 3', dev.every(x => x < 0.05), dev.map(x => x.toFixed(3)).join(' '));
  const o = openEnd({ W: 1e-3, h: 1e-3, er: 9.9 });
  check('open end, W/h = 1 on εr 9.9: Δl/h ≈ 0.317 (regression)', near(o.dl / 1e-3, 0.3170, 5e-4), o.dl / 1e-3);
  const a = openEnd({ W: 0.5e-3, h: 1e-3, er: 3.66 }).dl, b = openEnd({ W: 2e-3, h: 1e-3, er: 3.66 }).dl;
  check('open end grows with W/h', b > a);
  check('open end scales with h at fixed W/h', near(openEnd({ W: 2e-3, h: 2e-3, er: 4 }).dl, 2 * openEnd({ W: 1e-3, h: 1e-3, er: 4 }).dl, 1e-12));
  check('open end warns outside 0.01 ≤ W/h ≤ 100', openEnd({ W: 0.005e-3, h: 1e-3, er: 4 }).warnings.length === 1);
}

// ---- via ----
{
  const v = viaL({ d: 0.3e-3, h: 0.508e-3 });
  check('via 0.3 mm through 0.508 mm: L ≈ 82.6 pH (regression)', near(v.L * 1e12, 82.6, 0.1), v.L * 1e12);
  check('via inductance grows with h and falls with d', viaL({ d: 0.3e-3, h: 1.524e-3 }).L > v.L && viaL({ d: 0.6e-3, h: 0.508e-3 }).L < v.L);
  check('n vias in parallel: L/n (mutual coupling neglected)', near(viaL({ d: 0.3e-3, h: 0.508e-3, n: 3 }).L, v.L / 3, 1e-18));
  // for h ≫ r the Goldfarb–Pucel expression tends to (μ0 h / 2π)(ln(2h/r) − 1.5)
  const h = 10e-3, r = 0.01e-3, Lthin = 2e-7 * h * (Math.log(2 * h / r) - 1.5);
  check('via formula has the expected h ≫ d limit', near(viaL({ d: 2 * r, h }).L / Lthin, 1, 1e-3), viaL({ d: 2 * r, h }).L / Lthin);
  check('via rejects d ≤ 0', throws(() => viaL({ d: 0, h: 1e-3 }), /d and h/));
}

// ---- via netlist element ----
{
  const d = parseNetlist('.freq 1G 3G 3\n.substrate jlc-ro4350b-0.508\nport a\nvia V1 a d=0.3mm n=2\n');
  const e = d.elements[0];
  check('via element: inductor to ground with L/n, h from the .substrate', e.type === 'L' && e.b === '0' && near(e.value, viaL({ d: 0.3e-3, h: 0.508e-3, n: 2 }).L, 1e-18));
  const r = solve(d), k = 1, w = 2 * Math.PI * r.freq[k], z = { re: 0, im: w * e.value };
  const s = r.S(1, 1), g = [(z.re - 50), z.im], den = [(z.re + 50), z.im];
  const gam = [(g[0] * den[0] + g[1] * den[1]) / (den[0] ** 2 + den[1] ** 2), (g[1] * den[0] - g[0] * den[1]) / (den[0] ** 2 + den[1] ** 2)];
  check('a via at a port: S11 = (jωL − 50)/(jωL + 50)', near(s.re[k], gam[0], 1e-9) && near(s.im[k], gam[1], 1e-9));
  check('via needs d=', throws(() => parseNetlist('.substrate jlc-ro4350b-0.508\nport a\nvia V1 a n=2\n'), /d=/));
  check('via needs h= without a .substrate', throws(() => parseNetlist('port a\nvia V1 a d=0.3mm\n'), /h=/));
  check('via h= overrides the substrate', near(parseNetlist('.freq 1G 2G 2\n.substrate jlc-ro4350b-0.508\nport a\nvia V1 a d=0.3mm h=1.6mm\n').elements[0].value, viaL({ d: 0.3e-3, h: 1.6e-3 }).L, 1e-18));
}

// ---- templates ----
{
  const d = parseNetlist(ex('marchand-ro4350b.cir'));
  const L = buildLayout(d), ab = parseNetlist(L.netlist), core = parseNetlist(L.core.netlist);
  for (const [tag, n] of [['as-built', ab], ['core', core]]) {
    const vias = n.elements.filter(e => e.via);
    check(`Marchand ${tag}: grounded ends through 2 × 2 vias, not ideal shorts`, vias.length === 2 && vias.every(v => v.via.n === 2 && near(v.via.d, 0.3e-3, 1e-12)));
    check(`Marchand ${tag}: main-line open end has its Δl extension`, n.sections.some(sc => sc.name === 'Tmain_oe'));
  }
  const r = solve(ab), k = r.freq.findIndex(f => f >= 1e9);
  const s21 = r.S(2, 1), s31 = r.S(3, 1), ph = (Math.atan2(s21.im[k], s21.re[k]) - Math.atan2(s31.im[k], s31.re[k])) * 180 / Math.PI;
  check('Marchand as built still balanced: outputs ≈ 180° apart at f0 (±15°)', Math.abs(Math.abs(((ph % 360) + 540) % 360 - 180) - 180) < 15, ph);
  const c = buildLayout(parseNetlist(ex('coupler-10dB-ro4350b.cir')));
  check('SMA launch placeholder: sma_l/sma_c parameters and an L/C per port', /\.param sma_l = 1p tune 1p 2n/.test(c.netlist) && (c.netlist.match(/^L\w+_sma /gm) || []).length === 4 && (c.netlist.match(/^C\w+_sma /gm) || []).length === 4);
  const big = parseNetlist(c.netlist.replace('.param sma_l = 1p', '.param sma_l = 0.5n').replace('.param sma_c = 1f', '.param sma_c = 0.2p'));
  const r0 = solve(parseNetlist(c.netlist)), r1 = solve(big), k5 = r0.freq.findIndex(f => f >= 5e9);
  const db = (r, i, j) => { const s = r.S(i, j); return 20 * Math.log10(Math.hypot(s.re[k5], s.im[k5])); };
  check('placeholder defaults are negligible; larger values change the match', Math.abs(db(r0, 1, 1) - db(r1, 1, 1)) > 3, `${db(r0, 1, 1)} vs ${db(r1, 1, 1)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
