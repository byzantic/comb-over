// Substrate model tests.  Run: node tests/substrates.mjs
import { PRESETS, makeSubstrate, toDirective, scopeOf, validate } from '../js/substrates.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const near = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.abs(b);
const BASE = '.freq 1G 2G 3\nport a\nport b\nT1 a b Z0=50 len=90deg\n';

// ---- presets ----
check('preset ids are unique', new Set(PRESETS.map(p => p.id)).size === PRESETS.length);
check('every preset validates', PRESETS.every(p => { try { return validate(p); } catch { return false; } }));
check('every preset cites at least one source with an access date', PRESETS.every(p => p.sources.length && p.sources.every(s => /^https:\/\//.test(s.url) && s.accessed)));
check('preset families present (FR-4 ×7, RO4350B ×3, PTFE ×8)',
  PRESETS.filter(p => p.id.startsWith('jlc-fr4-')).length === 7 &&
  PRESETS.filter(p => p.id.startsWith('jlc-ro4350b-')).length === 3 &&
  PRESETS.filter(p => /^jlc-zyf/.test(p.id)).length === 8);
{
  const ro = makeSubstrate('jlc-ro4350b-0.508');
  check('RO4350B uses design Dk 3.66, Df 0.0037, core 0.508 mm', ro.dielectric.er === 3.66 && ro.dielectric.tand === 0.0037 && near(ro.dielectric.h, 0.508e-3));
  const fr = makeSubstrate('JLC-FR4-1.6');
  check('lookup is case-insensitive; FR-4 εr 4.5, h = 1.6 mm − 2 oz', fr.dielectric.er === 4.5 && near(fr.dielectric.h, 1.6e-3 - 2 * 34.79e-6));
  check('FR-4 loss tangent is flagged as an assumption', fr.assumptions.some(a => /loss tangent/.test(a)));
}

// ---- overrides / custom / errors ----
{
  const s = makeSubstrate('jlc-fr4-1.6', { er: 4.3, t: 70e-6 });
  check('overrides apply and are named', s.dielectric.er === 4.3 && s.copper.t === 70e-6 && /modified: er, t/.test(s.name));
  check('presets are not mutated by overrides', makeSubstrate('jlc-fr4-1.6').dielectric.er === 4.5);
  check('custom requires h and er', throws(() => makeSubstrate('custom', { er: 3 }), /needs h=/));
  check('unknown preset suggests alternatives', throws(() => makeSubstrate('jlc-ro4350b-0.5'), /did you mean .*jlc-ro4350b-0\.508/));
  check('unknown key rejected', throws(() => makeSubstrate('jlc-fr4-1.6', { epsilon: 4 }), /unknown substrate key/));
  check('implausible thickness (unit slip) rejected', throws(() => makeSubstrate('custom', { h: 1.6, er: 4 }), /use a unit/));
}

// ---- netlist integration and round trip ----
{
  const d = parseNetlist('.substrate custom h=0.508mm er=3.66 tand=0.0037 t=35u\n.param w = sub_h*2\n' + BASE);
  check('custom substrate parsed from netlist', near(d.substrate.dielectric.h, 0.508e-3) && d.substrate.dielectric.er === 3.66);
  check('sub_* names available to later .params', near(d.scope.w, 1.016e-3) && near(d.scope.sub_t, 35e-6));
  const again = parseNetlist(toDirective(d.substrate) + '\n' + BASE).substrate;
  check('custom substrate round-trips through toDirective', ['h', 'er', 'tand', 'fTand'].every(k => near(again.dielectric[k], d.substrate.dielectric[k])) && near(again.copper.t, d.substrate.copper.t));

  const p = parseNetlist('.param erx = 3.5\n.substrate jlc-ro4350b-0.762 er=erx t=18u\n' + BASE);
  const p2 = parseNetlist(toDirective(p.substrate) + '\n' + BASE).substrate;
  check('preset with overrides round-trips', p2.id === 'jlc-ro4350b-0.762' && p2.dielectric.er === 3.5 && near(p2.copper.t, 18e-6));
  check('override may reference an earlier .param', p.substrate.dielectric.er === 3.5);
  check('slider overrides propagate into the substrate', parseNetlist('.param erx = 3.5 tune 3 4\n.substrate jlc-ro4350b-0.762 er=erx\n' + BASE, { erx: 3.7 }).substrate.dielectric.er === 3.7);

  check('second .substrate is an error', throws(() => parseNetlist('.substrate jlc-fr4-1.6\n.substrate jlc-fr4-0.8\n' + BASE), /only one/));
  check('bad key reports its line', throws(() => parseNetlist(BASE + '.substrate jlc-fr4-1.6 eps=4\n'), /line 5: unknown substrate key/));
  check('netlists without .substrate are unaffected', parseNetlist(BASE).substrate === undefined && solve(parseNetlist(BASE)).failures === 0);
  check('scopeOf exposes h, er, tand, t, sigma', Object.keys(scopeOf(makeSubstrate('jlc-fr4-1.6'))).join() === 'sub_h,sub_er,sub_tand,sub_t,sub_sigma');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
