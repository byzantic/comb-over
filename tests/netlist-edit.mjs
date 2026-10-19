// Layout panel netlist rewriting (issue #10).  Run: node tests/netlist-edit.mjs
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { buildLayout } from '../js/layout-templates.js';
import { mscoupled } from '../js/microstrip.js';
import { setSubstrate, setLayout, layoutLine, detectLayouts, toMicrostrip, evenOdd } from '../js/netlist-edit.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ex = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const db = (r, i, j, k) => { const s = r.S(i, j); return 20 * Math.log10(Math.hypot(s.re[k], s.im[k])); };

// ---- directives ----
{
  const t = ex('coupler-10dB-microstrip.cir');
  const a = setSubstrate(t, 'jlc-ro4350b-1.524');
  check('setSubstrate inserts after the header (.ref)', /\.ref 5G\n\.substrate jlc-ro4350b-1\.524\n/.test(a));
  const b = setSubstrate(a, 'jlc-fr4-1.6');
  check('setSubstrate replaces an existing line', (b.match(/^\.substrate/gm) || []).length === 1 && /\.substrate jlc-fr4-1\.6/.test(b));
  check('layoutLine: lengths in mm, counts and words as given', layoutLine({ type: 'marchand', sections: ['S1', 'S2'], opts: { pitch: 14, vias: 3, connector: 'none', feed: null } }) === '.layout marchand S1 S2 pitch=14mm vias=3 connector=none');
  const c = setLayout(b, { type: 'coupler', sections: ['K'], opts: { pitch: 12.5 } });
  check('setLayout appends a .layout line', /\n\.layout coupler K pitch=12\.5mm\n$/.test(c));
  const e = setLayout(c, { type: 'coupler', sections: ['K'], opts: {} });
  check('setLayout replaces it', (e.match(/^\.layout/gm) || []).length === 1 && /^\.layout coupler K$/m.test(e));
  check('setLayout(null) removes it', !/^\.layout/m.test(setLayout(e, null)));
  const d = parseNetlist(setLayout(ex('coupler-10dB-ro4350b.cir'), { type: 'coupler', sections: ['K'], opts: { ...parseNetlist(ex('coupler-10dB-ro4350b.cir').replace('.layout coupler K', '.layout coupler K pitch=13mm launch=library')).layout.opts } }));
  check('parser options round-trip through setLayout', near(d.layout.opts.pitch, 13, 1e-9) && d.layout.opts.launch === 'library');
}

// ---- detection ----
{
  const det = (f) => detectLayouts(parseNetlist(ex(f))).map(c => `${c.type}:${c.sections.join(',')}`);
  check('detects the coupler', det('coupler-10dB-microstrip.cir').includes('coupler:K'));
  check('detects the Schiffman (C-section + reference line)', det('schiffman-90.cir').includes('schiffman:CS,Tref'));
  check('detects the Marchand', det('marchand-balun.cir').includes('marchand:S1,S2'));
  check('no layout offered for a filter', det('combline-4pole.cir').length === 0 && det('interdigital-4pole.cir').length === 0);
}

// ---- impedance → microstrip ----
{
  const t0 = setSubstrate(ex('coupler-10dB-microstrip.cir'), 'jlc-ro4350b-1.524');
  const d0 = parseNetlist(t0);
  const eo = evenOdd(d0.sections[0]);
  check('evenOdd recovers Z0e/Z0o from the Maxwell matrices', eo.sym && near(eo.Ze, 69.4, 1e-6) && near(eo.Zo, 36.0, 1e-6), `${eo.Ze} ${eo.Zo}`);
  const r = toMicrostrip(t0, d0, d0.substrate);
  const d1 = parseNetlist(r.text), K = d1.sections[0];
  check('coupler converted to geom=msl, Zeo line removed', r.changed.length === 1 && K.geom?.kind === 'msl2' && !/Zeo/.test(r.text));
  const c = mscoupled({ W: K.geom.W, S: K.geom.S, h: d1.substrate.dielectric.h, t: d1.substrate.copper.t, er: d1.substrate.dielectric.er });
  check('converted W/S give the original Z0e/Z0o (quasi-static, ±0.1 Ω)', near(c.Ze, 69.4, 0.1) && near(c.Zo, 36.0, 0.1), `${c.Ze} ${c.Zo}`);
  check('the length spec and port wiring are kept', /len 90deg/.test(r.text) && /A in\s+cpl/.test(r.text) && /B thru iso/.test(r.text));
  const k = solve(d1).freq.findIndex(f => f >= 5e9);
  check('converted coupler still couples ≈ −10 dB at 5 GHz', near(db(solve(d1), 3, 1, k), -10, 0.6), db(solve(d1), 3, 1, k));
  // Schiffman: the single reference line too
  const ts = setSubstrate(ex('schiffman-90.cir'), 'jlc-ro4350b-1.524'), ds = parseNetlist(ts);
  const rs = toMicrostrip(ts, ds, ds.substrate), d2 = parseNetlist(rs.text);
  check('Schiffman: C-section and reference line converted', rs.changed.map(x => x.name).join() === 'CS,Tref' && d2.sections.every(sc => sc.geom));
  const L2 = buildLayout(parseNetlist(setLayout(rs.text, { type: 'schiffman', sections: ['CS', 'Tref'] })));
  check('Schiffman layout flags its sub-minimum C-section gap (same net)', L2.errors.some(e => e.rule === 'space' && /C-section line/.test(e.msg)));
  // full path for the coupler: detect → convert → layout → DRC clean
  const cand = detectLayouts(d1)[0];
  const L = buildLayout(parseNetlist(setLayout(r.text, cand)));
  check('coupler: detect → convert → layout passes DRC', L.errors.length === 0, JSON.stringify(L.errors));
  // substrate change: keep the impedances, re-synthesise W/S
  const t5 = setSubstrate(r.text, 'jlc-ro4350b-0.508');
  const r5 = toMicrostrip(t5, d1, parseNetlist(t5).substrate, { all: true }), d5 = parseNetlist(r5.text);
  const c5 = mscoupled({ W: d5.sections[0].geom.W, S: d5.sections[0].geom.S, h: d5.substrate.dielectric.h, t: d5.substrate.copper.t, er: d5.substrate.dielectric.er });
  check('substrate change re-synthesises W/S for the same Z0e/Z0o', near(c5.Ze, 69.4, 0.2) && near(c5.Zo, 36.0, 0.2) && d5.sections[0].geom.W < K.geom.W, `${c5.Ze} ${c5.Zo}`);
  check('without all=, physical sections are left alone', toMicrostrip(t5, d1, d5.substrate).changed.length === 0);
  // a 3-line section is not converted
  const r3 = toMicrostrip(ex('three-line-CL.cir'), parseNetlist(ex('three-line-CL.cir')), parseNetlist(t0).substrate);
  check('3-line sections are skipped with a reason', r3.skipped.some(x => /3-line/.test(x.why)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
