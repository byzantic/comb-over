// Microstrip model tests.  Run: node tests/microstrip.mjs
import { readFileSync } from 'node:fs';
import { msline, mscoupled, mslineLoss, mscoupledLoss, synthMsline, synthMscoupled, fabCheck, fromSubstrate, alphaDielectric, ETA0, C0 } from '../js/microstrip.js';
import { makeSubstrate } from '../js/substrates.js';

let pass = 0, fail = 0;
const check = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };
const rel = (a, b) => Math.abs(a / b - 1);
const data = (f) => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url)));

// ---- single line vs scikit-rf (independent implementation of the same published models) ----
{
  const { cases } = data('skrf-msline-ref.json');
  let zs = 0, es = 0, zd = 0, ed = 0, ac = 0;
  for (const c of cases) {
    const s = msline({ W: c.W, h: c.h, t: c.t, er: c.er });
    zs = Math.max(zs, rel(s.Z0, c.Zs)); es = Math.max(es, rel(s.epsEff, c.es));
    c.f.forEach((f, k) => {
      const d = msline({ W: c.W, h: c.h, t: c.t, er: c.er, f });
      zd = Math.max(zd, rel(d.Z0, c.Z[k])); ed = Math.max(ed, rel(d.epsEff, c.e[k]));
      if (c.t > 0) ac = Math.max(ac, rel(mslineLoss({ W: c.W, h: c.h, t: c.t, er: c.er, f, model: 'hammerstad' }).alphaC, c.ac[k]));
    });
  }
  check(`Hammerstad–Jensen static Z0, εeff match scikit-rf (${cases.length} cases)`, zs < 1e-8 && es < 1e-8, `${zs} ${es}`);
  check('Kirschning–Jansen dispersive Z0, εeff match scikit-rf (0.5–30 GHz)', zd < 1e-4 && ed < 1e-8, `${zd} ${ed}`);
  check('Hammerstad conductor-loss option matches scikit-rf', ac < 1e-6, ac);
}

// ---- Wheeler conductor loss vs Pucel–Massé–Hartwig narrow-strip formula (W/h ≤ 1/2π) ----
{
  const h = 1.53e-3, W = 0.1 * h, t = 35e-6, er = 4.5, f = 2e9, sigma = 5.8e7;
  const Rs = Math.sqrt(Math.PI * f * 4e-7 * Math.PI / sigma);
  const Z0 = msline({ W, h, t, er, f }).Z0;
  const We = W + t / Math.PI * (1 + Math.log(4 * Math.PI * W / t));
  const pmh = Rs / (2 * Math.PI * Z0 * h) * (1 - (We / (4 * h)) ** 2) * (1 + h / We + h / (Math.PI * We) * (Math.log(4 * Math.PI * W / t) + t / W));
  const mine = mslineLoss({ W, h, t, er, f }).alphaC;
  let worst = rel(mine, pmh);
  for (const [er2, h2] of [[3.66, 0.508e-3], [3.66, 1.524e-3], [9.8, 0.508e-3], [9.8, 1.524e-3]]) {
    const W2 = 0.1 * h2, Z = msline({ W: W2, h: h2, t, er: er2, f }).Z0, We2 = W2 + t / Math.PI * (1 + Math.log(4 * Math.PI * W2 / t));
    const p = Rs / (2 * Math.PI * Z * h2) * (1 - (We2 / (4 * h2)) ** 2) * (1 + h2 / We2 + h2 / (Math.PI * We2) * (Math.log(4 * Math.PI * W2 / t) + t / W2));
    worst = Math.max(worst, rel(mslineLoss({ W: W2, h: h2, t, er: er2, f }).alphaC, p));
  }
  check('Wheeler conductor loss within 3 % of Pucel–Massé–Hartwig at W/h = 0.1 (five substrates)', worst < 0.03, worst);
  const wide = mslineLoss({ W: 8 * h, h, t, er, f }).alphaC, Zw = msline({ W: 8 * h, h, t, er, f }).Z0;
  check('wide strip: Wheeler loss is below the parallel-plate bound Rs/(Z0 W)', wide < Rs / (Zw * 8 * h) && wide > 0.6 * Rs / (Zw * 8 * h));
}

// ---- dielectric loss: full filling limit and scaling ----
{
  const f = 5e9, er = 3.66, tand = 0.0037;
  check('αd → π f √εr tanδ / c when εeff = εr', rel(alphaDielectric(f, er, er, tand), Math.PI * f * Math.sqrt(er) * tand / C0) < 1e-12);
  const L = mslineLoss({ W: 1.1e-3, h: 0.508e-3, t: 35e-6, er, tand, f });
  check('Qd = 1/(q·tanδ) with filling factor q = εr(εeff−1)/(εeff(εr−1))', (() => { const e = msline({ W: 1.1e-3, h: 0.508e-3, t: 35e-6, er, f }).epsEff; const q = er * (e - 1) / (e * (er - 1)); return rel(L.Qd, 1 / (q * tand)) < 1e-9; })());
  check('Q = 1/(1/Qc + 1/Qd)', rel(L.Q, 1 / (1 / L.Qc + 1 / L.Qd)) < 1e-12);
}

// ---- coupled pair vs Qucsator (independent implementation of Kirschning–Jansen), t = 0 ----
{
  const { cases } = data('kj-coupled-static-ref.json');
  let w = 0;
  for (const c of cases) {
    const m = mscoupled({ W: c.W, S: c.S, h: c.h, er: c.er });
    w = Math.max(w, rel(m.Ze, c.Ze), rel(m.Zo, c.Zo), rel(m.epse, c.epse), rel(m.epso, c.epso));
  }
  check(`Kirschning–Jansen static even/odd Z, εeff match Qucsator (${cases.length} cases, εr 2.2–16, W/h & S/h 0.1–10)`, w < 1e-9, w);
}

// ---- coupled pair: published example (Steer, Microwave and RF Design II, Example 5.6.1; graph readings) ----
{
  const m = mscoupled({ W: 0.5e-3, S: 0.25e-3, h: 0.5e-3, er: 10 });
  const s = msline({ W: 0.5e-3, h: 0.5e-3, er: 10 });
  const ok = rel(m.Ze, 59) < 0.02 && rel(m.Zo, 37) < 0.02 && rel(m.epse, 7.28) < 0.02 && rel(m.epso, 5.82) < 0.02 && rel(s.Z0, 48.6) < 0.02 && rel(s.epsEff, 6.71) < 0.02;
  check('alumina example (u = 1, g = 0.5, εr = 10) within 2 % of published graph readings', ok, JSON.stringify([m.Ze, m.Zo, m.epse, m.epso, s.Z0, s.epsEff]));
}

// ---- coupled limits and dispersion consistency ----
{
  const h = 0.508e-3, er = 3.66, W = 1.1e-3;
  const s = msline({ W, h, er });
  const far = mscoupled({ W, S: 10 * h, h, er });
  check('widely spaced pair (S = 10h): even/odd → single line within 1 %', rel(far.Ze, s.Z0) < 0.01 && rel(far.Zo, s.Z0) < 0.01 && rel(far.epse, s.epsEff) < 0.01 && rel(far.epso, s.epsEff) < 0.01,
    JSON.stringify([far.Ze, far.Zo, s.Z0]));
  const f = 20e9, sd = msline({ W, h, er, f }), fd = mscoupled({ W, S: 10 * h, h, er, f });
  const r1 = sd.epsEff / s.epsEff, re = fd.epse / far.epse, ro = fd.epso / far.epso;
  check('widely spaced pair: even/odd εeff dispersion matches the single line within 0.5 %', rel(re, r1) < 0.005 && rel(ro, r1) < 0.005, `${r1} ${re} ${ro}`);
  const near = mscoupled({ W, S: 0.2 * h, h, er, f: 10e9 });
  check('dispersion raises εeff for both modes (f = 10 GHz)', near.epse > near.epse_static && near.epso > near.epso_static && near.epse < er && near.epso < er);
  const thin = mscoupled({ W, S: 0.5e-3, h, er }), thick = mscoupled({ W, S: 0.5e-3, h, er, t: 35e-6 });
  check('finite strip thickness lowers both mode impedances', thick.Ze < thin.Ze && thick.Zo < thin.Zo && thick.Zo / thin.Zo < thick.Ze / thin.Ze);
  const st = msline({ W, h, er, t: 35e-6 }), ft = mscoupled({ W, S: 10 * h, h, er, t: 35e-6 });
  check('thick widely spaced pair → thick single line within 1.5 %', rel(ft.Ze, st.Z0) < 0.015 && rel(ft.Zo, st.Z0) < 0.015, JSON.stringify([ft.Ze, ft.Zo, st.Z0]));
}

// ---- coupled losses ----
{
  const L = mscoupledLoss({ W: 1.1e-3, S: 0.2e-3, h: 0.508e-3, t: 35e-6, er: 3.66, tand: 0.0037, f: 5e9 });
  check('coupled-mode losses: odd mode lossier than even (current crowding in the gap)', L.odd.alphaC > L.even.alphaC && L.odd.Q < L.even.Q);
  const far = mscoupledLoss({ W: 1.1e-3, S: 5.08e-3, h: 0.508e-3, t: 35e-6, er: 3.66, f: 5e9 });
  const single = mslineLoss({ W: 1.1e-3, h: 0.508e-3, t: 35e-6, er: 3.66, f: 5e9 });
  check('widely spaced pair: modal conductor loss → single-line value within 5 %', rel(far.even.alphaC, single.alphaC) < 0.05 && rel(far.odd.alphaC, single.alphaC) < 0.05,
    JSON.stringify([far.even.alphaC, far.odd.alphaC, single.alphaC]));
}

// ---- synthesis ----
{
  const sub = fromSubstrate(makeSubstrate('jlc-ro4350b-0.508'));
  const s = synthMsline({ Z0: 50, ...sub });
  check('single-line synthesis round-trips (50 Ω on RO4350B 0.508 mm)', rel(msline({ W: s.W, ...sub }).Z0, 50) < 1e-9, s.W);
  check('50 Ω on RO4350B 0.508 mm with 35 µm copper is about 1.1 mm wide', s.W > 1.0e-3 && s.W < 1.2e-3, s.W);
  const sd = synthMsline({ Z0: 50, ...sub, f: 10e9 });
  check('synthesis at a frequency uses the dispersive Z0', rel(msline({ W: sd.W, ...sub, f: 10e9 }).Z0, 50) < 1e-9);
  const c = synthMscoupled({ Ze: 69.4, Zo: 36.0, ...sub });
  const back = mscoupled({ W: c.W, S: c.S, ...sub });
  check('coupled synthesis round-trips (10 dB coupler, Ze 69.4 / Zo 36.0 Ω)', c.converged && rel(back.Ze, 69.4) < 1e-6 && rel(back.Zo, 36.0) < 1e-6, JSON.stringify([c.W, c.S, back.Ze, back.Zo]));
  const fr4 = fromSubstrate(makeSubstrate('jlc-fr4-1.6'));
  const c2 = synthMscoupled({ Ze: 80, Zo: 35, ...fr4 });
  check('coupled synthesis on FR-4 1.6 mm', c2.converged && rel(mscoupled({ W: c2.W, S: c2.S, ...fr4 }).Ze, 80) < 1e-6);
  const tight = synthMscoupled({ Ze: 120.7, Zo: 20.7, ...sub });
  const fab = fabCheck(tight, makeSubstrate('jlc-ro4350b-0.508'));
  check('3 dB edge-coupled pair is flagged as unrealisable', !tight.converged || fab.length > 0 || tight.warnings.length > 0, JSON.stringify({ S: tight.S, conv: tight.converged, fab, w: tight.warnings }));
  check('impossible single-line target throws', (() => { try { synthMsline({ Z0: 5000, ...sub }); return false; } catch { return true; } })());
}

// ---- validity warnings ----
{
  check('W/h out of range is warned', msline({ W: 1e-6, h: 1e-3, er: 4 }).warnings.length > 0);
  check('coupled S/h out of range is warned', mscoupled({ W: 1e-3, S: 0.01e-3, h: 1e-3, er: 4 }).warnings.some(w => /S\/h/.test(w)));
  check('thin copper (t < 3δ) warned in loss', mslineLoss({ W: 1e-3, h: 0.5e-3, t: 1e-6, er: 4, f: 1e9 }).warnings.some(w => /skin/.test(w)));
  check('bad input rejected', (() => { try { msline({ W: -1, h: 1, er: 4 }); return false; } catch { return true; } })());
  check('ETA0 constant', rel(ETA0, 4e-7 * Math.PI * C0) < 1e-9);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
