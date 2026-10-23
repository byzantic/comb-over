// In-context fit (#41): two finger couplers, same layout, n1 and n2 cells, ports on single lines.
// εe, εo de-embedded from the pair (the arms and finger ends cancel); then Ze, Zo, an end network (Ca, Cb, Cm, δ)
// and a common arm-length correction Δa fitted jointly to both couplers' 4-port results.
//   node tools/fingerctxfit.mjs DIR_SHORT DIR_LONG   (fingercoupler.mjs cases; OPENEMS_PYTHON for the Bloch step)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const R = new URL('../', import.meta.url).pathname, py = process.env.OPENEMS_PYTHON || 'python3';
const L = await import(R + 'tools/fingerlib.mjs'), { parseNetlist } = await import(R + 'js/netlist.js');
const { solve } = await import(R + 'js/solver.js'), T = await import(R + 'js/touchstone.js');
const [dS, dL] = process.argv.slice(2), cS = JSON.parse(readFileSync(dS + '/case.json', 'utf8')), cL = JSON.parse(readFileSync(dL + '/case.json', 'utf8'));
const r = spawnSync(py, [R + 'tools/fingerbloch.py', dL + '/f.s4p', dS + '/f.s4p', String(cL.cells - cS.cells), String(cL.p), '1e9', '7e9'], { encoding: 'utf8' });
const bl = JSON.parse(r.stdout), med = (v) => [...v].sort((a, b) => a - b)[v.length >> 1], ee = med(bl.ee), eo = med(bl.eo);
console.log(`Bloch (couplers, ${cL.cells}/${cS.cells} cells): εe ${ee.toFixed(4)} εo ${eo.toFixed(4)} (${bl.f.length} frequencies; spread εe ${Math.min(...bl.ee).toFixed(3)}–${Math.max(...bl.ee).toFixed(3)}, εo ${Math.min(...bl.eo).toFixed(3)}–${Math.max(...bl.eo).toFixed(3)})`);
const F = Float64Array.from({ length: 17 }, (_, k) => (1 + 0.5 * k) * 1e9), m = (x) => x.toPrecision(8);
const cases = [dS, dL].map(d => ({ d, txt: readFileSync(d + '/compare.cir', 'utf8'), em: T.onSweep(T.readTouchstone(readFileSync(d + '/f.s4p', 'utf8'), { nPorts: 4, name: 'f' }), F) }));
const build = (txt, q) => {
  const [C, Lm] = L.clFromModes(q.Ze, q.Zo, ee, eo), len0 = +/^  len (\S+)mm/m.exec(txt)[1];
  let t = txt.replace(/C \[.*\]\n\s*L \[.*\]/, `C [${m(C[0][0])} ${m(C[0][1])}; ${m(C[1][0])} ${m(C[1][1])}]\n  L [${m(Lm[0][0])} ${m(Lm[0][1])}; ${m(Lm[1][0])} ${m(Lm[1][1])}]`)
    .replace(/^  len \S+mm/m, `  len ${(len0 + 2 * q.e.delta).toFixed(6)}mm`)
    .replace(/^(T\w+_f \S+ \S+ W=\S+ len=)(\S+)mm/mg, (_, a, l) => `${a}${(+l + q.da).toFixed(6)}mm`);
  return L.addEnds(parseNetlist(t), ['in_k', 'cpl_k'], ['thru_k', 'iso_k'], q.e);
};
const P = [1, 2, 3, 4].flatMap(i => [1, 2, 3, 4].map(j => [i, j]));
const err1 = (c, q) => { const s = solve(build(c.txt, q), F); let e = 0; for (const [i, j] of P) { const a = s.S(i, j), b = c.em.S(i, j); for (let k = 0; k < F.length; k++) e += (a.re[k] - b.re[k]) ** 2 + (a.im[k] - b.im[k]) ** 2; } return Math.sqrt(e / F.length / P.length); };
const Q = (x) => ({ Ze: Math.exp(x[0]), Zo: Math.exp(x[1]), e: { Ca: x[2] * 1e-15, Cb: x[3] * 1e-15, Cm: x[4] * 1e-15, delta: x[5] * 1e-2 }, da: x[6] * 1e-2 });
const err = (x) => Math.hypot(...cases.map(c => err1(c, Q(x)))) / Math.SQRT2;
const x0 = [Math.log(69.6), Math.log(35.3), 0, 0, 0, 0, 0];
// stage 1: Ze, Zo, Δa only; stage 2: everything
const fixEnds = (y) => [y[0], y[1], 0, 0, 0, 0, y[2]];
let f1 = L.nm((y) => err(fixEnds(y)), [x0[0], x0[1], 0], 400, 0.5);
const q1 = Q(fixEnds(f1.x));
console.log(`no end network: Ze ${q1.Ze.toFixed(2)} Zo ${q1.Zo.toFixed(2)} Δa ${q1.da.toFixed(3)} mm; rms ${f1.v.toFixed(4)} (each ${cases.map(c => err1(c, q1).toFixed(4)).join(', ')})`);
let f = L.nm(err, fixEnds(f1.x), 1200, 1); f = L.nm(err, f.x, 800, 0.2);
const q = Q(f.x);
console.log(`with ends: Ze ${q.Ze.toFixed(2)} Zo ${q.Zo.toFixed(2)} Ca ${(q.e.Ca * 1e15).toFixed(2)} Cb ${(q.e.Cb * 1e15).toFixed(2)} Cm ${(q.e.Cm * 1e15).toFixed(2)} fF δ ${q.e.delta.toFixed(4)} mm Δa ${q.da.toFixed(3)} mm; rms ${f.v.toFixed(4)} (each ${cases.map(c => err1(c, q).toFixed(4)).join(', ')})`);
writeFileSync(dL + '/ctxfit.json', JSON.stringify({ ee, eo, ...q, rms: f.v }));
const db = (x, k) => 20 * Math.log10(Math.hypot(x.re[k], x.im[k]));
for (const c of cases) {
  console.log(c.d.split('/').pop(), '  D / S41 / S11 (dB)');
  for (const [lab, s] of [['openEMS', c.em], ['no ends', solve(build(c.txt, q1), F)], ['with ends', solve(build(c.txt, q), F)]])
    console.log('  ' + lab.padEnd(10), [0, 2, 4, 8, 12, 16].map(k => `${(F[k] / 1e9).toFixed(0)}G ${(db(s.S(3, 1), k) - db(s.S(4, 1), k)).toFixed(1)}/${db(s.S(4, 1), k).toFixed(1)}/${db(s.S(1, 1), k).toFixed(1)}`).join('  '));
}
