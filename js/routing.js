// Routing (#37): orthogonal microstrip paths as copper and as netlist, and meandered lines.
//
//   routeOrtho(pts, { W, mitre, sub, name, a, b })
//       A polyline (mm) with 90° turns → the copper polygon (square or optimally mitred corners) and the
//       netlist lines that model it: `T` segments between the bends' reference planes (the edges of the
//       crossing strip, W/2 either side of the corner on the centre line) and a `bend` at each corner.
//   meander({ W, theta, f0, sub, legs, gap, mitre, name, a, b })
//       A square-wave meander of `legs` vertical legs (even, so it enters and leaves on one axis) whose
//       electrical length at f0, bends included, is theta degrees: the leg height is solved on the netlist.
//       The coupling between neighbouring legs is not modelled; it is estimated from the coupled-pair
//       even/odd impedances at the leg gap and reported (a warning below a gap of 2W).
// Lengths in mm in and out (the netlist lines carry mm); the substrate object is SI, as elsewhere.
import { bendLC } from './discontinuities.js';
import { msline, mscoupled } from './microstrip.js';
import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';

const r6 = (x) => +x.toFixed(6);
const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l, l]; };

/** Merge collinear runs, check that every turn is ±90°. Returns { pts, dirs: [[ux, uy, len], …] }. */
function orthogonal(pts0) {
  const pts = [pts0[0]];
  for (let i = 1; i < pts0.length; i++) {
    const p = pts0[i], q = pts[pts.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9) continue;
    if (pts.length >= 2) {
      const [ux, uy] = unit(pts[pts.length - 2], q), [vx, vy] = unit(q, p);
      if (Math.abs(ux * vy - uy * vx) < 1e-9 && ux * vx + uy * vy > 0) { pts[pts.length - 1] = p; continue; }   // straight on
    }
    pts.push(p);
  }
  if (pts.length < 2) throw new Error('route: needs at least two distinct points');
  const dirs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = unit(pts[i], pts[i + 1]);
    if (Math.abs(d[0]) > 1e-9 && Math.abs(d[1]) > 1e-9) throw new Error(`route: segment ${i + 1} is not horizontal or vertical (only 90° bends are modelled)`);
    if (i > 0 && Math.abs(d[0] * dirs[i - 1][0] + d[1] * dirs[i - 1][1]) > 1e-9) throw new Error(`route: the path doubles back at point ${i + 1}`);
    dirs.push(d);
  }
  return { pts, dirs };
}

export function routeOrtho(pts0, { W, mitre = 'none', sub, name = 'R', a = 'a', b = 'b' }) {
  if (!(W > 0)) throw new Error('route: W must be > 0');
  const { pts, dirs } = orthogonal(pts0), h = W / 2, nb = pts.length - 2;
  const bend = nb > 0 ? bendLC({ W: W / 1e3, h: sub.dielectric.h, er: sub.dielectric.er, mitre }) : null;
  const cut = bend ? 2 * bend.mitre * W : 0;            // mitre: the cut is x = M·W√2 from the outer corner, 2MW along each edge
  // copper: offset lines, outer corners cut for the mitre
  const L = [], R = [], nrm = ([ux, uy]) => [-uy, ux];
  const n0 = nrm(dirs[0]), nN = nrm(dirs[dirs.length - 1]);
  L.push([pts[0][0] + n0[0] * h, pts[0][1] + n0[1] * h]); R.push([pts[0][0] - n0[0] * h, pts[0][1] - n0[1] * h]);
  for (let i = 1; i <= nb; i++) {
    const d1 = dirs[i - 1], d2 = dirs[i], n1 = nrm(d1), n2 = nrm(d2), v = pts[i];
    const pl = [v[0] + (n1[0] + n2[0]) * h, v[1] + (n1[1] + n2[1]) * h], pr = [v[0] - (n1[0] + n2[0]) * h, v[1] - (n1[1] + n2[1]) * h];
    const left = d1[0] * d2[1] - d1[1] * d2[0] > 0;     // left turn: the right side is outside
    const chop = (o) => [[o[0] - d1[0] * cut, o[1] - d1[1] * cut], [o[0] + d2[0] * cut, o[1] + d2[1] * cut]];
    if (cut > 0 && left) { L.push(pl); R.push(...chop(pr)); } else if (cut > 0) { L.push(...chop(pl)); R.push(pr); } else { L.push(pl); R.push(pr); }
  }
  const e = pts[pts.length - 1];
  L.push([e[0] + nN[0] * h, e[1] + nN[1] * h]); R.push([e[0] - nN[0] * h, e[1] - nN[1] * h]);
  const poly = [...L, ...R.reverse()].map(([x, y]) => [r6(x), r6(y)]);
  // netlist: segment lengths between reference planes
  const lines = [], segLen = [];
  let node = a;
  for (let i = 0; i < dirs.length; i++) {
    const len = dirs[i][2] - (i > 0 ? h : 0) - (i < dirs.length - 1 ? h : 0);
    if (len < -1e-9) throw new Error(`route: segment ${i + 1} (${r6(dirs[i][2])} mm) is shorter than its bends need (${r6(dirs[i][2] - len)} mm)`);
    segLen.push(Math.max(len, 0));
    const end = i === dirs.length - 1 ? b : `${name}_${i + 1}e`;
    if (len > 1e-9) lines.push(`T${name}_${i + 1} ${node} ${end} W=${r6(W)}mm len=${r6(len)}mm`);
    else lines.push(`wire ${node} ${end}`);
    if (i < dirs.length - 1) { const nx = `${name}_${i + 2}s`; lines.push(`bend ${name}_B${i + 1} ${end} ${nx} W=${r6(W)}mm mitre=${mitre}`); node = nx; }
  }
  return { pts, poly, lines, segLen, bends: nb, mitreCut: cut, warnings: bend ? bend.warnings : [] };
}

// unwrapped transmission phase (degrees, positive for delay) at f0 of a two-port netlist body, ports at Z
function phaseAt(body, sub, f0, Z) {
  const r = solve(parseNetlist(`.freq ${f0 / 40} ${f0} 40\n.ref ${f0}\n.substrate ${sub.id}\nport a ${Z}\nport b ${Z}\n${body}\n`)), s = r.S(2, 1);
  let prev = 0, acc = 0;
  for (let k = 0; k < r.freq.length; k++) {
    const ph = Math.atan2(s.im[k], s.re[k]);
    let dp = ph - prev; dp -= 2 * Math.PI * Math.round(dp / (2 * Math.PI)); acc += dp; prev = ph;
  }
  return { deg: -acc * 180 / Math.PI, s11: Math.hypot(r.S(1, 1).re.at(-1), r.S(1, 1).im.at(-1)) };
}

export function meander({ W, theta, f0, sub, legs = 4, gap, mitre = 'opt', name = 'M', a = 'a', b = 'b' }) {
  if (!sub?.id) throw new Error('meander: needs a substrate preset (sub.id)');
  if (!(legs >= 2) || legs % 2) throw new Error('meander: legs must be even (≥ 2), so the line enters and leaves on one axis');
  gap ??= 3 * W;
  const p = W + gap, warnings = [];
  const Z = msline({ W: W / 1e3, h: sub.dielectric.h, er: sub.dielectric.er, t: sub.copper.t, f: f0 }).Z0;
  const path = (H) => {
    const pts = [[0, 0]]; let x = p / 2, up = true;
    for (let i = 0; i < legs; i++) { pts.push([x, up ? 0 : H], [x, up ? H : 0]); x += p; up = !up; }
    pts.push([x - p / 2, 0]);
    return pts;
  };
  const thetaOf = (H) => phaseAt(routeOrtho(path(H), { W, mitre, sub, name, a: 'a', b: 'b' }).lines.join('\n'), sub, f0, Z);
  // secant on the leg height, from the straight-line estimate
  const eps = msline({ W: W / 1e3, h: sub.dielectric.h, er: sub.dielectric.er, t: sub.copper.t, f: f0 }).epsEff;
  const total = theta / 360 * 299792458 / Math.sqrt(eps) / f0 * 1e3;          // mm of straight line
  const Hmin = W + 1e-3;                                                     // the vertical legs must clear both bends
  // θ rises monotonically with the leg height: bracket it, then secant steps kept inside the bracket
  let lo = Hmin, tlo = thetaOf(lo).deg;
  if (tlo > theta) throw new Error(`meander: ${legs} legs at a ${r6(gap)} mm gap are already longer than ${theta}° even at the minimum leg height; use fewer legs`);
  let hi = Math.max((total - legs * p) / legs, 2 * Hmin), thi = thetaOf(hi).deg;
  for (let i = 0; thi < theta; i++) { if (i > 40) throw new Error('meander: could not bracket the leg height'); lo = hi; tlo = thi; hi *= 2; thi = thetaOf(hi).deg; }
  let H1 = hi, t1 = thi;
  for (let it = 0; it < 60 && Math.abs(t1 - theta) > 1e-6 && hi - lo > 1e-9; it++) {
    let H = lo + (theta - tlo) * (hi - lo) / (thi - tlo);
    if (!(H > lo && H < hi) || it % 3 === 2) H = (lo + hi) / 2;            // bisect now and then, and when the secant leaves the bracket
    H1 = H; t1 = thetaOf(H).deg;
    if (t1 < theta) { lo = H; tlo = t1; } else { hi = H; thi = t1; }
  }
  if (Math.abs(t1 - theta) > 1e-3) throw new Error('meander: leg height did not converge');
  const rt = routeOrtho(path(H1), { W, mitre, sub, name, a, b });
  // neighbouring-leg coupling (not modelled): coupled-pair coefficient at the gap
  const c = mscoupled({ W: W / 1e3, S: gap / 1e3, h: sub.dielectric.h, er: sub.dielectric.er, t: sub.copper.t, f: f0 });
  const k = (c.Ze - c.Zo) / (c.Ze + c.Zo);
  if (gap < 2 * W) warnings.push(`meander leg gap ${r6(gap)} mm is under 2W: neighbouring legs couple (k ≈ ${k.toFixed(3)}), which is not modelled`);
  return { ...rt, H: r6(H1), theta: t1, Z0: Z, k, size: [r6(legs * p), r6(H1 + W)], warnings: [...rt.warnings, ...warnings], s11: thetaOf(H1).s11 };
}
