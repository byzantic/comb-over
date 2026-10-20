// Duplexer / diplexer (issue #40): two bandpass filters on a common junction.
//
//   port ant ── tee (side arm) ── main arm A ── vertical line vA ── bend ── horizontal h ── filter A ── port A
//                              └─ main arm B ── vertical line vB ── bend ── horizontal h ── filter B ── port B
//
// Each filter comes from the existing synthesis (comb-line, interdigital or hairpin on the substrate).
// The line from the junction to filter X must make X look like an open circuit in the OTHER band, so
// that it does not load the other filter there: with ΓX(f) the reflection at X's input (its tee side
// node, R0 reference), the branch's electrical length at the other band's centre is
//   θX = arg ΓX / 2 + k·180°,
// k chosen so the two filters, stacked one above the other, clear each other. The vertical runs vA, vB
// are then polished on the joint goals: return loss at the antenna in both passbands, isolation between
// the two filter ports in both bands.
//
// The filters are merged into one netlist by tagNetlist(): every node, parameter and element name of
// filter X gets the suffix _X, its sections keep their own f0 (degree lengths and dispersion), its header,
// goals and plots are dropped, and its input port becomes the manifold node.
import { design, returnLossDb, rippleEdges } from './synth.js';
import { realise } from './synth-geom.js';
import { realiseHairpin } from './synth-hairpin.js';
import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { optimise, goalCost } from './optimize.js';
import { makeSubstrate } from './substrates.js';
import { msline, synthMsline } from './microstrip.js';
import { bendLC } from './discontinuities.js';

const C0 = 299792458;
const fmt = (x, d = 6) => +x.toPrecision(d);
const GROUND = new Set(['0', 'gnd', 'ground', '-', 'open', 'nc']);

/**
 * Rename a filter netlist for merging. Returns { params: [.param lines], body: [lines], ports: [node…] }
 * with nodes N → N_tag (ground and open untouched; the first port node → `input`), parameters and
 * element names suffixed _tag, sections given f0 = fref. keepTune keeps the parameters' tune ranges.
 */
export function tagNetlist(text, tag, { input, fref, keepTune = false } = {}) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/#.*$/, '').replace(/\s+$/, '')).filter(l => l.trim());
  const params = new Set(), ports = [];
  for (const l of lines) { const m = l.match(/^\s*\.param\s+([A-Za-z_]\w*)\s*=/i); if (m) params.add(m[1]); }
  for (const l of lines) { const m = l.match(/^\s*port\s+(\S+)/i); if (m) ports.push(m[1]); }
  const ren = (s) => s.replace(/\b[A-Za-z_]\w*\b/g, (id) => (params.has(id) ? `${id}_${tag}` : id));
  const node = (n) => (GROUND.has(n.toLowerCase()) ? n : n === ports[0] && input ? input : `${n}_${tag}`);
  const kvTok = (t) => /^[A-Za-z_]\w*=/.test(t);
  const outP = [], body = [];
  let inBlock = false, hasF0 = false;
  for (const raw of lines) {
    const l = raw.trim(), toks = l.split(/\s+/), kw = toks[0].toLowerCase();
    if (inBlock) {
      if (kw === 'end') { if (!hasF0 && fref) body.push(`  f0 ${fref}`); body.push('end'); inBlock = false; continue; }
      if (kw === 'a' || kw === 'b') { body.push(`  ${toks[0]} ${toks.slice(1).map(node).join(' ')}`); continue; }
      if (kw === 'f0') hasF0 = true;
      body.push(`  ${ren(l)}`);
      continue;
    }
    if (kw.startsWith('.')) {
      if (kw === '.param') {
        const m = l.match(/^\.param\s+([A-Za-z_]\w*)\s*=\s*(.*)$/i);
        let rhs = m[2];
        if (!keepTune) rhs = rhs.replace(/\s+tune\s+.*$/i, '');
        outP.push(`.param ${m[1]}_${tag} = ${ren(rhs)}`);
      }
      continue;                                             // .title .freq .ref .substrate .layout .goal .plot …: dropped
    }
    if (kw === 'port') continue;
    if (kw === 'cline') {
      const rest = toks.slice(2).map(ren);
      body.push(`cline ${toks[1]}_${tag}${rest.length ? ' ' + rest.join(' ') : ''}`);
      inBlock = true; hasF0 = toks.slice(2).some(t => /^f0=/i.test(t));
      continue;
    }
    if (kw === 'wire') { body.push(`wire ${toks.slice(1).map(node).join(' ')}`); continue; }
    if (['tee', 'bend', 'step', 'via', 'cap', 'res'].includes(kw)) {
      const out = [toks[0], `${toks[1]}_${tag}`];
      for (const t of toks.slice(2)) out.push(kvTok(t) ? ren(t) : node(t));
      body.push(out.join(' '));
      continue;
    }
    const type = toks[0][0].toUpperCase();
    if ('RCLT'.includes(type)) {
      const out = [`${toks[0]}_${tag}`];
      const rest = toks.slice(1);
      if (type === 'T') {
        let k = 0; for (; k < rest.length && !kvTok(rest[k]); k++) out.push(node(rest[k]));
        const kvs = rest.slice(k).map(ren);
        if (fref && kvs.some(t => /^w=/i.test(t)) && !kvs.some(t => /^f0=/i.test(t))) kvs.push(`f0=${fref}`);
        out.push(...kvs);
      } else {
        out.push(node(rest[0]), node(rest[1]), ...rest.slice(2).map(ren));
      }
      body.push(out.join(' '));
      continue;
    }
    throw new Error(`tagNetlist: cannot merge line "${l}"`);
  }
  return { params: outP, body, ports: ports.map((p, i) => (i === 0 && input ? input : `${p}_${tag}`)) };
}

// one filter on the substrate, from the existing syntheses
function filterNetlist(spec, sub, opts) {
  if (spec.structure === 'hairpin') return realiseHairpin(spec, { substrate: sub.id });
  return realise(design(spec), { substrate: sub.id, cap: opts.cap });
}

// reflection at a filter's input (its first port) at f, ports at R0
function gammaAt(text, f) {
  const d = parseNetlist(text.replace(/^\.freq .*$/m, `.freq ${f} ${f} 1`)), s = solve(d).S(1, 1);
  return { re: s.re[0], im: s.im[0] };
}

/** The duplexer netlist for state st = { vA, vB, h } (mm) and the two tagged filters. */
export function duplexerNetlist(dx, st, opts = {}) {
  const { spec, sub, A, B, wf } = dx, R0 = spec.R0 ?? 50;
  const L = [];
  const [fa, fb] = [spec.bands[0].f0, spec.bands[1].f0];
  const lo = Math.min(fa * (1 - 2.5 * spec.bands[0].fbw), fb * (1 - 2.5 * spec.bands[1].fbw)), hi = Math.max(fa * (1 + 2.5 * spec.bands[0].fbw), fb * (1 + 2.5 * spec.bands[1].fbw));
  L.push(`.title Duplexer ${fmt(fa / 1e9, 5)} / ${fmt(fb / 1e9, 5)} GHz (${spec.structure}, n = ${spec.n}) on ${sub.id}`);
  for (const r of st.report ?? []) L.push(`# ${r}`);
  L.push(`.freq ${opts.freq ?? `${fmt(lo)} ${fmt(hi)} 1201`}`, `.ref ${fmt(Math.sqrt(fa * fb), 9)}`, `.substrate ${sub.id}`);
  if (opts.layout) L.push('.layout duplexer');
  const tune = (v) => (opts.tune === false ? '' : ` tune ${fmt(Math.max(0.5, v * 0.7), 5)}mm ${fmt(v * 1.3 + 1, 5)}mm`);
  L.push(`.param va = ${fmt(st.vA, 7)}mm${tune(st.vA)}   # junction to the bend, branch A`, `.param vb = ${fmt(st.vB, 7)}mm${tune(st.vB)}   # junction to the bend, branch B`);
  L.push(`.param h = ${fmt(st.h, 7)}mm   # bend to each filter's tap junction`, `.param wm = ${fmt(wf, 7)}mm   # manifold width (${R0} ohm)`);
  L.push(...A.params, ...B.params);
  L.push(`port ant ${R0}`, `port ${A.ports[1]} ${R0}`, `port ${B.ports[1]} ${R0}`);
  L.push('# manifold: antenna on the side arm; branch X runs up/down to a bend, then across to filter X');
  L.push('tee TJM ma mb ant Wa=wm Wb=wm W2=wm');
  for (const [x, v] of [['a', 'va'], ['b', 'vb']]) L.push(`TM${x}_v m${x} m${x}v W=wm len=${v}`, `bend BM${x} m${x}v m${x}h W=wm mitre=opt`, `TM${x}_h m${x}h ${x === 'a' ? A.ports[0] : B.ports[0]} W=wm len=h`);
  L.push('# filter A', ...A.body, '# filter B', ...B.body);
  if (opts.goals !== false) L.push(...goals(dx));
  return L.join('\n') + '\n';
}
function goals(dx) {
  const { spec } = dx, out = [], rl = spec.type === 'chebyshev' ? returnLossDb(spec.ripple) : 15;
  spec.bands.forEach((b, i) => {
    const [ra, rb] = rippleEdges(b.f0, b.fbw), c0 = ra + 0.1 * (rb - ra), c1 = rb - 0.1 * (rb - ra);
    out.push(`.goal db(S11) < ${fmt(-(rl - 1), 4)} ${fmt(c0, 8)} ${fmt(c1, 8)}   # antenna match, band ${'AB'[i]} (central 80 %, 1 dB below the filter's)`);
    out.push(`.goal db(S32) < ${fmt(-spec.isolation, 4)} ${fmt(ra, 8)} ${fmt(rb, 8)}   # isolation between the filter ports, band ${'AB'[i]}`);
  });
  out.push('.plot ylim=-80,0 db(S11) db(S21) db(S31) db(S32)');
  return out;
}

/**
 * Duplexer on a substrate. spec: { structure (comb|interdigital|hairpin), type, n, ripple, R0, Zr, θ0Deg,
 * er, bands: [{ f0, fbw }, { f0, fbw }], isolation (dB) }; opts: { substrate, cap, gap (mm between the
 * filters' copper, default max(5h, 4 mm)) }.
 */
export function realiseDuplexer(spec0, opts = {}) {
  const spec = { structure: 'interdigital', type: 'chebyshev', ripple: 0.1, R0: 50, isolation: 40, ...spec0 };
  if (!(spec.bands?.length === 2)) throw new Error('duplexer: two bands');
  const sub = makeSubstrate(opts.substrate ?? 'jlc-ro4350b-1.524'), warnings = [], log = [];
  const h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t, R0 = spec.R0;
  const [ba, bb] = spec.bands;
  if (ba.f0 >= bb.f0) throw new Error('duplexer: band A must be the lower band');
  // the two filters
  const fspec = (b) => ({ structure: spec.structure, type: spec.type, n: spec.n, ripple: spec.ripple, f0: b.f0, fbw: b.fbw, R0, Zr: spec.Zr ?? (spec.structure === 'hairpin' ? R0 : 50), theta0Deg: spec.theta0Deg ?? 45, er: spec.er ?? er });
  const FA = filterNetlist(fspec(ba), sub, opts), FB = filterNetlist(fspec(bb), sub, opts);
  for (const [F, X] of [[FA, 'A'], [FB, 'B']]) F.warnings.forEach(w => warnings.push(`filter ${X}: ${w}`));
  log.push(`filters: ${FA.report.find(r => r.startsWith('realised'))} | ${FB.report.find(r => r.startsWith('realised'))}`);
  const wf = synthMsline({ Z0: R0, h, t, er, f: Math.sqrt(ba.f0 * bb.f0) }).W * 1e3;
  // branch lengths: X open in the other band
  const lam = (f) => C0 / Math.sqrt(msline({ W: wf / 1e3, h, er, t, f }).epsEff) / f * 1e3;
  const want = (text, fOther) => { const g = gammaAt(text, fOther); let th = Math.atan2(g.im, g.re) * 180 / Math.PI / 2; if (th < 0) th += 180; return { th, mag: Math.hypot(g.re, g.im), lam: lam(fOther) }; };
  const wA = want(FA.netlist, bb.f0), wB = want(FB.netlist, ba.f0);
  log.push(`filter A seen from its input at ${fmt(bb.f0 / 1e9, 5)} GHz: |Γ| ${fmt(wA.mag, 4)}, open after ${fmt(wA.th, 4)}° (+ k·180°); filter B at ${fmt(ba.f0 / 1e9, 5)} GHz: |Γ| ${fmt(wB.mag, 4)}, ${fmt(wB.th, 4)}°`);
  // geometry: how far apart the filters' tap junctions must be (stacked, with a gap between their copper)
  const ext = (F) => { const d = parseNetlist(F.netlist); return extentAroundTap(d); };
  const eA = ext(FA), eB = ext(FB), gap = opts.gap ?? Math.max(5 * h * 1e3, 4);
  // A on top, B below (y down); the layout mirrors a filter when that puts less copper between the taps
  const Dmin = Math.min(eA.below, eA.above) + gap + Math.min(eB.above, eB.below);
  log.push(`spacing: filter A ${fmt(eA.above, 3)} mm above / ${fmt(eA.below, 3)} mm below its tap, filter B ${fmt(eB.above, 3)} / ${fmt(eB.below, 3)} mm; taps at least ${fmt(Dmin, 4)} mm apart`);
  const M = bendLC({ W: wf / 1e3, h, er, mitre: 'opt' });
  const hRun = Math.max(2 * wf, 3);                        // bend to tap junction (mm), fixed
  // branch X length from the tee's main-arm plane: vX (vertical, to the bend's plane) + h; the tee's
  // main arms span half the feed width either side of the antenna's centre line
  const physical = (deg, l) => deg / 360 * l;
  let kA = 0, kB = 0, vA, vB;
  for (;;) {
    vA = physical(wA.th + 180 * kA, wA.lam) - hRun - wf / 2; vB = physical(wB.th + 180 * kB, wB.lam) - hRun - wf / 2;
    if (vA < wf) { kA++; continue; }
    if (vB < wf) { kB++; continue; }
    if (vA + vB + wf + 2 * (wf / 2) >= Dmin) break;        // tap-to-tap distance = vA + vB + the tee span + the two bend half-widths
    if (vA <= vB) kA++; else kB++;
    if (kA + kB > 12) throw new Error('duplexer: could not fit the branch lengths');
  }
  const st = { vA, vB, h: hRun };
  const dx = { spec, sub, wf, A: tagNetlist(FA.netlist, 'A', { input: 'ta_in', fref: ba.f0 }), B: tagNetlist(FB.netlist, 'B', { input: 'tb_in', fref: bb.f0 }), FA, FB };
  // polish vA, vB on the joint goals (lossless lines would be the purer judge; the filters keep their
  // loss here, which only lowers the passband peaks and does not move the goals)
  const freqs = (() => { const F = []; for (const b of spec.bands) { const [ra, rb] = rippleEdges(b.f0, b.fbw); for (let i = 0; i < 31; i++) F.push(ra + (rb - ra) * i / 30); } return Float64Array.from(F.sort((a, b2) => a - b2)); })();
  const cost = () => { const d = parseNetlist(duplexerNetlist(dx, st)); return goalCost(d, solve(d, freqs)).cost; };
  let c = cost();
  log.push(`manifold start (k = ${kA}, ${kB}): vA ${fmt(vA, 4)} mm, vB ${fmt(vB, 4)} mm, goal cost ${c.toExponential(2)}`);
  for (let round = 0; round < 3 && c > 1e-3; round++) {
    const g = optimise(duplexerNetlist(dx, st), { maxiter: 120, freqs }); let it, last;
    while (!(it = g.next()).done) last = it.value;
    const out = it.value ?? last;
    st.vA = out.best.va * 1e3; st.vB = out.best.vb * 1e3;
    const c2 = cost(); log.push(`manifold polish ${round + 1}: vA ${fmt(st.vA, 4)} mm, vB ${fmt(st.vB, 4)} mm, goal cost ${c2.toExponential(2)}`);
    if (c2 > c * 0.98) { c = c2; break; }
    c = c2;
  }
  if (st.vA + st.vB + 2 * wf < Dmin) warnings.push(`the polished branches bring the filters closer than the ${fmt(gap, 3)} mm gap`);
  // isolation budget
  const budget = isolationBudget(dx, st);
  st.report = [
    `filters: ${spec.structure}, n = ${spec.n}, ${spec.type}${spec.type === 'chebyshev' ? ` ${spec.ripple} dB` : ''}; band A ${fmt(ba.f0 / 1e9, 5)} GHz ${fmt(ba.fbw * 100, 3)} %, band B ${fmt(bb.f0 / 1e9, 5)} GHz ${fmt(bb.fbw * 100, 3)} %, on ${sub.id}`,
    `manifold: ${R0} Ω lines (${fmt(wf, 4)} mm); branch A ${fmt(st.vA + st.h, 4)} mm, branch B ${fmt(st.vB + st.h, 4)} mm from the junction (each with one mitred bend), chosen to open each filter in the other band`,
    ...budget.lines,
    'not modelled: coupling between the two filters and between the manifold and the filters through the layout (see #16); the filters are as their own synthesis left them',
  ];
  for (const b of budget.bands) if (b.isolation < spec.isolation) warnings.push(`isolation in band ${b.name} is ${fmt(b.isolation, 3)} dB, short of the ${spec.isolation} dB asked for: ${b.limit}`);
  return { netlist: duplexerNetlist(dx, st, { layout: true }), report: st.report, warnings, log, state: st, budget, dx };
}

// worst isolation between the filter ports, the filters' own rejection of the other band, antenna match
function isolationBudget(dx, st) {
  const { spec } = dx, lines = [], bands = [];
  const d = parseNetlist(duplexerNetlist(dx, st, { goals: false, freq: '1 1 1' }));
  const solveAt = (dd, F) => solve(dd, F);
  const filterAlone = (F, f) => { const r = solve(parseNetlist(F.netlist.replace(/^\.freq .*$/m, `.freq ${f[0]} ${f.at(-1)} ${f.length}`))); return r; };
  spec.bands.forEach((b, i) => {
    const [ra, rb] = rippleEdges(b.f0, b.fbw), F = Float64Array.from({ length: 41 }, (_, k) => ra + (rb - ra) * k / 40);
    const r = solveAt(d, F);
    const worst = (fn) => { let w = -Infinity; for (let k = 0; k < F.length; k++) w = Math.max(w, fn(k)); return w; };
    const db = (S, k) => 20 * Math.log10(Math.hypot(S.re[k], S.im[k]));
    const S32 = r.S(3, 2), S11 = r.S(1, 1), own = r.S(i === 0 ? 2 : 3, 1), other = r.S(i === 0 ? 3 : 2, 1);
    const core = (k) => F[k] >= ra + 0.1 * (rb - ra) && F[k] <= rb - 0.1 * (rb - ra);
    const iso = -worst(k => db(S32, k)), rl = -worst(k => (core(k) ? db(S11, k) : -Infinity)), ilMax = -Math.min(...Array.from(F, (_, k) => (core(k) ? db(own, k) : Infinity))), il0 = -db(own, 20), leak = -worst(k => db(other, k));
    const alone = filterAlone(i === 0 ? dx.FB : dx.FA, F), sa = alone.S(2, 1), rej = -worst(k => db(sa, k));
    const name = 'AB'[i];
    lines.push(`band ${name} (${fmt(ra / 1e9, 5)}–${fmt(rb / 1e9, 5)} GHz): isolation A↔B ≥ ${fmt(iso, 3)} dB over the ripple band; antenna return loss ≥ ${fmt(rl, 3)} dB and insertion loss antenna → ${name} ${fmt(il0, 3)} dB at the centre, ≤ ${fmt(ilMax, 3)} dB, over the central 80 %; leakage antenna → ${'BA'[i]} ≥ ${fmt(leak, 3)} dB down; filter ${'BA'[i]} alone rejects this band by ≥ ${fmt(rej, 3)} dB`);
    bands.push({ name, isolation: iso, rl, il: ilMax, il0, leak, rejection: rej, limit: iso <= rej + 0.5 ? `set by filter ${'BA'[i]}'s rejection of band ${name} (${fmt(rej, 3)} dB): raise n or move the bands apart` : 'the manifold, not the filters, limits it' });
  });
  return { lines, bands };
}

// distances from a filter's input tap junction (its tee, on line 1) to the copper above and below it
// (mm), from its resonator-array sections: the lines run along y from 0 to the sum of the section
// lengths, the tap at the tee's planes
function extentAroundTap(d) {
  const secs = d.sections.filter(s => s.geom?.kind === 'mslN'), mm = (x) => x * 1e3;
  const ys = [0]; secs.forEach(s => ys.push(ys.at(-1) + mm(s.len)));
  const tee = d.blocks.find(b => b.type === 'tee' && b.nodes[2] === d.ports[0].node);
  let yt = null;
  secs.forEach((s, k) => { s.ends.B.forEach(n => { if (n === tee.nodes[0]) yt = ys[k + 1]; }); });
  if (yt == null) secs.forEach((s, k) => { s.ends.A.forEach(n => { if (n === tee.nodes[0]) yt = ys[k]; }); });
  // beyond the lines' ends: via lands and end extensions (< 1.5 mm), capacitor parts (< 4.5 mm)
  const pad = 1.5 + ((d.caps ?? []).length ? 4.5 : 0);
  const half = mm(tee.geo.W2) / 2;
  return { above: yt + half + pad, below: ys.at(-1) - yt + half + pad };
}
