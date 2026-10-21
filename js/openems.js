// openEMS export (issue #16): a layout as a self-contained openEMS/CSXCAD Python script, for full-wave
// verification, and the netlist to compare it with.
//
// The EM model: the board's copper as it is laid out — the part, its feeds (straight, without the edge
// connectors: the layout is rebuilt with connector=none), part pads — as conducting sheets of the
// copper's conductivity and thickness on the substrate (εr, and tan δ as a conductivity at the centre
// frequency); grounding vias as PEC cylinders; chip resistors and capacitors as lumped R / C between
// their pads (the capacitors' ESL is left out); a PEC ground under the substrate. No top-side pour and no
// stitching vias, as in comb-over's own model. Each port is an openEMS microstrip port on the outer end
// of its feed (length Lp = max(3 mm, 2 W) from the board edge, within the feed), its measurement plane at
// the port's inner end.
//
// The comparison netlist is the as-built netlist of that same layout with each feed shortened by Lp, so
// both sit at the same reference planes; it overlays the openEMS Touchstone result (.data … overlay).
//
// Mesh (mm): fixed lines on every copper edge (two lines straddling it, `fine` apart) and vertex, then
// graded at ratio 1.4 to at most λ/20 in the substrate at the highest frequency; z: `nz` cells through the
// substrate, graded into air up to 8h above it. Boundaries: PEC ground below, PML (8 cells) on every
// other side — at the ports' ends the feeds run into it.
import { parseNetlist } from './netlist.js';
import { buildLayout } from './layout-templates.js';

const C0 = 299792458, EPS0 = 8.8541878128e-12;
const r6 = (x) => +x.toFixed(6);

// sorted, merged fixed lines → graded mesh (ratio, max step)
function smooth(fixed, maxStep, ratio = 1.4, minStep = 0) {
  const L = [...new Set(fixed.map(r6))].sort((a, b) => a - b);
  const merged = [];
  for (const x of L) if (!merged.length || x - merged.at(-1) > minStep) merged.push(x);
  const out = [merged[0]];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1], b = merged[i], gap = b - a;
    if (gap <= maxStep) { out.push(b); continue; }
    // grow from both ends: left step sl (the previous step), right step sr (the next one)
    const sl = i > 1 ? Math.min(maxStep, merged[i - 1] - merged[i - 2]) : maxStep, sr = i < merged.length - 1 ? Math.min(maxStep, merged[i + 1] - merged[i]) : maxStep;
    const fill = []; let x = a, y = b, dl = sl, dr = sr;
    const left = [], right = [];
    for (let guard = 0; guard < 10000; guard++) {
      dl = Math.min(dl * ratio, maxStep); dr = Math.min(dr * ratio, maxStep);
      if (y - x <= Math.max(dl, dr)) break;
      if (dl <= dr) { x += dl; left.push(x); } else { y -= dr; right.unshift(y); }
    }
    fill.push(...left, ...right);
    // spread what is left evenly if the middle gap is too wide
    out.push(...fill.map(r6), b);
  }
  return out;
}

/**
 * Build the openEMS script for a netlist with a .layout. opts: { fmin, fmax (Hz; default the netlist's
 * .freq), Lp (mm, port length; default max(3, 2 W) within the feed), fine (mm; default a third of the smallest copper
 * width or gap, ≥ 0.02), nz (substrate cells, 4), endCriteria (1e-4), excite ('all' or a port number) }.
 * Returns { script, compare, info }.
 */
export function openemsExport(text, opts = {}) {
  const d0 = parseNetlist(text);
  if (!d0.layout) throw new Error('openEMS export needs a .layout');
  // the layout with plain feeds to the board edge (no edge connectors)
  const d = { ...d0, layout: { ...d0.layout, opts: { ...(d0.layout.opts ?? {}), connector: 'none' } } };
  const L = buildLayout(d);
  if (L.errors.length) throw new Error(`openEMS export: the layout breaks design rules (${L.errors[0].msg})`);
  const sub = L.substrate, h = sub.dielectric.h * 1e3, er = sub.dielectric.er, tand = sub.dielectric.tand ?? 0, sigma = sub.copper.sigma ?? 5.8e7, t = sub.copper.t;
  const fmin = opts.fmin ?? d0.freq.start, fmax = opts.fmax ?? d0.freq.stop, fc = (fmin + fmax) / 2;
  const kappa = 2 * Math.PI * fc * EPS0 * er * tand;
  // copper: core, feeds and part pads
  const polys = L.items.filter(i => i.type === 'poly' && ['core', 'feed', 'part'].includes(i.role)).map(i => i.pts);
  const vias = L.items.filter(i => i.type === 'via').map(v => ({ x: v.x, y: v.y, r: v.drill / 2 }));
  // ports: on the straight outer end of each feed
  const feeds = L.items.filter(i => i.role === 'feed');
  const ports = d0.ports.map((p, k) => {
    const f = feeds.find(x => x.node === p.node);
    if (!f) throw new Error(`openEMS export: no feed for port ${p.node}`);
    const [e, q] = f.path, len = Math.hypot(q[0] - e[0], q[1] - e[1]), w = f.width;
    const ux = (q[0] - e[0]) / len, uy = (q[1] - e[1]) / len;
    if (Math.abs(ux) > 1e-9 && Math.abs(uy) > 1e-9) throw new Error(`openEMS export: the feed at ${p.node} does not leave along x or y`);
    const Lp = opts.Lp ?? Math.min(len - 0.5, Math.max(3, 2 * w));
    if (len < Lp + 0.5) throw new Error(`openEMS export: the feed at ${p.node} is ${r6(len)} mm, too short for a ${Lp} mm port (give the layout a longer feed=)`);
    const along = Math.abs(ux) > 0 ? 'x' : 'y', end = [e[0] + ux * Lp, e[1] + uy * Lp];
    const start = along === 'x' ? [e[0], e[1] - w / 2, h] : [e[0] - w / 2, e[1], h], stop = along === 'x' ? [end[0], e[1] + w / 2, 0] : [e[0] + w / 2, end[1], 0];
    return { n: k + 1, node: p.node, z: p.z, along, start, stop, Lp, w };
  });
  // lumped parts: R / C between the two pads
  const lumped = [];
  for (const pt of L.parts ?? []) {
    const pads = [1, 2].map(n => L.items.find(i => i.role === 'part' && i.label === `${pt.name} pad ${n}`));
    if (!pads[0] || !pads[1]) continue;
    const bb = (P) => ({ x0: Math.min(...P.map(q => q[0])), x1: Math.max(...P.map(q => q[0])), y0: Math.min(...P.map(q => q[1])), y1: Math.max(...P.map(q => q[1])) });
    const a = bb(pads[0].pts), b = bb(pads[1].pts);
    const cx = (x) => (x.x0 + x.x1) / 2, cy = (x) => (x.y0 + x.y1) / 2;
    const alongX = Math.abs(cx(a) - cx(b)) > Math.abs(cy(a) - cy(b));
    const [p, q] = alongX ? (cx(a) < cx(b) ? [a, b] : [b, a]) : (cy(a) < cy(b) ? [a, b] : [b, a]);
    const start = alongX ? [p.x1, Math.max(p.y0, q.y0), h] : [Math.max(p.x0, q.x0), p.y1, h];
    const stop = alongX ? [q.x0, Math.min(p.y1, q.y1), h] : [Math.min(p.x1, q.x1), q.y0, h];
    lumped.push({ name: pt.name, ny: alongX ? 0 : 1, R: pt.kind === 'res' ? pt.R : undefined, C: pt.kind === 'cap' ? pt.C : undefined, start, stop });
  }
  // mesh
  const xs = polys.flatMap(P => P.map(q => q[0])), ys = polys.flatMap(P => P.map(q => q[1]));
  const widths = L.items.filter(i => i.type === 'poly' && i.width > 0 && ['core', 'feed'].includes(i.role)).map(i => i.width);
  const minGap = (d0.sections ?? []).flatMap(s => (s.geom?.S != null ? [].concat(s.geom.S) : [])).map(x => x * 1e3);
  const fine = opts.fine ?? Math.max(0.02, Math.min(...widths, ...(minGap.length ? minGap : [Infinity])) / 3);
  const maxStep = C0 / fmax / Math.sqrt(er) / 20 * 1e3;
  const diag = Math.max(fine, Math.min(...widths) / 3);
  const fixX = [], fixY = [];
  for (const P of polys) for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (Math.abs(a[0] - b[0]) < 1e-9) fixX.push(a[0] - fine / 2, a[0] + fine / 2);
    else fixX.push(a[0]);
    if (Math.abs(a[1] - b[1]) < 1e-9) fixY.push(a[1] - fine / 2, a[1] + fine / 2);
    else fixY.push(a[1]);
    // a diagonal edge (45° escapes, mitres): lines along it every third of the narrowest strip, so the
    // staircase follows it
    if (Math.abs(a[0] - b[0]) > 1e-9 && Math.abs(a[1] - b[1]) > 1e-9) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.ceil(len / diag);
      for (let j = 1; j < k; j++) { fixX.push(a[0] + (b[0] - a[0]) * j / k); fixY.push(a[1] + (b[1] - a[1]) * j / k); }
    }
  }
  for (const v of vias) fixX.push(v.x - v.r, v.x + v.r), fixY.push(v.y - v.r, v.y + v.r);
  for (const p of ports) { fixX.push(p.start[0], p.stop[0]); fixY.push(p.start[1], p.stop[1]); }
  for (const l of lumped) { fixX.push(l.start[0], l.stop[0]); fixY.push(l.start[1], l.stop[1]); }
  // open sides: PML (8 cells) beyond a margin of 5h (≥ 3 mm), so the absorber stays clear of the fields
  const margin = Math.max(5 * h, 3) + 8 * maxStep;
  const bx = [Math.min(...xs), Math.max(...xs)], by = [Math.min(...ys), Math.max(...ys)];
  // the domain ends at the feeds' outer ends along their axis (the ports' PML), with a margin elsewhere
  const portX = ports.filter(p => p.along === 'x').map(p => p.start[0]), portY = ports.filter(p => p.along === 'y').map(p => p.start[1]);
  const X0 = portX.length && Math.min(...portX) <= bx[0] + 1e-9 ? bx[0] : bx[0] - margin, X1 = portX.length && Math.max(...portX) >= bx[1] - 1e-9 ? bx[1] : bx[1] + margin;
  const Y0 = portY.length && Math.min(...portY) <= by[0] + 1e-9 ? by[0] : by[0] - margin, Y1 = portY.length && Math.max(...portY) >= by[1] - 1e-9 ? by[1] : by[1] + margin;
  fixX.push(X0, X1); fixY.push(Y0, Y1);
  const clip = (a, lo, hi) => a.filter(x => x >= lo - 1e-9 && x <= hi + 1e-9);
  const X = clip(smooth(fixX, maxStep, 1.4, fine / 2), X0, X1), Y = clip(smooth(fixY, maxStep, 1.4, fine / 2), Y0, Y1);
  const nz = opts.nz ?? 4, Z = [];
  for (let i = 0; i <= nz; i++) Z.push(h * i / nz);
  for (let z = h, dz = h / nz; z < 9 * h + 8 * maxStep;) { dz = Math.min(dz * 1.3, maxStep); z += dz; Z.push(z); }
  const cells = (X.length - 1) * (Y.length - 1) * (Z.length - 1);
  const bc = ['x', 'y'].flatMap(ax => [0, 1].map(side => {
    const P = ports.filter(p => p.along === ax), at = ax === 'x' ? [X0, X1][side] : [Y0, Y1][side];
    return 'PML_8';
  }));
  bc.push('PEC', 'PML_8');
  const nPort = ports.length, exc = opts.excite && opts.excite !== 'all' ? [Number(opts.excite)] : ports.map(p => p.n);
  const name = (L.title || 'layout').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const J = (x) => JSON.stringify(x);
  const script = `#!/usr/bin/env python3
# openEMS model of "${L.title}" — generated by comb-over (issue #16). Run: python3 ${name}.py
# ${cells} cells (${X.length - 1} × ${Y.length - 1} × ${Z.length - 1}); excitations: ports ${exc.join(', ')}; writes ${name}.s${nPort}p next to this script.
# Copper: conducting sheets (${sigma} S/m, ${r6(t * 1e6)} um) on ${sub.id} (h ${h} mm, er ${er}, tan d ${tand} as kappa at ${r6(fc / 1e9)} GHz);
# vias PEC; ${lumped.length} lumped part(s); ports: openEMS MSL ports on the feeds, measurement planes ${ports.map(p => p.Lp).join('/')} mm in from the edge.
import os, sys
import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS

here = os.path.dirname(os.path.abspath(__file__))
unit = 1e-3
f_min, f_max = ${fmin}, ${fmax}
X = ${J(X)}
Y = ${J(Y)}
Z = ${J(Z.map(r6))}
POLYS = ${J(polys.map(P => P.map(q => q.map(r6))))}
VIAS = ${J(vias.map(v => [r6(v.x), r6(v.y), r6(v.r)]))}
PORTS = ${J(ports.map(p => ({ n: p.n, node: p.node, z: p.z, dir: p.along, start: p.start.map(r6), stop: p.stop.map(r6), Lp: p.Lp })))}
LUMPED = ${J(lumped.map(l => ({ ...l, start: l.start.map(r6), stop: l.stop.map(r6) })))}
BOX = ${J([X0, Y0, X1, Y1].map(r6))}
H, T, SIGMA, ER, KAPPA = ${h}, ${t}, ${sigma}, ${er}, ${kappa}
FINE = ${r6(fine)}

def model(exc):
    fdtd = openEMS(NrTS=${opts.nrts ?? 300000}, EndCriteria=${opts.endCriteria ?? 1e-4})
    # openEMS's Gaussian pulse (same envelope and delay) less its DC: a soft source with net charge leaves it
    # trapped in the substrate and the energy never decays to the end criterion
    f0, fc = (f_min + f_max) / 2, (f_max - f_min) / 2
    a = 2 * np.pi * fc / 3; t0 = 3 / a; k = np.exp(-(1.5 * f0 / fc) ** 2)
    fdtd.SetCustomExcite('(cos(2*pi*%.17g*(t-%.17g))-%.17g)*exp(-(((t-%.17g)*%.17g)^2))' % (f0, t0, k, t0, a), f_max, f_max)  # openEMS samples the probes at the Nyquist rate of its 2nd argument
    fdtd.SetBoundaryCond(${J(bc)})
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(unit)
    mesh.SetLines('x', X); mesh.SetLines('y', Y); mesh.SetLines('z', Z)
    sub = csx.AddMaterial('substrate', epsilon=ER, kappa=KAPPA)
    sub.AddBox([BOX[0], BOX[1], 0], [BOX[2], BOX[3], H], priority=0)
    cu = csx.AddConductingSheet('copper', conductivity=SIGMA, thickness=T)
    for P in POLYS:
        cu.AddPolygon(np.array(P).T, 'z', H, priority=10)
    pec = csx.AddMetal('pec')
    for (x, y, r) in VIAS:
        pec.AddCylinder([x, y, 0], [x, y, H], r, priority=10)
    for l in LUMPED:
        kw = {k: l[k] for k in ('R', 'C') if l.get(k) is not None}
        el = csx.AddLumpedElement(l['name'], ny=l['ny'], caps=True, **kw)
        el.AddBox(l['start'], l['stop'], priority=20)
    ports = []
    for p in PORTS:
        ports.append(fdtd.AddMSLPort(p['n'], pec, p['start'], p['stop'], p['dir'], 'z', excite=(1 if p['n'] == exc else 0),
                                     FeedShift=min(10 * FINE, p['Lp'] / 3), MeasPlaneShift=p['Lp'], Feed_R=p['z'], priority=20))
    return fdtd, ports

def run():
    f = np.linspace(f_min, f_max, 401)
    n = len(PORTS)
    S = np.full((len(f), n, n), np.nan, dtype=complex)
    for exc in ${J(exc)}:
        path = os.path.join(here, 'sim_p%d' % exc)
        fdtd, ports = model(exc)
        fdtd.Run(path, cleanup=True)
        for p in ports:
            p.CalcPort(path, f, ref_impedance=PORTS[0]['z'])
        a = ports[exc - 1].uf_inc
        for i, p in enumerate(ports):
            S[:, i, exc - 1] = p.uf_ref / a
    out = os.path.join(here, '${name}.s%dp' % n)
    with open(out, 'w') as fh:
        fh.write('! openEMS result for ${L.title.replace(/'/g, '')}\\n# Hz S RI R %g\\n' % PORTS[0]['z'])
        for k in range(len(f)):
            M = S[k].T if n == 2 else S[k]          # Touchstone: 2-ports S11 S21 S12 S22, else row by row
            vals = [v for row in M for v in row]
            vals = [0j if np.isnan(v) else v for v in vals]
            fh.write('%.9g ' % f[k] + ' '.join('%.9g %.9g' % (v.real, v.imag) for v in vals) + '\\n')
    print('wrote', out)

if __name__ == '__main__':
    run()
`;
  // the comparison netlist: as built with the feeds shortened to the measurement planes
  let cmp = L.netlist.split('\n');
  for (const p of ports) {
    const re = new RegExp(`^(T${p.node}_f \\S+ \\S+ W=[\\d.]+mm len=)([\\d.]+)mm`);
    const i = cmp.findIndex(l => re.test(l));
    if (i < 0) throw new Error(`openEMS export: no feed line T${p.node}_f in the as-built netlist`);
    cmp[i] = cmp[i].replace(re, (_, a, l) => `${a}${r6(+l - p.Lp)}mm`);
  }
  const ti = cmp.findIndex(l => /^\.title/.test(l));
  cmp[ti] = cmp[ti].replace(/^\.title\s+/, '.title openEMS comparison: ');
  const at = cmp.findIndex(l => /^\.substrate/.test(l));
  cmp.splice(at + 1, 0, `# ports at the openEMS measurement planes (the feeds shortened by ${ports.map(p => p.Lp).join('/')} mm); the openEMS result overlays every S trace`, `.data em ${name}.s${nPort}p overlay`);
  return { script, compare: cmp.join('\n'), name, info: { cells, X: X.length, Y: Y.length, Z: Z.length, fine, maxStep, ports, lumped: lumped.length, bc } };
}
