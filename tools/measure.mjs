// Measurement helpers used to produce the numbers quoted in docs/.
// node tools/measure.mjs FILE 'trace' [at F] [band OP LEVEL] [min|max F1 F2]
import { readFileSync } from 'node:fs';
import { parseNetlist } from '../js/netlist.js';
import { solve } from '../js/solver.js';
import { parseExpr, evalTrace } from '../js/expr.js';

export function load(file, overrides = {}, freqOverride) {
  let text = readFileSync(file, 'utf8');
  if (freqOverride) text = text.replace(/^\.freq .*$/m, `.freq ${freqOverride}`);
  const d = parseNetlist(text, overrides);
  const r = solve(d);
  const ctx = { n: r.freq.length, freq: r.freq, S: (i, j) => r.S(i, j), scope: d.scope };
  const tr = (src) => evalTrace(parseExpr(src), ctx).re;
  return { d, r, tr, F: r.freq };
}
export function at(F, y, f) { // linear interpolation
  for (let k = 1; k < F.length; k++) if (F[k] >= f) { const t = (f - F[k - 1]) / (F[k] - F[k - 1]); return y[k - 1] + t * (y[k] - y[k - 1]); }
  return NaN;
}
// contiguous band around fc where pred(y) holds; returns [f1, f2] interpolated
export function band(F, y, fc, pred) {
  let k = F.findIndex(f => f >= fc);
  if (!pred(y[k])) return null;
  let a = k, b = k;
  while (a > 0 && pred(y[a - 1])) a--;
  while (b < F.length - 1 && pred(y[b + 1])) b++;
  return [F[a], F[b]];
}
export function extreme(F, y, f1, f2, kind = 'max') {
  let best = kind === 'max' ? -Infinity : Infinity, fb = NaN;
  for (let k = 0; k < F.length; k++) if (F[k] >= f1 && F[k] <= f2) if (kind === 'max' ? y[k] > best : y[k] < best) { best = y[k]; fb = F[k]; }
  return [best, fb];
}
