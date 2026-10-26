// A 3-line coupler in openEMS (#41, stage 3): centre line straight through, the outer lines leaving each end of the
// coupled section at 45°, with or without fingers; and comb-over's model of it.
//   node tools/fingercoupler3.mjs gen DIR --Wo --Wc --G [--wf --lf --lfo --p] --cells N [--bare] [--CL design3.json:NAME]
//   (cd DIR && $OPENEMS_PYTHON f.py)       lines 1 and 2 driven; the mirror (line 1 ↔ 3) gives the rest
//   node tools/fingercoupler3.mjs cmp DIR [DIR2 …]     centre → outer coupling, isolation and directivity, model | openEMS
// Ports: line 1 (bottom) left/right = 1/2, centre 3/4, line 3 (top) 5/6. The coupled port of the centre input (3) is
// 1 (and 5), the isolated one 2 (and 6).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fingerArray, spliceFingers } from '../js/fingers.js';
import { pathPolygon } from '../js/layout.js';
import { makeSubstrate } from '../js/substrates.js';
import { openemsExport } from '../js/openems.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';
import { mirrorPerm, bareCLN } from './fingerlibN.mjs';
import { synthMsline, fromSubstrate } from '../js/microstrip.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const r6 = (x) => +x.toFixed(6), m8 = (x) => x.toPrecision(8), mat = (M) => `[${M.map(r => r.map(m8).join(' ')).join('; ')}]`;

function gen() {
  const Wo = +opt('Wo'), Wc = +opt('Wc'), G = +opt('G'), wf = +opt('wf', 0.13), lf = +opt('lf', 0.4), lfo = +opt('lfo', 0), p = +opt('p', 1), n = +opt('cells', 8);
  const bare = rest.includes('--bare'), subId = opt('sub', 'jlc-ro4350b-0.508'), sub = makeSubstrate(subId), h = sub.dielectric.h * 1e3;
  const fa = fingerArray({ W: [Wo, Wc, Wo], G: [G, G], wf, lf, p, n, lfo: bare ? 0 : lfo }), len = fa.len;
  const yc = fa.ybands.map(([lo, hi]) => (lo + hi) / 2), W = [Wo, Wc, Wo];
  // At each end of the section a linear taper (length Lt) from the line's width to the 50 Ω width wz, then everything at
  // wz: the outer lines' 45° arms (run d) and the straight feeds to the board edge (Lf, port plane Lp in from it). The
  // match conditions hold for Z0 terminations at the section itself: every stretch at a line's own ~56 Ω between the
  // section and the feeds detunes it (a line-width margin, arms and tapers after them gave S33 −18 dB at 7 GHz)
  const wz = r6(synthMsline({ Z0: 50, ...fromSubstrate(sub), f: 5e9 }).W * 1e3), Lt = +opt('taper', 0.6), dh = 0.2;
  const d = +opt('arm', 1.5), Lp = 3, Lf = r6(Lp + 3 * h + 1.5);
  const items = [], ports = [], xFeed = [];
  for (let i = 0; i < 3; i++) {
    const [lo, hi] = fa.ybands[i].map(r6), y = (lo + hi) / 2, s = i === 1 ? 0 : Math.sign(y), ya = y + s * d;
    // the section: one outline per line, fingers spliced into its straight edges
    let P = [[0, lo], [len, lo], [len, hi], [0, hi]];
    if (!bare) {
      const xs = Array.from({ length: n }, (_, k) => r6((k + (i % 2 === 0 ? 0.25 : 0.75)) * p));
      if (i < 2) P = spliceFingers(P, hi, hi + 1, xs, wf, lf, 1e-6);
      if (i > 0) P = spliceFingers(P, lo, lo - 1, xs, wf, lf, 1e-6);
      if (lfo > 0 && i === 0) P = spliceFingers(P, lo, lo - 1, xs, wf, lfo, 1e-6);
      if (lfo > 0 && i === 2) P = spliceFingers(P, hi, hi + 1, xs, wf, lfo, 1e-6);
    }
    items.push({ type: 'poly', role: 'core', pts: P });
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? 0 : len, x1 = x0 + side * Lt, [xa, xb] = side < 0 ? [x1, x0] : [x0, x1], [wa, wb] = side < 0 ? [wz, W[i]] : [W[i], wz];
      items.push({ type: 'poly', role: 'core', pts: [[xa, y - wa / 2], [xb, y - wb / 2], [xb, y + wb / 2], [xa, y + wa / 2]] });          // taper
      // the arm at wz: a short straight, then 45° away (outer lines) to the feed's level, then the feed
      const path = i === 1 ? [[x1, y], [x1 + side * (2 * dh + d), y]] : [[x1, y], [x1 + side * dh, y], [x1 + side * (dh + d), ya], [x1 + side * (2 * dh + d), ya]];
      items.push({ type: 'poly', role: 'core', pts: pathPolygon(path, wz).map(([u, v]) => [r6(u), r6(v)]) });
      const xs0 = x1 + side * (2 * dh + d), xe = xs0 + side * Lf, k = 2 * i + (side < 0 ? 1 : 2), yf = i === 1 ? y : ya;
      items.push({ type: 'poly', role: 'feed', node: `p${k}`, width: wz, pts: [[Math.min(xs0, xe), yf - wz / 2], [Math.max(xs0, xe), yf - wz / 2], [Math.max(xs0, xe), yf + wz / 2], [Math.min(xs0, xe), yf + wz / 2]], path: [[xe, yf], [xs0, yf]] });
      ports.push({ k, W: wz, Wl: W[i], arm: i === 1 ? 2 * dh + d : r6(2 * dh + d * Math.SQRT2) });
    }
  }
  ports.sort((a, b) => a.k - b.k);
  const net = ['.title 3-line coupler', '.freq 1G 9G 801', '.ref 5G', `.substrate ${subId}`, ...ports.map(q => `port p${q.k} 50`),
    ...ports.map(q => `Tp${q.k}_f p${q.k} p${q.k}_k W=${q.W}mm len=${Lf}mm`)].join('\n') + '\n';
  const feats = bare ? [Wo, Wc, G] : [Wo, Wc, G, wf, p / 2 - wf, G - lf, Math.max(2 * lf - G, wf)];
  const g = openemsExport(net, { layout: { items, parts: [], substrate: sub, netlist: net, errors: [], title: `3-line coupler${bare ? ' (plain)' : ' (fingers)'}` }, fine: opt('fine') != null ? +opt('fine') : Math.min(...feats) / 3, excite: '1,2,3,4', perm: mirrorPerm(3) });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'f.py'), g.script.replace(/'[^']*\.s%dp'/, "'f.s%dp'"));
  // comb-over's model at the measurement planes: feeds (Lf − Lp), arms and tapers (3 steps) as single lines, the section
  // as its C, L (--CL from fingerdesign3's log, or the bare lines from the 2-D solver)
  const bareCL = bareCLN({ sub: subId, W, G: [G, G] });
  let C = bareCL.C, L = bareCL.L;
  const clArg = opt('CL');
  if (clArg) { const [f, nm] = clArg.split(':'), hh = JSON.parse(readFileSync(f, 'utf8')).find(x => x.name === nm); if (!hh) throw new Error(`no ${nm} in ${f}`); C = hh.C; L = hh.L; }
  const fl = r6(Lf - g.info.ports[0].Lp), sec = (nm, CC, LL, l, A, B) => [`cline ${nm}`, `  C ${mat(CC)}`, `  L ${mat(LL)}`, `  len ${l}mm`, `  A ${A}`, `  B ${B}`, 'end'];
  const model = ['.title 3-line coupler model', '.freq 1G 9G 801', '.ref 5G', `.substrate ${subId}`, ...ports.map(q => `port p${q.k} 50`),
    ...ports.map(q => `Tp${q.k}_f p${q.k} p${q.k}_e W=${q.W}mm len=${fl}mm`),
    ...ports.map(q => `Tp${q.k}_a p${q.k}_e p${q.k}_g W=${wz}mm len=${q.arm}mm`),
    ...ports.flatMap(q => { const end = q.k % 2 ? 'a' : 'b', ln = (q.k + 1) >> 1;
      return [1, 2, 3].map(j => `Tp${q.k}_t${j} p${q.k}_${j === 1 ? 'g' : `t${j - 1}`} ${j === 3 ? `${end}${ln}` : `p${q.k}_t${j}`} W=${r6(q.W + (q.Wl - q.W) * (j - 0.5) / 3)}mm len=${r6(Lt / 3)}mm`); }),
    ...sec('K', C, L, len, 'a1 a2 a3', 'b1 b2 b3'),
    '.data em f.s6p overlay'].join('\n') + '\n';
  writeFileSync(join(dir, 'compare.cir'), model);
  writeFileSync(join(dir, 'case.json'), JSON.stringify({ Wo, Wc, G, wf, lf, lfo, p, n, len, bare, cells: g.info.cells, fine: g.info.fine, CL: clArg ?? 'bare 2-D' }));
  console.log(`${bare ? 'plain' : 'fingers'}: ${n} cells, ${len} mm; mesh ${g.info.cells} cells, fine ${g.info.fine.toFixed(4)} mm`);
}

function cmp() {
  const F = Float64Array.from({ length: 9 }, (_, k) => (1 + k) * 1e9), db = (x, k) => 20 * Math.log10(Math.hypot(x.re[k], x.im[k]));
  const runs = [dir, ...rest.filter(a => !a.startsWith('--'))].map(dd => {
    const d = parseNetlist(readFileSync(join(dd, 'compare.cir'), 'utf8'));
    return { dd, r: solve(d, F), em: onSweep(readTouchstone(readFileSync(join(dd, 'f.s6p'), 'utf8'), { nPorts: 6, name: 'f' }), F) };
  });
  console.log('centre input (port 3): coupled S13, isolated S23, match S33, directivity S13/S23 (dB): model | openEMS');
  for (const { dd, r, em } of runs) {
    console.log(dd.split('/').pop());
    for (let k = 0; k < F.length; k++) {
      const D = (s) => db(s.S(1, 3), k) - db(s.S(2, 3), k);
      console.log(`  ${(F[k] / 1e9).toFixed(0)} GHz  S13 ${db(r.S(1, 3), k).toFixed(2)} | ${db(em.S(1, 3), k).toFixed(2)}  S23 ${db(r.S(2, 3), k).toFixed(1)} | ${db(em.S(2, 3), k).toFixed(1)}  S33 ${db(r.S(3, 3), k).toFixed(1)} | ${db(em.S(3, 3), k).toFixed(1)}  D ${D(r).toFixed(1)} | ${D(em).toFixed(1)}  S15 ${db(r.S(1, 5), k).toFixed(1)} | ${db(em.S(1, 5), k).toFixed(1)}`);
    }
  }
}

const fn = { gen, cmp }[cmd];
if (!fn || !dir) { console.error('usage: node tools/fingercoupler3.mjs gen|cmp DIR [options]'); process.exit(2); }
fn();
