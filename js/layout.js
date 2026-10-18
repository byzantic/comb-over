// Layout geometry core (issue #6): a KiCad-independent description of a board, design-rule checks
// against the substrate's fabrication limits, and an SVG renderer for previews.
//
// Units: millimetres. Axes as in KiCad: x to the right, y DOWN.
//
// Layout = {
//   title, substrate,                         // substrate object from js/substrates.js (optional)
//   outline: [[x,y],…],                       // board edge (closed polygon)
//   items: [
//     { type: 'poly', layer: 'F.Cu', net, pts: [[x,y],…], label? },     // copper
//     { type: 'zone', layer: 'B.Cu', net: 'GND', pts },                 // ground pour
//     { type: 'via',  x, y, drill, pad, net },
//     { type: 'port', name, net, x, y, dir: [dx,dy], width, z0 },        // edge connector reference plane
//   ],
//   dims: [{ a:[x,y], b:[x,y], text }],       // dimension annotations for the preview
//   netlist,                                  // "as built" netlist text (template output)
//   notes: [string],
// }

// ---------------- geometry helpers ----------------
export const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// Polygon for a polyline of the given width (flat ends, mitred joins).
export function pathPolygon(pts, width) {
  const n = pts.length;
  if (n < 2) throw new Error('path needs at least two points');
  const h = width / 2;
  const nrm = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dy);
    if (!(l > 0)) throw new Error('path has a zero-length segment');
    nrm.push([-dy / l, dx / l]);
  }
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    let nx, ny, k = 1;
    if (i === 0) [nx, ny] = nrm[0];
    else if (i === n - 1) [nx, ny] = nrm[n - 2];
    else {
      const a = nrm[i - 1], b = nrm[i];
      nx = a[0] + b[0]; ny = a[1] + b[1];
      const l = Math.hypot(nx, ny);
      if (l < 1e-9) throw new Error('path reverses on itself');
      nx /= l; ny /= l;
      k = 1 / (nx * a[0] + ny * a[1]);     // mitre length factor
    }
    left.push([pts[i][0] + nx * h * k, pts[i][1] + ny * h * k]);
    right.push([pts[i][0] - nx * h * k, pts[i][1] - ny * h * k]);
  }
  return [...left, ...right.reverse()];
}

export const pathLength = (pts) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(a) / 2;
}

export function bbox(ptsList) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pts of ptsList) for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

function segDist(p, q, a, b) {
  // distance between segments pq and ab (0 if they intersect)
  const cross = (o, u, v) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
  const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const pt = (c, s0, s1) => {
    const vx = s1[0] - s0[0], vy = s1[1] - s0[1], l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((c[0] - s0[0]) * vx + (c[1] - s0[1]) * vy) / l2)) : 0;
    return Math.hypot(c[0] - s0[0] - t * vx, c[1] - s0[1] - t * vy);
  };
  return Math.min(pt(p, a, b), pt(q, a, b), pt(a, p, q), pt(b, p, q));
}

export function pointInPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Minimum distance between two polygons (0 if they touch or overlap).
export function polyDistance(A, B) {
  if (pointInPolygon(A[0], B) || pointInPolygon(B[0], A)) return 0;
  let d = Infinity;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    d = Math.min(d, segDist(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]));
    if (d === 0) return 0;
  }
  return d;
}

// ---------------- design-rule check ----------------
// Checks copper-to-copper spacing between different nets, declared minimum widths, via drills and
// copper-to-edge clearance (except where copper is meant to reach the edge, at ports).
export function drc(layout, { edgeClearance = 0.3 } = {}) {
  const fab = layout.substrate?.fab || {};
  const minSpace = fab.minSpace != null ? fab.minSpace * 1e3 : null;
  const minTrace = fab.minTrace != null ? fab.minTrace * 1e3 : null;
  const minDrill = fab.minDrill != null ? fab.minDrill * 1e3 : null;
  const errors = [];
  const cu = layout.items.filter(i => i.type === 'poly' && i.layer === 'F.Cu');
  if (minSpace != null) {
    for (let i = 0; i < cu.length; i++) for (let j = i + 1; j < cu.length; j++) {
      if (cu[i].net === cu[j].net) continue;
      const d = polyDistance(cu[i].pts, cu[j].pts);
      if (d < minSpace - 1e-9) errors.push({ rule: d === 0 ? 'short' : 'space', value: d, limit: minSpace, msg: d === 0 ? `${cu[i].label || cu[i].net} touches ${cu[j].label || cu[j].net} (different nets)` : `gap ${d.toFixed(4)} mm between ${cu[i].label || cu[i].net} and ${cu[j].label || cu[j].net} is below the minimum space ${minSpace} mm` });
    }
  }
  if (minTrace != null) for (const p of cu) if (p.width != null && p.width < minTrace - 1e-9) errors.push({ rule: 'width', value: p.width, limit: minTrace, msg: `${p.label || p.net}: width ${p.width.toFixed(4)} mm is below the minimum trace ${minTrace} mm` });
  for (const v of layout.items.filter(i => i.type === 'via')) {
    if (minDrill != null && v.drill < minDrill - 1e-9) errors.push({ rule: 'drill', value: v.drill, limit: minDrill, msg: `via drill ${v.drill} mm is below the minimum ${minDrill} mm` });
    if (v.pad <= v.drill) errors.push({ rule: 'annular', value: v.pad, limit: v.drill, msg: `via pad ${v.pad} mm is not larger than its drill ${v.drill} mm` });
  }
  // copper to board edge, ignoring the copper that runs into a port on the edge
  const ports = layout.items.filter(i => i.type === 'port');
  const edge = layout.outline;
  for (const p of cu) {
    for (const [x, y] of p.pts) {
      if (!pointInPolygon([x + 1e-9, y + 1e-9], edge) && !onBoundary([x, y], edge)) { errors.push({ rule: 'outside', msg: `${p.label || p.net} extends outside the board outline` }); break; }
    }
    let dmin = Infinity;
    for (let i = 0; i < edge.length; i++) for (let k = 0; k < p.pts.length; k++) dmin = Math.min(dmin, segDist(p.pts[k], p.pts[(k + 1) % p.pts.length], edge[i], edge[(i + 1) % edge.length]));
    const atPort = ports.some(pt => pt.net === p.net && p.pts.some(([x, y]) => Math.hypot(x - pt.x, y - pt.y) <= (pt.width || 0) / 2 + 1e-6));
    if (!atPort && dmin < edgeClearance) errors.push({ rule: 'edge', value: dmin, limit: edgeClearance, msg: `${p.label || p.net} is ${dmin.toFixed(3)} mm from the board edge (minimum ${edgeClearance} mm)` });
  }
  return errors;
}

function onBoundary(pt, poly) {
  for (let i = 0; i < poly.length; i++) if (segDist(pt, pt, poly[i], poly[(i + 1) % poly.length]) < 1e-9) return true;
  return false;
}

// ---------------- SVG preview ----------------
export function toSVG(layout, { pad = 3, scale = 12, showDims = true, errors = [] } = {}) {
  const all = [layout.outline, ...layout.items.filter(i => i.pts).map(i => i.pts)];
  const bb = bbox(all);
  const x0 = bb.x0 - pad, y0 = bb.y0 - pad, w = bb.x1 - bb.x0 + 2 * pad, h = bb.y1 - bb.y0 + 2 * pad;
  const P = (pts) => pts.map(([x, y]) => `${(+x).toFixed(4)},${(+y).toFixed(4)}`).join(' ');
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fs = Math.max(0.6, Math.min(w, h) / 45);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${(w * scale).toFixed(0)}" height="${(h * scale).toFixed(0)}" font-family="IBM Plex Mono, ui-monospace, monospace">`);
  out.push(`<title>${esc(layout.title || 'layout')}</title>`);
  out.push(`<style>.board{fill:#1f5130;stroke:#c9b458;stroke-width:${fs * 0.15}}.gnd{fill:url(#hatch)}.cu{fill:#d9a441;stroke:#8a5a12;stroke-width:${fs * 0.04}}.via{fill:#d9a441;stroke:#8a5a12;stroke-width:${fs * 0.03}}.hole{fill:#111}.port{fill:none;stroke:#e5484d;stroke-width:${fs * 0.12}}.lbl{fill:#f1efe8;font-size:${fs}px}.dim{stroke:#9fd0ff;stroke-width:${fs * 0.05};fill:none}.dimt{fill:#9fd0ff;font-size:${fs * 0.8}px}.err{fill:none;stroke:#ff3b30;stroke-width:${fs * 0.15};stroke-dasharray:${fs * 0.4} ${fs * 0.25}}</style>`);
  out.push(`<defs><pattern id="hatch" width="${fs}" height="${fs}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="${fs}" height="${fs}" fill="#1f5130"/><line x1="0" y1="0" x2="0" y2="${fs}" stroke="#2b6a40" stroke-width="${fs * 0.3}"/></pattern></defs>`);
  out.push(`<polygon class="board" points="${P(layout.outline)}"/>`);
  for (const z of layout.items.filter(i => i.type === 'zone')) out.push(`<polygon class="gnd" points="${P(z.pts)}"><title>${esc(z.layer)} ${esc(z.net)} pour</title></polygon>`);
  for (const c of layout.items.filter(i => i.type === 'poly')) out.push(`<polygon class="cu" points="${P(c.pts)}"><title>${esc(c.label || '')} · net ${esc(c.net)}${c.width != null ? ` · W ${c.width.toFixed(3)} mm` : ''}</title></polygon>`);
  for (const v of layout.items.filter(i => i.type === 'via')) out.push(`<circle class="via" cx="${v.x}" cy="${v.y}" r="${v.pad / 2}"><title>via ${v.drill} mm drill · ${esc(v.net)}</title></circle><circle class="hole" cx="${v.x}" cy="${v.y}" r="${v.drill / 2}"/>`);
  for (const p of layout.items.filter(i => i.type === 'port')) {
    const [dx, dy] = p.dir, nx = -dy, ny = dx, hw = Math.max(p.width, 1) * 0.9;
    out.push(`<line class="port" x1="${p.x + nx * hw}" y1="${p.y + ny * hw}" x2="${p.x - nx * hw}" y2="${p.y - ny * hw}"><title>port ${esc(p.name)} (${esc(p.net)})</title></line>`);
    // label inside the board, beside the feed, next to the edge
    const off = p.width / 2 + fs * 0.5;
    const tx = p.x - dx * fs * 0.6 + (dy !== 0 ? off : 0), ty = p.y - dy * fs * 0.6 + (dx !== 0 ? -off : fs * 0.35);
    out.push(`<text class="lbl" x="${tx}" y="${ty}" text-anchor="${dx < -0.5 ? 'start' : dx > 0.5 ? 'end' : 'start'}">${esc(p.name)}</text>`);
  }
  if (showDims) for (const d of layout.dims || []) {
    const [ax, ay] = d.a, [bx, by] = d.b, mx = (ax + bx) / 2, my = (ay + by) / 2;
    out.push(`<line class="dim" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/><text class="dimt" x="${mx + (d.dx ?? 0)}" y="${my + (d.dy ?? -fs * 0.3)}" text-anchor="middle">${esc(d.text)}</text>`);
  }
  for (const e of errors) if (e.at) out.push(`<circle class="err" cx="${e.at[0]}" cy="${e.at[1]}" r="${fs}"/>`);
  out.push('</svg>');
  return out.join('\n');
}
