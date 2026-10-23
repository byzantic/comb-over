// Check the microstrip bend models against openEMS (issue #49).
//   node tools/bendcheck.mjs gen DIR        write one openEMS case per (substrate, W/h, mitre) into DIR/<case>/
//   node tools/bendcheck.mjs run DIR        run every case that has no result yet (OPENEMS_PYTHON)
//   node tools/bendcheck.mjs report DIR     compare each result with comb-over's bend model
// Each case: one 90° bend, legs long enough for the bend's fields to die out before the ports' planes,
// lossless on both sides (PEC copper, no dielectric loss; Q → ∞ in comb-over), so only the
// discontinuity is compared.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { routeOrtho } from '../js/routing.js';
import { makeSubstrate } from '../js/substrates.js';
import { openemsExport } from '../js/openems.js';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { readTouchstone, onSweep } from '../js/touchstone.js';
import { bendLC } from '../js/discontinuities.js';
import { msline } from '../js/microstrip.js';

const [cmd, dir] = process.argv.slice(2);
if (!cmd || !dir) { console.error('usage: node tools/bendcheck.mjs gen|run|report DIR'); process.exit(2); }

export const SUBS = [
  { line: 'jlc-zyf255da-0.762' }, { line: 'jlc-ro4350b-0.508' }, { line: 'jlc-ro4350b-1.524' }, { line: 'jlc-fr4-1.6' },
  { line: 'custom h=0.635mm er=10.2', id: 'er10.2-0.635', h: 0.635e-3, er: 10.2 },
];
const subOf = (S) => (S.id ? makeSubstrate('custom', { h: S.h, er: S.er }) : makeSubstrate(S.line));
const r4 = (x) => +x.toFixed(4);

function gen() {
  for (const S of SUBS) for (const u of [0.5, 1, 2, 4]) for (const mitre of ['opt', 'none', 'straight']) {
    const sub = subOf(S), h = sub.dielectric.h * 1e3, er = sub.dielectric.er, w = r4(u * h);
    const fmax = Math.min(10e9, 9e9 / h), fmin = fmax / 8;
    const Lc = r4(3 * h + 2 * w), Lp = Math.max(3, 2 * w), Lf = r4(Lp + 3 * h + 1);
    // 'straight': the reference, the same centreline length without the bend (separates the lines' own
    // εeff error from the bend's)
    const st = mitre === 'straight';
    const rt = st ? { poly: [[-Lc, -w / 2], [Lc, -w / 2], [Lc, w / 2], [-Lc, w / 2]], lines: [`TR_1 p1_k p2_k W=${w}mm len=${r4(2 * Lc)}mm`] }
      : routeOrtho([[-Lc, 0], [0, 0], [0, Lc]], { W: w, mitre, sub, name: 'R', a: 'p1_k', b: 'p2_k' });
    const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const items = [
      { type: 'poly', role: 'core', pts: rt.poly },
      { type: 'poly', role: 'feed', node: 'p1', width: w, pts: rect(-Lc - Lf, -w / 2, -Lc, w / 2), path: [[-Lc - Lf, 0], [-Lc, 0]] },
      st ? { type: 'poly', role: 'feed', node: 'p2', width: w, pts: rect(Lc, -w / 2, Lc + Lf, w / 2), path: [[Lc + Lf, 0], [Lc, 0]] }
        : { type: 'poly', role: 'feed', node: 'p2', width: w, pts: rect(-w / 2, Lc, w / 2, Lc + Lf), path: [[0, Lc + Lf], [0, Lc]] },
    ];
    const name = `${S.id ?? S.line}_u${u}_${mitre}`;
    // ports at the strip's own impedance (comb-over's model at the band centre), so S11 is the bend, not the line
    const z0 = +msline({ W: w * 1e-3, h: h * 1e-3, t: sub.copper.t, er, f: (fmin + fmax) / 2 }).Z0.toFixed(3);
    const net = [`.title bend check ${name}`, `.freq ${fmin} ${fmax} 201`, `.substrate ${S.line}`, `port p1 ${z0}`, `port p2 ${z0}`,
      `Tp1_f p1 p1_k W=${w}mm len=${Lf}mm`, `Tp2_f p2 p2_k W=${w}mm len=${Lf}mm`, ...rt.lines].join('\n') + '\n';
    const g = openemsExport(net, { layout: { items, parts: [], substrate: sub, netlist: net, errors: [], title: name }, excite: '1', lossless: true, fine: Math.min(w, h) / 4 });
    const d = join(dir, name); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'bend.py'), g.script.replace(/'[^']*\.s%dp'/, "'bend.s%dp'"));
    writeFileSync(join(d, 'compare.cir'), g.compare.replace(/^\.data .*$/m, '.data em bend.s2p overlay'));
    writeFileSync(join(d, 'case.json'), JSON.stringify({ name, sub: S.line, h, er, w, u, mitre, fmin, fmax, z0, cells: g.info.cells }));
    console.log(name, g.info.cells, 'cells');
  }
}

function run() {
  for (const name of readdirSync(dir).sort()) {
    const d = join(dir, name);
    if (!existsSync(join(d, 'bend.py')) || existsSync(join(d, 'bend.s2p'))) continue;
    const t0 = Date.now(), r = spawnSync(process.env.OPENEMS_PYTHON || 'python3', ['bend.py'], { cwd: d, encoding: 'utf8', maxBuffer: 1 << 28 });
    writeFileSync(join(d, 'run.log'), r.stdout + r.stderr);
    console.log(name, r.status === 0 && !/-nan/.test(r.stdout) ? 'ok' : 'FAILED', `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}

// the bend in compare.cir replaced by L1 / C / L2 with each arm's L = kL × the published L (KJK or Douville–James),
// plus dl (mm) of line each side: kL = 1 is the published circuit (L in each arm, #49), 0.5 comb-over's before #49
export function withBend(text, c, { kL = 1, kC = 1, dl = 0 } = {}) {
  const m = bendLC({ W: c.w * 1e-3, h: c.h * 1e-3, er: c.er, mitre: c.mitre });
  const Lf = m.L1;                     // the published L (bendLC puts it in each arm)
  return text.replace(/^bend (\S+) (\S+) (\S+) W=\S+ mitre=\S+$/m, (_, n, a, b) => [
    dl > 1e-9 ? `T${n}_xa ${a} ${n}_a W=${c.w}mm len=${dl}mm Q=1e30` : `wire ${a} ${n}_a`,
    `L${n}_1 ${n}_a ${n}_m ${Math.max(Lf * kL, 1e-15)}`, `C${n}_c ${n}_m 0 ${Math.max(m.C * kC, 1e-18)}`, `L${n}_2 ${n}_m ${n}_b ${Math.max(Lf * kL, 1e-15)}`,
    dl > 0 ? `T${n}_xb ${n}_b ${b} W=${c.w}mm len=${dl}mm Q=1e30` : `wire ${n}_b ${b}`].join('\n'));
}

function report() {
  const rows = [], lineErr = {};
  // the straight references first: their phase error at fmax is the lines' own (openEMS vs comb-over εeff)
  for (const name of readdirSync(dir).sort().filter(n => /_straight$/.test(n))) {
    const d = join(dir, name);
    if (!existsSync(join(d, 'bend.s2p'))) continue;
    const c = JSON.parse(readFileSync(join(d, 'case.json'), 'utf8')), text = readFileSync(join(d, 'compare.cir'), 'utf8').replace(/^\.data .*$/m, '');
    const ds = readTouchstone(readFileSync(join(d, 'bend.s2p'), 'utf8'), { nPorts: 2, name: 'b' }), f = Float64Array.from([c.fmax * 0.999]);
    const r = solve(parseNetlist(text), f), em = onSweep(ds, f), p = r.S(2, 1), q = em.S(2, 1);
    let x = (Math.atan2(q.im[0], q.re[0]) - Math.atan2(p.im[0], p.re[0])) * 180 / Math.PI; x = ((x + 540) % 360) - 180;
    const len = text.match(/len=([\d.]+)mm/g).map(m => +m.slice(4, -2)).reduce((a, b) => a + b, 0);
    lineErr[name.replace(/_straight$/, '')] = { deg: x, perMm: x / len };
  }
  for (const name of readdirSync(dir).sort()) {
    const d = join(dir, name);
    if (/_straight$/.test(name) || !existsSync(join(d, 'bend.s2p'))) continue;
    const c = JSON.parse(readFileSync(join(d, 'case.json'), 'utf8')), text = readFileSync(join(d, 'compare.cir'), 'utf8').replace(/^\.data .*$/m, '');
    const ds = readTouchstone(readFileSync(join(d, 'bend.s2p'), 'utf8'), { nPorts: 2, name: 'b' });
    // just inside the band (the Touchstone file rounds the end frequencies)
    const a = c.fmin * 1.001, b = c.fmax * 0.999, F = Float64Array.from({ length: 9 }, (_, k) => a + (b - a) * k / 8), em = onSweep(ds, F);
    // the lines' share of the phase error, from the straight reference (per mm of modelled line)
    const lineLen = text.match(/len=([\d.]+)mm/g).map(m => +m.slice(4, -2)).reduce((a, b) => a + b, 0);
    const ref = lineErr[name.replace(/_(opt|none)$/, '')], dLine = ref ? ref.perMm * lineLen : 0;
    const metrics = (txt) => {
      const r = solve(parseNetlist(txt), F); let e11 = 0, dph = 0;
      for (let k = 0; k < F.length; k++) {
        const a = r.S(1, 1), b = em.S(1, 1); e11 = Math.max(e11, Math.hypot(a.re[k] - b.re[k], a.im[k] - b.im[k]));
        const p = r.S(2, 1), q = em.S(2, 1); let x = (Math.atan2(q.im[k], q.re[k]) - Math.atan2(p.im[k], p.re[k])) * 180 / Math.PI; x = ((x + 540) % 360) - 180;
        if (k === F.length - 1) dph = x - dLine;
      }
      return { e11, dph };
    };
    const emS11 = Math.max(...Array.from(F, (_, k) => 20 * Math.log10(Math.hypot(em.S(1, 1).re[k], em.S(1, 1).im[k]))));
    const half = metrics(withBend(text, c, { kL: 0.5 })), full = metrics(withBend(text, c, { kL: 1 }));
    // reference-plane offset with the full-L model: the extra line each side that zeroes the phase at fmax
    let best = [Infinity, 0];
    for (let dl = 0; dl <= 1.5 * c.w; dl += c.w / 100) { const m = metrics(withBend(text, c, { kL: 1, dl })); if (Math.abs(m.dph) < best[0]) best = [Math.abs(m.dph), dl]; }
    const fitted = metrics(withBend(text, c, { kL: 1, dl: best[1] }));
    rows.push({ ...c, emS11, half, full, dl: best[1], fitted, dLine });
  }
  console.log('∠S21 errors are the bend\'s: the lines\' own error (straight reference) removed');
  console.log('case'.padEnd(34), 'W/h', ' εr  ', 'f·h GHz·mm', 'EM max S11', '| L/2 per arm: max|ΔS11| ∠S21 err | L per arm: max|ΔS11| ∠S21 err | dl/W  then max|ΔS11|  (line err removed)');
  for (const r of rows) console.log(r.name.padEnd(34), String(r.u).padEnd(4), String(r.er).padEnd(5), (r.fmax / 1e9 * r.h).toFixed(1).padEnd(10), r.emS11.toFixed(1).padEnd(10),
    '|', r.half.e11.toFixed(3).padEnd(6), `${r.half.dph.toFixed(1)}°`.padEnd(8), '|', r.full.e11.toFixed(3).padEnd(6), `${r.full.dph.toFixed(1)}°`.padEnd(8), '|', (r.dl / r.w).toFixed(3).padEnd(6), r.fitted.e11.toFixed(3).padEnd(7), `${r.dLine.toFixed(1)}°`);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(rows, null, 1));
}

const fn = { gen, run, report }[cmd];
if (!fn) { console.error('unknown command'); process.exit(2); }
fn();
