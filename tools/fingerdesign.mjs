// Finger-loaded coupler design against openEMS (issue #41, stage 2): find backbone width W, gap G and finger
// length lf for target even/odd impedances with equal even/odd velocity (wf and pitch p fixed).
//   node tools/fingerdesign.mjs DIR [--tip 0.09] [--C 10 --Z0 50 --W 0.9 --G 0.3 --lf 0.2 --wf 0.2 --p 0.8 --n 8 --n2 14 --sub ID --min 0.1 --iters 12]
// Each evaluation is two openEMS extractions, n and n2 cells (ports 1 and 2 driven), cached in DIR by geometry:
// εe, εo de-embedded from the pair (fingerlib bloch: the ends cancel), then Ze, Zo fitted with those held. A per-length
// C, L fitted to one short section alone takes up the finger ends' discontinuities and misplaces the velocities
// (at 8 cells it reported equal velocities for a section whose de-embedded εo/εe is 1.07). Search: Newton with one finite-difference Jacobian, then Broyden updates; steps limited to
// 0.1 mm and projected onto the fabrication limits (finger tip ≥ min from the other backbone, side gap ≥ min,
// intermesh overlap kept off zero, where the finger tips share a mesh line).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { genCase, runCase, bloch, fitZ } from './fingerlib.mjs';

const [dir, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? +rest[i + 1] : d; };
if (!dir) { console.error('usage: node tools/fingerdesign.mjs DIR [options]'); process.exit(2); }
const sub = rest.includes('--sub') ? rest[rest.indexOf('--sub') + 1] : undefined;
const Cdb = opt('C', 10), Z0 = opt('Z0', 50), k = 10 ** (-Cdb / 20), wf = opt('wf', 0.2), p = opt('p', 0.8), n = opt('n', 8), n2 = opt('n2', 14), mn = opt('min', 0.1);
const ZeT = Z0 * Math.sqrt((1 + k) / (1 - k)), ZoT = Z0 * Math.sqrt((1 - k) / (1 + k));
mkdirSync(dir, { recursive: true });
const logf = join(dir, 'design-bloch.json'), hist = existsSync(logf) ? JSON.parse(readFileSync(logf, 'utf8')) : [];
const r4 = (x) => +x.toFixed(4);

// keep the geometry buildable: tip ≥ mn, |overlap| ≥ 0.03, W ≥ mn, G ≥ 2 mn
// --tip T: the finger tip held T from the other backbone (lf = G − T) and the pitch searched instead: x = [W, G, p]
const tip = rest.includes('--tip') ? opt('tip') : null;
// the intermesh overlap is kept ≥ 2 mesh cells (≈ 2·tip/3): at one cell the finger tips' mesh lines merge and εo jumps
const ovMin = opt('ovmin', tip != null ? 2 * Math.min(wf, tip, mn) / 3 : 0.03);
const geom = (x) => tip != null ? { W: x[0], G: x[1], lf: r4(x[1] - tip), p: x[2] } : { W: x[0], G: x[1], lf: x[2], p };
function project(x) {
  if (tip != null) { let [W, G, pp] = x; W = Math.max(W, mn); G = Math.max(G, 2 * tip + ovMin); pp = Math.max(pp, 2 * (wf + mn)); return [r4(W), r4(G), r4(pp)]; }
  let [W, G, lf] = x;
  W = Math.max(W, mn); G = Math.max(G, 2 * mn); lf = Math.min(Math.max(lf, 0.02), G - mn);
  if (Math.abs(2 * lf - G) < 0.03) lf = 2 * lf - G >= 0 ? (G + 0.03) / 2 : (G - 0.03) / 2;
  if (lf > G - mn) lf = (G - 0.03) / 2;
  return [r4(W), r4(G), r4(lf)];
}
function evaluate(x) {
  const { W, G, lf, p } = geom(x), name = `W${W}_G${G}_lf${lf}${tip != null || p !== opt('p', 0.8) ? `_p${p}` : ''}`, d = join(dir, name);
  const hit = hist.find(h => h.name === name); if (hit) return hit;
  const d2 = join(dir, `${name}_n${n2}`);
  for (const [nn, dd, nm] of [[n, d, name], [n2, d2, `${name}_n${n2}`]]) if (!existsSync(join(dd, 'f.s4p'))) {
    genCase(dir, nm, { W, G, wf, lf, p }, nn, { sub });
    const r = runCase(dd); if (!r.ok) throw new Error(`openEMS failed for ${nm} (see ${dd}/run.log)`);
    console.log(`  ${nm}: openEMS ${r.s.toFixed(0)} s`);
  }
  const b = bloch(d2, d), f = fitZ(d2, b.ee, b.eo), m = f;
  const res = [Math.log(m.Ze / ZeT), Math.log(m.Zo / ZoT), Math.log(m.eo / m.ee)];
  const h = { name, x, Ze: m.Ze, Zo: m.Zo, ee: m.ee, eo: m.eo, rms: f.rms, C: f.C, L: f.L, res };
  hist.push(h); writeFileSync(logf, JSON.stringify(hist, null, 1));
  console.log(`  ${name}: Ze ${m.Ze.toFixed(2)} Zo ${m.Zo.toFixed(2)} Ω (targets ${ZeT.toFixed(2)}, ${ZoT.toFixed(2)}), εe ${m.ee.toFixed(3)} εo ${m.eo.toFixed(3)}, fit rms ${f.rms.toFixed(4)} | residual ${res.map(v => (100 * v).toFixed(2) + ' %').join(' ')}`);
  return h;
}
const norm = (r) => Math.max(...r.map(Math.abs));
// 3×3 solve (Gaussian elimination, partial pivoting)
function lin(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) { const piv = [c, c + 1, c + 2].filter(i => i < 3).reduce((a, i) => Math.abs(M[i][c]) > Math.abs(M[a][c]) ? i : a, c); [M[c], M[piv]] = [M[piv], M[c]];
    for (let i = c + 1; i < 3; i++) { const f = M[i][c] / M[c][c]; for (let j = c; j < 4; j++) M[i][j] -= f * M[c][j]; } }
  const x = [0, 0, 0]; for (let i = 2; i >= 0; i--) x[i] = (M[i][3] - M[i].slice(i + 1, 3).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / M[i][i];
  return x;
}

console.log(`target: ${Cdb} dB, ${Z0} Ω → Ze ${ZeT.toFixed(2)} Ω, Zo ${ZoT.toFixed(2)} Ω, εo = εe; wf ${wf} mm, p ${p} mm, ${n} cells`);
let x = project(tip != null ? [opt('W', 0.8), opt('G', 0.4), p] : [opt('W', 0.9), opt('G', 0.3), opt('lf', 0.2)]), h = evaluate(x);
// finite-difference Jacobian (forward steps, chosen inside the limits)
const steps = tip != null ? [0.05, 0.04, 0.06] : [0.05, 0.04, 0.03];
let J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (let j = 0; j < 3; j++) {
  // forward step, or backward if a limit blocks it (the start may sit on one)
  let xs = [...x]; xs[j] += steps[j]; let xp = project(xs);
  if (Math.abs(xp[j] - x[j]) < steps[j] / 2) { xs = [...x]; xs[j] -= steps[j]; xp = project(xs); }
  const dx = xp[j] - x[j]; if (Math.abs(dx) < 1e-4) throw new Error(`no room to step variable ${j} from ${x}`);
  const hj = evaluate(xp); for (let i = 0; i < 3; i++) J[i][j] = (hj.res[i] - h.res[i]) / dx;
}
for (let it = 0; it < opt('iters', 12) && norm(h.res) > 0.005; it++) {
  let dx = lin(J, h.res.map(v => -v));
  const s = Math.min(1, 0.1 / Math.max(...dx.map(Math.abs))); dx = dx.map(v => v * s);
  const xn = project(x.map((v, j) => v + dx[j])), hn = evaluate(xn);
  const d = xn.map((v, j) => v - x[j]), dd = d.reduce((a, v) => a + v * v, 0);
  if (dd > 0) { const y = hn.res.map((v, i) => v - h.res[i]), Jd = J.map(row => row.reduce((a, v, j) => a + v * d[j], 0)); J = J.map((row, i) => row.map((v, j) => v + (y[i] - Jd[i]) * d[j] / dd)); }
  if (norm(hn.res) < norm(h.res) || it === 0) { x = xn; h = hn; } else if (dd === 0) break;
}
const gb = geom(x);
console.log(`\nbest: W ${gb.W} G ${gb.G} lf ${gb.lf} p ${gb.p} mm (wf ${wf}): Ze ${h.Ze.toFixed(2)} Zo ${h.Zo.toFixed(2)} Ω, εe ${h.ee.toFixed(3)} εo ${h.eo.toFixed(3)}; worst residual ${(100 * norm(h.res)).toFixed(2)} %`);
