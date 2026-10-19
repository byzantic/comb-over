// Microstrip T-junction (Hammerstad, as in Qucs; issue #15).  Run: node tests/tee.mjs
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { teeParams, teeY } from '../js/tee.js';
import { msline } from '../js/microstrip.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const net = (wa, wb, w2, f = '10M 10G 21') => `.freq ${f}\n.substrate jlc-ro4350b-0.762\nport a\nport b\nport c\ntee T1 a b c Wa=${wa} Wb=${wb} W2=${w2}\n`;
const sweep = (t) => { const r = solve(parseNetlist(t)); return { r, S: (i, j, k) => { const x = r.S(i, j); return [x.re[k], x.im[k]]; } }; };

{
  const { r, S } = sweep(net('1.7mm', '1.7mm', '1.7mm'));
  let worst = 0, recip = 0;
  for (let k = 0; k < r.freq.length; k++) {
    for (let j = 1; j <= 3; j++) { let p = 0; for (let i = 1; i <= 3; i++) p += Math.hypot(...S(i, j, k)) ** 2; worst = Math.max(worst, Math.abs(p - 1)); }
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) recip = Math.max(recip, Math.hypot(S(i, j, k)[0] - S(j, i, k)[0], S(i, j, k)[1] - S(j, i, k)[1]));
  }
  check('lossless: every column of S has unit power, 10 MHz–10 GHz', worst < 1e-9, worst);
  check('reciprocal: S = Sᵀ', recip < 1e-12, recip);
  const [s11r, s11i] = S(1, 1, 0), [s21r] = S(2, 1, 0), [s31r] = S(3, 1, 0);
  check('low-frequency limit is the ideal three-way junction (S11 = −1/3, S21 = S31 = 2/3)', near(s11r, -1 / 3, 2e-3) && near(s11i, 0, 3e-3) && near(s21r, 2 / 3, 2e-3) && near(s31r, 2 / 3, 2e-3), `${s11r} ${s21r} ${s31r}`);
  const [r11, i11] = S(1, 1, 20);
  check('the junction departs from ideal at 10 GHz (|S11| or phase moves)', Math.abs(Math.hypot(r11, i11) - 1 / 3) > 1e-3 || Math.abs(Math.atan2(i11, r11) - Math.PI) > 0.05);
}
{
  // the published model, evaluated by hand for a symmetric 50 Ω tee at 2 GHz
  const p = teeParams({ Wa: 1.7e-3, Wb: 1.7e-3, W2: 1.7e-3, h: 0.762e-3, er: 3.66, t: 34.79e-6, f: 2e9 });
  const l = msline({ W: 1.7e-3, h: 0.762e-3, er: 3.66, t: 34.79e-6, f: 2e9 });
  const D = 376.730313668 / l.Z0 * 0.762e-3 / Math.sqrt(l.epsEff), fp = 0.4e6 * l.Z0 / 0.762e-3;
  const dd = 0.055 * D * (1 - 2 * (2e9 / fp) ** 2), d2 = D * (0.5 - (0.05 + 0.7 * Math.exp(-1.6) + 0.25 * (2e9 / fp) ** 2));
  check('Hammerstad quantities: D, f_p, d_a, d2 match a hand evaluation of the equations', near(p.Da, D, 1e-12) && near(p.fpa, fp, 1) && near(p.da, dd, 1e-12) && near(p.d2, d2, 1e-12));
  check('main-arm lines are W2/2 − d, the side-arm line max(Wa,Wb)/2 − d2 (negative here, as Qucs notes)', near(p.La, 0.85e-3 - dd, 1e-12) && near(p.L2, 0.85e-3 - d2, 1e-12) && p.L2 < 0);
  check('transformer ratios slightly below 1 well under the higher-order-mode cut-off', p.Ta2 < 1 && p.Ta2 > 0.99);
}
{
  // a wide main line and a narrow side arm: still lossless and reciprocal, and the stamp is symmetric
  const { r, S } = sweep(net('3mm', '3mm', '0.6mm', '1G 6G 6'));
  let worst = 0;
  for (let k = 0; k < r.freq.length; k++) for (let j = 1; j <= 3; j++) { let p = 0; for (let i = 1; i <= 3; i++) p += Math.hypot(...S(i, j, k)) ** 2; worst = Math.max(worst, Math.abs(p - 1)); }
  check('unequal arms (3 mm main, 0.6 mm side): lossless', worst < 1e-9, worst);
  const y = teeY({ Wa: 3e-3, Wb: 2e-3, W2: 0.6e-3, h: 0.762e-3, er: 3.66, t: 0 }, 3e9);
  let asym = 0; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) asym = Math.max(asym, Math.abs(y.im[i * 4 + j] - y.im[j * 4 + i]));
  check('admittance stamp (with the internal junction node) is symmetric', asym < 1e-12, asym);
}
{
  check('tee needs a substrate', throws(() => parseNetlist(`.freq 1G 2G 3\nport a\nport b\nport c\ntee T a b c Wa=1mm Wb=1mm W2=1mm\n`), /needs a \.substrate/));
  check('tee needs three nodes and the widths', throws(() => parseNetlist(net('1mm', '1mm', '1mm').replace('tee T1 a b c', 'tee T1 a b')), /three nodes/) && throws(() => parseNetlist(net('1mm', '1mm', '1mm').replace(' W2=1mm', '')), /W2/));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
