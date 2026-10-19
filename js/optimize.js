// Goal-driven optimisation of "tune" parameters (Nelder–Mead on a box-normalised space).
import { parseNetlist } from './netlist.js';
import { attachData } from './data.js';
import { solve, frequencies } from './solver.js';
import { evalTrace } from './expr.js';

// Frequencies used during optimisation: sweep points inside each goal band, decimated per goal
// (≤ perGoal points each) so that a wide stopband goal cannot starve a narrow passband goal.
function goalFreqs(d, perGoal = 121) {
  const all = Array.from(frequencies(d.freq));
  const set = new Set();
  for (const g of d.goals) {
    const pts = all.filter(f => f >= g.f1 && f <= g.f2);
    const step = Math.max(1, pts.length / perGoal);
    for (let i = 0; i < pts.length; i += step) set.add(pts[Math.floor(i)]);
    if (pts.length) set.add(pts[pts.length - 1]);
  }
  return Float64Array.from([...set].sort((a, b) => a - b));
}

// Cost of a solved design. Each goal contributes w·(mean(v²) + max(v)²) where v is the violation.
export function goalCost(d, res, data = null) {
  const ctx = { n: res.freq.length, freq: res.freq, S: (i, j) => res.S(i, j), scope: d.scope, data };
  let cost = 0;
  const report = [];
  for (const g of d.goals) {
    const v = evalTrace(g.ast, ctx).re;
    let sum = 0, mx = 0, cnt = 0, worst = NaN;
    for (let k = 0; k < ctx.n; k++) {
      const f = res.freq[k];
      if (f < g.f1 || f > g.f2) continue;
      let e = g.op === '<' ? Math.max(0, v[k] - g.value) : g.op === '>' ? Math.max(0, g.value - v[k]) : v[k] - g.value;
      if (!isFinite(e)) e = 1e3;
      sum += e * e; mx = Math.max(mx, Math.abs(e)); cnt++;
      if (!(Math.abs(worst - g.value) >= Math.abs(v[k] - g.value))) worst = v[k];
    }
    const c = cnt ? g.w * (sum / cnt + mx * mx) : 0;
    cost += c;
    report.push({ goal: g, maxViolation: mx, cost: c });
  }
  return { cost, report };
}

// Generator: yields {iter, cost, best:{name:value}} periodically; returns final.
export function* optimise(text, { maxiter, files = null, freqs: freqsIn = null } = {}) {
  const base = parseNetlist(text);
  const tuned = base.params.filter(p => p.tune);
  if (!tuned.length) throw new Error('no ".param … tune lo hi" parameters to optimise');
  if (!base.goals.length) throw new Error('no .goal statements');
  maxiter = maxiter ?? base.opt.maxiter ?? 400;
  const freqs = freqsIn ?? goalFreqs(base);                   // an explicit list (e.g. dense only where it matters)
  if (!freqs.length) throw new Error('no sweep points fall inside the goal frequency ranges');
  const data = attachData(base, freqs, files).data;          // imported S-parameters on the goal points (#17)
  const n = tuned.length;
  // normalised coordinate u ∈ [0,1]; log mapping when range spans > 1 decade with lo > 0
  const map = tuned.map(p => ({ name: p.name, lo: p.tune.lo, hi: p.tune.hi, log: p.tune.lo > 0 && p.tune.hi / p.tune.lo > 10 }));
  const toVal = (u) => Object.fromEntries(map.map((m, i) => {
    const t = Math.min(1, Math.max(0, u[i]));
    return [m.name, m.log ? m.lo * (m.hi / m.lo) ** t : m.lo + (m.hi - m.lo) * t];
  }));
  const toU = (p) => map.map(m => { const v = p[m.name]; return m.log ? Math.log(v / m.lo) / Math.log(m.hi / m.lo) : (v - m.lo) / (m.hi - m.lo); });
  let evals = 0;
  const f = (u) => {
    evals++;
    let pen = 0; for (const x of u) { if (x < 0) pen += x * x * 1e3; if (x > 1) pen += (x - 1) ** 2 * 1e3; }
    try {
      const d = parseNetlist(text, toVal(u));
      return goalCost(d, solve(d, freqs), data).cost + pen;
    } catch { return 1e12; }
  };
  const start = toU(Object.fromEntries(tuned.map(p => [p.name, p.value]))).map(x => Math.min(1, Math.max(0, x)));
  // initial simplex
  let simplex = [start];
  for (let i = 0; i < n; i++) { const v = start.slice(); v[i] += v[i] < 0.9 ? 0.08 : -0.08; simplex.push(v); }
  let fs = simplex.map(f);
  for (let it = 0; it < maxiter; it++) {
    const order = fs.map((_, i) => i).sort((a, b) => fs[a] - fs[b]);
    simplex = order.map(i => simplex[i]); fs = order.map(i => fs[i]);
    if (it % 5 === 0) yield { iter: it, evals, cost: fs[0], best: toVal(simplex[0]) };
    if (fs[0] === 0) break;
    if (Math.abs(fs[n] - fs[0]) <= 1e-12 * (Math.abs(fs[0]) + 1e-12) && it > 10) {
      // restart around best to escape collapse
      const b = simplex[0];
      simplex = [b]; for (let i = 0; i < n; i++) { const v = b.slice(); v[i] += v[i] < 0.9 ? 0.02 : -0.02; simplex.push(v); }
      fs = simplex.map(f); continue;
    }
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j] / n;
    const pt = (a) => cen.map((c, j) => c + a * (simplex[n][j] - c));
    const xr = pt(-1), fr = f(xr);
    if (fr < fs[0]) {
      const xe = pt(-2), fe = f(xe);
      if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
    } else if (fr < fs[n - 1]) { simplex[n] = xr; fs[n] = fr; }
    else {
      const xc = fr < fs[n] ? pt(-0.5) : pt(0.5), fc = f(xc);
      if (fc < Math.min(fr, fs[n])) { simplex[n] = xc; fs[n] = fc; }
      else { for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j])); fs[i] = f(simplex[i]); } }
    }
  }
  const i0 = fs.indexOf(Math.min(...fs));
  return { iter: maxiter, evals, cost: fs[i0], best: toVal(simplex[i0]), done: true };
}

// Write tuned values back into the netlist text (".param name = value tune lo hi").
export function writeBack(text, values) {
  return text.split('\n').map(line => {
    const m = /^(\s*\.param\s+)([A-Za-z_]\w*)(\s*=\s*)(.*?)(\s+tune\s+\S+\s+\S+.*)?$/i.exec(line);
    if (!m || !(m[2] in values) || !m[5]) return line;
    return `${m[1]}${m[2]}${m[3]}${fmtSI(values[m[2]])}${m[5]}`;
  }).join('\n');
}

export function fmtSI(v, digits = 5) {
  if (v === 0 || !isFinite(v)) return String(v);
  const pre = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  const a = Math.abs(v);
  for (const [s, p] of pre) if (a >= s * 0.9999999) return +(v / s).toPrecision(digits) + p;
  return v.toExponential(digits - 1);
}
