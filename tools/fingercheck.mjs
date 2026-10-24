// Finger-loaded coupled lines against openEMS (issue #41, stage 1): extract per-length C and L, then check.
//   node tools/fingercheck.mjs gen DIR [--W 0.6 --G 1 --wf 0.2 --lf 0.7 --p 0.8 --n 12,24 --sub ID --bare --full --fine MM]
//   node tools/fingercheck.mjs run DIR                 run every case without a result (OPENEMS_PYTHON)
//   node tools/fingercheck.mjs fit DIR [--bare]        fit C, L to the shortest case; predict the others
// Each case: the finger-loaded section between plain coupled backbones (the feeds) to four ports:
// p1 / p2 line 1 left / right, p3 / p4 line 2 left / right. Ports 1 and 2 are driven; the pair's 180°
// rotation symmetry gives the rest (--full drives all four).
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { genCase, runCase, model, errOf, modes, fitCase, loadCase } from './fingerlib.mjs';

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };

function gen() {
  const P = { W: +opt('W', 0.6), G: +opt('G', 1), wf: +opt('wf', 0.2), lf: +opt('lf', 0.7), p: +opt('p', 0.8) };
  const bare = rest.includes('--bare');
  for (const n of opt('n', '12,24').split(',').map(Number)) {
    const c = genCase(dir, `${bare ? 'bare' : 'n'}${n}`, P, n, { sub: opt('sub'), bare, full: rest.includes('--full'), fine: opt('fine') != null ? +opt('fine') : undefined });
    console.log(`${bare ? 'bare' : 'n'}${n}`, `${+c.len.toFixed(4)} mm section, ${c.cells} cells; overlap ${+c.overlap.toFixed(4)} mm, side gap ${+c.side.toFixed(4)} mm, tip gap ${+c.tip.toFixed(4)} mm`);
  }
}

function run() {
  for (const name of readdirSync(dir).sort()) {
    const d = join(dir, name);
    if (!existsSync(join(d, 'f.py')) || existsSync(join(d, 'f.s4p'))) continue;
    const r = runCase(d);
    console.log(name, r.ok ? 'ok' : 'FAILED', `${r.s.toFixed(0)} s`);
  }
}

function fit() {
  const names = readdirSync(dir).filter(n => existsSync(join(dir, n, 'f.s4p'))).map(n => ({ name: n, c: loadCase(join(dir, n)).c }))
    .filter(x => !x.c.bare === !rest.includes('--bare')).sort((a, b) => a.c.n - b.c.n);
  if (!names.length) { console.error('no results'); process.exit(2); }
  const R = fitCase(join(dir, names[0].name)), { A, bare } = R;
  const show = (label, C, L, e) => { const m = modes(C, L); console.log(`${label.padEnd(30)} C11 ${(C[0][0] * 1e12).toFixed(2)} C12 ${(C[0][1] * 1e12).toFixed(2)} pF/m  L11 ${(L[0][0] * 1e9).toFixed(1)} L12 ${(L[0][1] * 1e9).toFixed(1)} nH/m | Ze ${m.Ze.toFixed(1)} Zo ${m.Zo.toFixed(1)} Ω, εe ${m.ee.toFixed(3)} εo ${m.eo.toFixed(3)}${e != null ? ` | rms ΔS ${e.toFixed(4)}` : ''}`); };
  show('bare backbones (2-D solver)', bare.C, bare.L, errOf(A.c, A.F, A.em, bare.C, bare.L));
  show(`fit C, L bare (${names[0].name})`, R.fitC.C, R.fitC.L, R.fitC.rms);
  show(`fit C and L (${names[0].name})`, R.C, R.L, R.rms);
  for (let k = 1; k < names.length; k++) {
    const B = loadCase(join(dir, names[k].name));
    console.log(`  predict ${names[k].name} (${+B.c.len.toFixed(4)} mm): bare ${errOf(B.c, B.F, B.em, bare.C, bare.L).toFixed(4)}, fit C ${errOf(B.c, B.F, B.em, R.fitC.C, R.fitC.L).toFixed(4)}, fit C and L ${errOf(B.c, B.F, B.em, R.C, R.L).toFixed(4)} (rms complex ΔS over all 16)`);
    const r = solve(parseNetlist(model(B.c, R.C, R.L)), B.F), db = (x, q) => 20 * Math.log10(Math.hypot(x.re[q], x.im[q]));
    for (const q of [0, 5, 11]) console.log(`    ${(B.F[q] / 1e9).toFixed(2)} GHz  S31 ${db(r.S(3, 1), q).toFixed(2)} | ${db(B.em.S(3, 1), q).toFixed(2)}  S41 ${db(r.S(4, 1), q).toFixed(2)} | ${db(B.em.S(4, 1), q).toFixed(2)}  S21 ${db(r.S(2, 1), q).toFixed(3)} | ${db(B.em.S(2, 1), q).toFixed(3)}  (model | openEMS)`);
  }
  writeFileSync(join(dir, 'fit.json'), JSON.stringify({ bare: { C: bare.C, L: bare.L }, fitC: R.fitC, fitCL: { C: R.C, L: R.L, rms: R.rms } }, null, 1));
}

const fn = { gen, run, fit }[cmd];
if (!fn || !dir) { console.error('usage: node tools/fingercheck.mjs gen|run|fit DIR [options]'); process.exit(2); }
fn();
