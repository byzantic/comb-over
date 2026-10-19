// Realise a synthesised comb-line's loading capacitors (issue #14): rewrite the ideal `C r_i 0 cl…`
// elements of a synthesis netlist into `cap` elements of the chosen kind on a substrate.
//
//   smd      nominal values from the wanted effective capacitance at f0 (pad, ESL and via included),
//            snapped to E12/E24; the common line length (th0, and the tap tt with it) is re-tuned to
//            absorb the snapping, and the residual detuning of each resonator is reported
//   trimmer  a Murata TZC3 that covers each value; the cl params keep their sliders, over the trimmer range
//   printed  square pads sized for the value; warns when the substrate cannot reach it
//
// The comb sections themselves are left as synthesised (their εr); the substrate sets pads and vias.
import { makeSubstrate } from './substrates.js';
import { smdForCeff, smdModel, snapE, retuneLength, pickTrimmer, printedRange, padC, TRIMMER_FOOTPRINT, TRIMMER_DEFAULTS } from './capacitors.js';
import { viaL } from './discontinuities.js';

const fmt = (x, d = 6) => (+x.toPrecision(d)).toString();
const pF = (c) => `${fmt(c * 1e12, 4)}p`;

/**
 * r: synthesis result (from design()); text: its netlist; cap: { type, pkg, series, substrate, via }
 * Returns { text, report: [lines], warnings: [..] }.
 */
export function realiseCaps(r, text, cap) {
  if (!cap || cap.type === 'ideal') return { text, report: [], warnings: [] };
  if (r.spec.structure !== 'comb') return { text, report: [], warnings: ['loading capacitors apply to comb-line filters only'] };
  const sub = makeSubstrate(cap.substrate);
  const f0 = (r.spec.target ?? r.spec).f0;
  const L = text.split('\n');
  const getP = (name) => { const l = L.find(x => new RegExp(`^\\.param ${name} = `).test(x)); return l ? parseFloat(l.split('=')[1]) : null; };
  const setLine = (re, line) => { const i = L.findIndex(x => re.test(x)); if (i >= 0) L[i] = line; return i; };
  const num = (x) => parseFloat(x) * (/p$/.test(x) ? 1e-12 : 1);
  const pval = (name) => { const l = L.find(x => new RegExp(`^\\.param ${name} = `).test(x)); return l ? num(l.split('=')[1].trim().split(/\s+/)[0]) : null; };
  const cl1 = pval('cl1'), cl = pval('cl');
  const n = r.spec.n;
  const want = Array.from({ length: n }, (_, i) => (i === 0 || i === n - 1 ? cl1 : cl));
  const report = [], warnings = [];
  const via = cap.via ?? { d: Math.max(0.3, (sub.fab.minDrill ?? 0.3e-3) * 1e3) / 1e3, n: 2 };
  // .substrate after .ref
  const iref = L.findIndex(x => x.startsWith('.ref'));
  L.splice(iref + 1, 0, `.substrate ${sub.id}`);
  const capLine = (i, extra) => setLine(new RegExp(`^C${i + 1} r${i + 1} 0 `), `cap C${i + 1} r${i + 1} ${extra}`);

  if (cap.type === 'smd') {
    const pkg = cap.pkg ?? '0603', series = (cap.series ?? 'E24').toUpperCase();
    const nominal = [], act = [];
    want.forEach((c, i) => {
      const x = smdForCeff({ Ceff: c, pkg, sub, via, f: f0 });
      if (!(x.C > 0)) throw new Error(`resonator ${i + 1}: ${x.why}`);
      const s = snapE(x.C, series);
      nominal.push(x.C); act.push(smdModel({ pkg, C: s, sub, via, f: f0 }).Ceff);
    });
    const th0 = getP('th0') * Math.PI / 180;
    const rt = retuneLength({ theta0: th0, Cneed: want, Cact: act, Ya: r.Ya, f0 });
    const th1 = rt.theta * 180 / Math.PI, tt0 = getP('tt'), tt1 = tt0 * rt.scale;
    setLine(/^\.param th0 = /, `.param th0 = ${fmt(th1, 9)} tune ${fmt(th1 * 0.97, 6)} ${fmt(th1 * 1.03, 6)}   # re-tuned from ${fmt(th0 * 180 / Math.PI, 7)} for the E-series capacitors`);
    setLine(/^\.param tt = /, `.param tt = ${fmt(tt1, 6)} tune ${fmt(tt1 * 0.6, 4)} ${fmt(Math.min(tt1 * 1.4, th1 * 0.98), 4)}`);
    const snapped = act.map((_, i) => snapE(nominal[i], series));
    want.forEach((c, i) => capLine(i, `C=${pF(snapped[i])} type=smd pkg=${pkg} d=${fmt(via.d * 1e3, 3)}mm n=${via.n}`));
    for (const k of ['cl1', 'cl']) setLine(new RegExp(`^\\.param ${k} = `), `# ideal loading ${k} = ${pF(k === 'cl1' ? cl1 : cl)} (effective, at f0) — realised by the cap elements below`);
    const m = smdModel({ pkg, C: snapped[0], sub, via, f: f0 });
    report.push(`# loading capacitors: SMD ${pkg} on ${sub.id}; pad ${pF(m.Cpad)} F, ESL ${fmt(m.esl * 1e9, 3)} nH (typical — set esl= from your part), ${via.n} × ${fmt(via.d * 1e3, 2)} mm vias ${fmt(m.Lvia * 1e9, 3)} nH`);
    report.push(`# values ${series}: ${snapped.map((s, i) => `C${i + 1} ${pF(s)} (exact ${pF(nominal[i])})`).join(', ')}`);
    report.push(`# line length re-tuned ${fmt(th0 * 180 / Math.PI, 6)}° → ${fmt(th1, 6)}°; residual detuning ${rt.dfRel.map(x => `${fmt(x * 100, 2)} %`).join(', ')} (FBW ${fmt((r.spec.target ?? r.spec).fbw * 100, 3)} %)`);
    const worst = Math.max(...rt.dfRel.map(Math.abs)), fbw = (r.spec.target ?? r.spec).fbw;
    if (worst > fbw / 10) warnings.push(`E-series snapping leaves a resonator detuned by ${fmt(worst * 100, 2)} % of f0 (more than FBW/10): use ${series === 'E12' ? 'E24' : 'a trimmer or printed trim'} or let the optimiser re-tune`);
    const srf = smdModel({ pkg, C: Math.max(...snapped), sub, via, f: f0 }).srf;
    if (srf < 3 * f0) warnings.push(`the largest capacitor self-resonates at ${fmt(srf / 1e9, 3)} GHz, under 3 × f0`);
  } else if (cap.type === 'trimmer') {
    const Lv = viaL({ d: via.d, h: sub.dielectric.h, n: via.n }).L, Cp = padC({ W: TRIMMER_FOOTPRINT.pads.w, L: TRIMMER_FOOTPRINT.pads.l, sub });
    const w = 2 * Math.PI * f0, Ls = TRIMMER_DEFAULTS.esl + Lv;
    const nomOf = (c) => { const x = c - Cp; return x / (1 + w * w * Ls * x); };
    const picks = {};
    for (const [k, c] of [['cl1', cl1], ['cl', cl]]) {
      const C = nomOf(c), t = pickTrimmer(C, f0);
      if (t.why) { warnings.push(`${k}: ${t.why}`); continue; }
      if (t.warn) warnings.push(t.warn);
      picks[k] = { C, t };
      setLine(new RegExp(`^\\.param ${k} = `), `.param ${k} = ${pF(C)} tune ${pF(t.Cmin)} ${pF(t.Cmax)}   # trimmer setting (${t.mpn}); ideal effective ${pF(c)}`);
    }
    want.forEach((_, i) => { const k = i === 0 || i === n - 1 ? 'cl1' : 'cl'; if (picks[k]) capLine(i, `C=${k} type=trimmer mpn=${picks[k].t.mpn} d=${fmt(via.d * 1e3, 3)}mm n=${via.n}`); });
    report.push(`# loading capacitors: Murata trimmers on ${sub.id}: ${Object.entries(picks).map(([k, p]) => `${k} ${p.t.mpn} (${fmt(p.t.Cmin * 1e12, 3)}–${fmt(p.t.Cmax * 1e12, 3)} pF)`).join(', ')}; ESL ${TRIMMER_DEFAULTS.esl * 1e9} nH and Q ${TRIMMER_DEFAULTS.Q} assumed (not published)`);
  } else if (cap.type === 'printed') {
    const pr = printedRange({ sub, f: f0 });
    for (const [k, c] of [['cl1', cl1], ['cl', cl]]) if (c > pr.Cmax) warnings.push(`${k} = ${pF(c)}F is more than a printed pad can give on ${sub.id} at ${fmt(f0 / 1e9, 4)} GHz (≤ ${pF(pr.Cmax)}F, ${fmt(pr.aMax, 3)} mm square): use SMD or a thinner substrate`);
    want.forEach((_, i) => capLine(i, `C=${i === 0 || i === n - 1 ? 'cl1' : 'cl'} type=printed`));
    report.push(`# loading capacitors: printed square pads to ground on ${sub.id}; at f0 they reach ${pF(pr.Cmin)}F (0.5 mm) to ${pF(pr.Cmax)}F (${fmt(pr.aMax, 3)} mm)`);
  } else throw new Error(`unknown capacitor type ${cap.type}`);

  // insertion-loss estimate from the capacitor Q alone (resonator Qu ≈ Qcap is pessimistic: the lines
  // store part of the energy): ΔIL ≈ 4.343 Σg / (FBW · Q)
  const Qc = cap.type === 'smd' ? (cap.Q ?? 300) : cap.type === 'trimmer' ? TRIMMER_DEFAULTS.Q : null;
  if (Qc) {
    const sg = r.g.slice(1, n + 1).reduce((a, b) => a + b, 0), fbw = (r.spec.target ?? r.spec).fbw;
    const il = 4.343 * sg / (fbw * Qc);
    report.push(`# insertion loss from capacitor Q = ${Qc}${cap.type === 'trimmer' ? ' (assumed: Murata specifies Q only at 1 MHz)' : ''}: up to ≈ ${fmt(il, 3)} dB (4.343 Σg / (FBW·Q))`);
    if (il > 1) warnings.push(`capacitor Q ${Qc} costs up to ≈ ${fmt(il, 3)} dB of insertion loss at ${fmt(fbw * 100, 3)} % bandwidth`);
  }
  // report lines go after the title comments
  const at = L.findIndex(x => x.startsWith('.freq'));
  L.splice(at, 0, ...report, ...warnings.map(w => `# WARNING: ${w}`));
  return { text: L.join('\n'), report, warnings };
}
