// Loading capacitors (issue #14).  Run: node tests/capacitors.mjs
import { snapE, smdModel, smdForCeff, padC, printedC, printedSize, printedRange, pickTrimmer, retuneLength, capGeometry, SMD_PACKAGES } from '../js/capacitors.js';
import { realiseCaps } from '../js/synth-caps.js';
import { design } from '../js/synth.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { makeSubstrate } from '../js/substrates.js';
import { capFootprint } from '../js/kicad.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ro508 = makeSubstrate('jlc-ro4350b-0.508'), ro1524 = makeSubstrate('jlc-ro4350b-1.524'), fr4 = makeSubstrate('jlc-fr4-1.6');
const EPS0 = 8.8541878128e-12;

// ---- E series ----
check('E24 snap: 2.4958 pF → 2.4 pF', near(snapE(2.4958e-12) * 1e12, 2.4, 1e-9));
check('E12 snap: 2.4958 pF → 2.7 pF (log-nearest)', near(snapE(2.4958e-12, 'E12') * 1e12, 2.7, 1e-9));
check('E24 snap across a decade: 9.7 pF → 10 pF', near(snapE(9.7e-12) * 1e12, 10, 1e-9));
check('unknown series rejected', throws(() => snapE(1e-12, 'E6'), /E12, E24/));

// ---- SMD model ----
{
  const m = smdModel({ pkg: '0603', C: 2.2e-12, sub: ro508, f: 1e9 });
  const w = 2 * Math.PI * 1e9, Ls = m.esl + m.Lvia;
  check('SMD Ceff = Cpad + C / (1 − ω²(ESL+Lvia)C)', near(m.Ceff, m.Cpad + 2.2e-12 / (1 - w * w * Ls * 2.2e-12), 1e-18));
  check('SMD self-resonance 1/(2π√(LsC))', near(m.srf, 1 / (2 * Math.PI * Math.sqrt(Ls * 2.2e-12)), 1));
  const inv = smdForCeff({ Ceff: m.Ceff, pkg: '0603', sub: ro508, f: 1e9 });
  check('smdForCeff inverts smdModel', near(inv.C, 2.2e-12, 1e-17));
  check('bigger packages have more pad capacitance', SMD_PACKAGES && ['0402', '0603', '0805'].map(p => smdModel({ pkg: p, C: 1e-12, sub: ro508, f: 1e9 }).Cpad).every((c, i, a) => i === 0 || c > a[i - 1]));
  check('unreachable: a pad bigger than the wanted capacitance', /pad alone/.test(smdForCeff({ Ceff: 0.05e-12, pkg: '0805', sub: ro508, f: 1e9 }).why));
}

// ---- printed pads ----
{
  const wide = padC({ W: 20, L: 20, sub: ro508 }), pp = EPS0 * ro508.dielectric.er * 400e-6 / ro508.dielectric.h;
  check('a wide pad is the parallel-plate value plus a few % of fringe', wide > pp && wide < 1.1 * pp, `${wide} vs ${pp}`);
  // fed along one edge: open-end fringing at the far end only (a free pad has it at both ends)
  const lf = printedC({ a: 5, sub: ro508, f: 1e6 }), both = padC({ W: 5, L: 5, sub: ro508 }), none = padC({ W: 5, L: 5 - 2 * 0.2161, sub: ro508 });
  check('printed stub at low frequency lies between the pad without and with both end fringes', lf > none && lf < both, `${none} < ${lf} < ${both}`);
  check('printed capacitance rises toward λ/8 (distributed)', printedC({ a: 15, sub: ro508, f: 1e9 }) > printedC({ a: 15, sub: ro508, f: 1e6 }));
  const z = printedSize({ C: 2.5e-12, sub: ro508, f: 1e9 });
  check('printedSize inverts printedC', near(printedC({ a: z.a, sub: ro508, f: 1e9 }), 2.5e-12, 1e-16));
  const r1 = printedRange({ sub: ro1524, f: 1e9 }), r0 = printedRange({ sub: ro508, f: 1e9 });
  check('thin substrates reach more printed capacitance', r0.Cmax > 2 * r1.Cmax, `${r0.Cmax} ${r1.Cmax}`);
  check('out of reach is reported, with the alternative', /SMD or a thinner substrate/.test(printedSize({ C: 50e-12, sub: fr4, f: 1e9 }).why));
}

// ---- trimmers ----
{
  check('trimmer: narrowest TZC3 covering the value with ±10 %', pickTrimmer(2.5e-12, 1e9).mpn === 'TZC3Z030A110' && pickTrimmer(8e-12, 0.5e9).mpn === 'TZC3R100A110');
  check('trimmer above its published frequency range is flagged', /1 GHz/.test(pickTrimmer(8e-12, 1.5e9).warn || ''));
  check('no trimmer for 40 pF', /no TZC3/.test(pickTrimmer(40e-12, 1e9).why));
}

// ---- re-tuning ----
{
  const th0 = 40 * Math.PI / 180, need = [2e-12, 2.1e-12, 2e-12], act = need.map(c => c * 1.05);
  const r = retuneLength({ theta0: th0, Cneed: need, Cact: act, Ya: 1 / 70, f0: 1e9 });
  check('uniform +5 % capacitance: cot θ scales by 1.05, no residual', near(1 / Math.tan(r.theta), 1.05 / Math.tan(th0), 1e-12) && r.dfRel.every(x => Math.abs(x) < 1e-12));
  check('more capacitance → shorter lines', r.theta < th0);
}

// ---- cap element ----
{
  const net = (t) => `.freq 0.5G 1.5G 3\n.ref 1G\n.substrate jlc-ro4350b-0.508\nport a\ncap C1 a C=2.2p ${t}\n`;
  const y = (d) => { const s = solve(d).S(1, 1), k = 1, g = { re: s.re[k], im: s.im[k] }; const den = (1 + g.re) ** 2 + g.im ** 2; return { re: ((1 - g.re * g.re - g.im * g.im) / den) / 50, im: (-2 * g.im / den) / 50 }; };
  const w = 2 * Math.PI * 1e9;
  check('cap type=ideal: B = ωC', near(y(parseNetlist(net('type=ideal'))).im / w, 2.2e-12, 1e-16));
  const ds = parseNetlist(net('type=smd pkg=0603'));
  check('cap type=smd: B/ω equals the model Ceff', near(y(ds).im / w, ds.caps[0].Ceff, 2e-15), `${y(ds).im / w} vs ${ds.caps[0].Ceff}`);
  const dp = parseNetlist(net('type=printed'));
  check('cap type=printed: sized pad gives the requested C at f', near(y(dp).im / w, 2.2e-12, 2e-15), y(dp).im / w);
  check('cap series=E12 snaps and warns', /snapped to E12 2\.2/.test(parseNetlist(net('type=smd series=E12').replace('2.2p', '2.3p')).warnings.join()));
  check('cap type=trimmer outside its range warns', /outside/.test(parseNetlist(net('type=trimmer mpn=TZC3Z030A110').replace('2.2p', '4p')).warnings.join()));
  check('cap type=smd needs a substrate', throws(() => parseNetlist('.freq 1G 2G 2\nport a\ncap C1 a C=1p type=smd\n'), /\.substrate/));
  check('unknown cap option rejected', throws(() => parseNetlist(net('type=smd wibble=1')), /unknown cap option/));
}

// ---- synthesis realisation ----
{
  const r = design({ structure: 'comb', type: 'chebyshev', n: 5, ripple: 0.0432, f0: 1e9, fbw: 0.06, theta0Deg: 40, Zr: 70, er: 1, R0: 50, refine: true });
  const centre = (text) => { const s = solve(parseNetlist(text)), t = s.S(2, 1); const db = s.freq.map((_, k) => 20 * Math.log10(Math.hypot(t.re[k], t.im[k]))); const pk = Math.max(...db); const ix = db.map((v, k) => (v > pk - 3 ? k : -1)).filter(k => k >= 0); return (s.freq[ix[0]] + s.freq[ix.at(-1)]) / 2; };
  const c0 = centre(r.netlist);
  for (const [tag, cap] of [['SMD 0603 E24', { type: 'smd', pkg: '0603', series: 'E24', substrate: 'jlc-ro4350b-0.508' }], ['SMD 0402 E12', { type: 'smd', pkg: '0402', series: 'E12', substrate: 'jlc-ro4350b-0.508' }], ['printed', { type: 'printed', substrate: 'jlc-ro4350b-0.508' }]]) {
    const o = realiseCaps(r, r.netlist, cap);
    check(`realised ${tag}: centre within 0.5 % of the ideal design`, near(centre(o.text) / c0, 1, 0.005), centre(o.text) / c0);
  }
  const t = realiseCaps(r, r.netlist, { type: 'trimmer', substrate: 'jlc-ro4350b-1.524' });
  check('trimmer realisation: cl sliders span the trimmer range', /\.param cl1 = [\d.]+p tune 1\.4p 3p/.test(t.text));
  check('trimmer realisation, lossless trimmers: centre within 0.5 %', near(centre(t.text.replace(/type=trimmer/g, 'type=trimmer Q=1e6')) / c0, 1, 0.005));
  check('trimmer Q assumption reported with its insertion-loss cost', /insertion loss from capacitor Q = 100/.test(t.text) && t.warnings.some(w => /insertion loss/.test(w)));
  const smd = realiseCaps(r, r.netlist, { type: 'smd', pkg: '0603', series: 'E24', substrate: 'jlc-ro4350b-0.508' });
  check('SMD realisation re-tunes the line length and makes it tunable', /\.param th0 = [\d.]+ tune .*re-tuned from/.test(smd.text));
  const low = design({ structure: 'comb', type: 'chebyshev', n: 3, ripple: 0.1, f0: 0.15e9, fbw: 0.1, theta0Deg: 30, Zr: 50, er: 1, R0: 50, refine: false });
  check('printed at 150 MHz on 1.6 mm FR-4: designer warns it is out of reach', realiseCaps(low, low.netlist, { type: 'printed', substrate: 'jlc-fr4-1.6' }).warnings.some(w => /more than a printed pad/.test(w)));
}

// ---- footprints ----
{
  for (const o of [{ type: 'smd', pkg: '0402' }, { type: 'smd', pkg: '0805' }, { type: 'trimmer' }, { type: 'printed', a: 5 }]) {
    const f = capFootprint(o), pads = (f.text.match(/\(pad "/g) || []).length;
    const want = o.type === 'printed' ? 1 : 3 + 2;              // hot, cold, via land + 2 vias
    check(`${f.name}: ${want} pads, balanced parentheses`, pads === want && [...f.text].reduce((a, c) => a + (c === '(') - (c === ')'), 0) === 0, pads);
  }
  const g = capGeometry({ type: 'smd', pkg: '0603' });
  check('SMD geometry: hot pad starts on the line end; vias lie on the ground land', near(Math.min(...g.hot[0].map(p => p[0])), 0, 1e-12) && g.vias.every(v => v.x > Math.min(...g.cold[1].map(p => p[0])) && v.x < Math.max(...g.cold[1].map(p => p[0]))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
