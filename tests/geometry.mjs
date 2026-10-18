// Physical-geometry netlist elements (issue #4).  Run: node tests/geometry.mjs
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { optimise, writeBack } from '../js/optimize.js';
import { msline, mscoupled, mslineLoss, mscoupledLoss, synthMsline, fromSubstrate } from '../js/microstrip.js';
import { makeSubstrate } from '../js/substrates.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const rel = (a, b) => Math.abs(a / b - 1);
const maxDiff = (r1, r2) => { let m = 0; for (let k = 0; k < r1.Sre.length; k++) m = Math.max(m, Math.hypot(r1.Sre[k] - r2.Sre[k], r1.Sim[k] - r2.Sim[k])); return m; };

const SUB = 'jlc-ro4350b-0.508';
const g = fromSubstrate(makeSubstrate(SUB));
const F0 = 5e9;

// ---- coupled pair: geometry form == electrical form with the same model values (lossless) ----
{
  const W = 0.883e-3, S = 0.1025e-3;
  const c = mscoupled({ W, S, ...g, f: F0 });
  const head = `.freq 1G 9G 81\n.ref 5G\n.substrate ${SUB}\nport in\nport thru\nport cpl\nport iso\n`;
  const phys = parseNetlist(head + `cline K geom=msl W=0.883mm S=0.1025mm Q=1e30\n  len 90deg\n  A in cpl\n  B thru iso\nend\n`);
  const elec = parseNetlist(head + `cline K\n  Zeo ${c.Ze} ${c.Zo} ${c.epse} ${c.epso}\n  len 90deg\n  A in cpl\n  B thru iso\nend\n`);
  check('physical coupled section == Zeo section built from the same model values', maxDiff(solve(phys), solve(elec)) < 1e-12);
  const qw = 299792458 / (4 * F0) / ((Math.sqrt(c.epse) + Math.sqrt(c.epso)) / 2);
  check('section length is a quarter wave at the mean modal velocity (≈ 9.04 mm)', rel(phys.sections[0].len, qw) < 1e-12 && Math.abs(qw - 9.04e-3) < 0.01e-3, phys.sections[0].len);
  const block = parseNetlist(head + `cline K Q=1e30\n  geom msl\n  W 0.883mm\n  S 0.1025mm\n  len 90deg\n  A in cpl\n  B thru iso\nend\n`);
  check('block keywords (geom / W / S) are equivalent to the inline form', maxDiff(solve(block), solve(phys)) < 1e-15);
  const implicit = parseNetlist(head + `cline K W=0.883mm S=0.1025mm Q=1e30\n  len 90deg\n  A in cpl\n  B thru iso\nend\n`);
  check('geom defaults to coupled microstrip when W and S are given', maxDiff(solve(implicit), solve(phys)) < 1e-15);
}

// ---- single line: geometry form == electrical form; default loss from the substrate ----
{
  const W = synthMsline({ Z0: 50, ...g }).W;
  const l = msline({ W, ...g, f: F0 });
  const head = `.freq 4G 6G 3\n.ref 5G\n.substrate ${SUB}\n.param w = ${W}\n`;
  const phys = parseNetlist(head + `port a ${l.Z0}\nport b ${l.Z0}\nT1 a b W=w len=30mm Q=1e30\n`);
  const elec = parseNetlist(head + `port a ${l.Z0}\nport b ${l.Z0}\nT1 a b Z0=${l.Z0} er=${l.epsEff} len=30mm Q=1e30\n`);
  check('physical T line == Z0/er T line built from the same model values', maxDiff(solve(phys), solve(elec)) < 1e-12);
  const lossy = solve(parseNetlist(head + `port a ${l.Z0}\nport b ${l.Z0}\nT1 a b W=w len=30mm\n`));
  const a = mslineLoss({ W, ...g, f: F0 }).alpha;
  const s21 = Math.hypot(lossy.S(2, 1).re[1], lossy.S(2, 1).im[1]);
  check('physical T line includes substrate loss by default: |S21| = exp(−α ℓ) at f0', rel(s21, Math.exp(-a * 0.03)) < 1e-6, `${s21} vs ${Math.exp(-a * 0.03)}`);
  const d = parseNetlist(head + `port a\nport b\nT1 a b W=w len=30mm\n`);
  check('section reports its geometry, Z0 and Q', rel(d.sections[0].geom.Z0, l.Z0) < 1e-12 && d.sections[0].geom.Q > 50 && d.sections[0].geom.W === W);
}

// ---- coupled pair: per-mode Q ----
{
  const d = parseNetlist(`.freq 4G 6G 3\n.ref 5G\n.substrate ${SUB}\nport a\nport b\nport c\nport e\ncline K W=0.883mm S=0.1025mm len=10mm\n  A a c\n  B b e\nend\n`);
  const L = mscoupledLoss({ W: 0.883e-3, S: 0.1025e-3, ...g, f: F0 });
  const sec = d.sections[0], modes = sec.modalInfo();
  const iEven = modes.findIndex(m => Math.abs(m.vector[0] + m.vector[1]) > 1), iOdd = 1 - iEven;
  check('coupled section: even and odd modes get their own Q', rel(sec.Qm[iEven], L.even.Q) < 1e-12 && rel(sec.Qm[iOdd], L.odd.Q) < 1e-12 && L.odd.Q < L.even.Q);
  const r = solve(d), P = 4; let pin = 0;
  for (let i = 0; i < P; i++) { const s = r.S(i + 1, 1); pin += s.re[1] ** 2 + s.im[1] ** 2; }
  check('lossy coupled section dissipates power (Σ|Si1|² < 1)', pin < 0.999 && pin > 0.9, pin);
}

// ---- optimiser works on physical dimensions ----
{
  const net = `.freq 2G 2G 2\n.ref 2G\n.substrate ${SUB}\n.param w = 0.6mm tune 0.3mm 2mm\nport a 50\nport b 50\nT1 a b W=w len=17mm Q=1e30\n.goal db(S11) < -50 2G 2G\n`;
  const opt = optimise(net, { maxiter: 300 }); let s; while (!(s = opt.next()).done) {}
  const w = parseNetlist(writeBack(net, s.value.best)).scope.w;
  const target = synthMsline({ Z0: 50, ...g, f: 2e9 }).W;
  check('optimiser tunes a physical width to the 50 Ω value (within 1 %)', rel(w, target) < 0.01, `${w} vs ${target}`);
}

// ---- errors and warnings ----
{
  const base = `.freq 1G 2G 3\nport a\nport b\n`;
  check('geometry without .substrate is an error', throws(() => parseNetlist(base + 'T1 a b W=1mm len=10mm\n'), /needs a \.substrate/));
  check('W together with Z0 is an error', throws(() => parseNetlist(`.substrate ${SUB}\n` + base + 'T1 a b W=1mm Z0=50 len=10mm\n'), /either W=/));
  check('W together with electrical line constants is an error', throws(() => parseNetlist(`.substrate ${SUB}\n` + base + 'cline K W=1mm S=0.2mm\n  Zeo 70 35\n  len 10mm\n  A a -\n  B b -\nend\n'), /not both/));
  check('coupled geometry without S is an error', throws(() => parseNetlist(`.substrate ${SUB}\n` + base + 'cline K W=1mm\n  len 10mm\n  A a -\n  B b -\nend\n'), /needs W and S/));
  check('unknown geometry kind is an error', throws(() => parseNetlist(`.substrate ${SUB}\n` + base + 'cline K geom=stripline W=1mm S=0.2mm\n  len 10mm\n  A a -\n  B b -\nend\n'), /not supported/));
  const d = parseNetlist(`.substrate ${SUB}\n` + base + 'cline K W=0.08mm S=0.05mm\n  len 10mm\n  A a -\n  B b -\nend\n');
  check('fab-rule violations appear as warnings', d.warnings.some(w => /minimum space/.test(w)) && d.warnings.some(w => /minimum trace/.test(w)), JSON.stringify(d.warnings));
  check('electrical netlists are unaffected (no substrate needed)', solve(parseNetlist(base + 'T1 a b Z0=50 len=90deg\n')).failures === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
