// Finger-loaded ("true comb") coupled microstrip lines (issue #41): geometry.
//
// Two backbone strips of width W, a gap G apart, run along x. Each carries fingers of width wf and length
// lf (from its inner edge, towards the other line), one every p. Line 1's fingers sit at x = (k + ¼)p,
// line 2's at (k + ¾)p, so they intermesh: the overlap is 2 lf − G, the side gap between neighbouring
// fingers p/2 − wf and the gap from a finger tip to the other backbone G − lf.
//
// fingerPair({W, G, wf, lf, p, n, x0 = 0}) → { polys: [line1, line2] (comb outlines, mm), len, checks }
// Line 1 lies at y < 0 (backbone from −G/2 − W to −G/2), line 2 at y > 0.

export function fingerGeometry({ W, G, wf, lf, p }) {
  const overlap = 2 * lf - G, side = p / 2 - wf, tip = G - lf;
  return { overlap, side, tip };
}

export function fingerPair({ W, G, wf, lf, p, n, x0 = 0 }) {
  const g = fingerGeometry({ W, G, wf, lf, p });
  if (!(W > 0 && G > 0 && wf > 0 && lf > 0 && p > 0 && n >= 1)) throw new Error('fingerPair: W, G, wf, lf, p > 0 and n ≥ 1');
  if (g.side <= 0) throw new Error(`fingerPair: fingers ${wf} mm wide do not fit a ${p} mm pitch (side gap ${g.side} mm)`);
  if (g.tip <= 0) throw new Error(`fingerPair: fingers ${lf} mm long reach the other backbone across ${G} mm`);
  const len = n * p, y0 = -G / 2;
  // line 1: backbone below, fingers up; outline counter-clockwise
  const comb = (centres) => {
    const pts = [[x0, y0 - W], [x0 + len, y0 - W], [x0 + len, y0]];
    for (const c of [...centres].reverse()) pts.push([c + wf / 2, y0], [c + wf / 2, y0 + lf], [c - wf / 2, y0 + lf], [c - wf / 2, y0]);
    pts.push([x0, y0]);
    return pts;
  };
  const c1 = Array.from({ length: n }, (_, k) => x0 + (k + 0.25) * p), c2 = Array.from({ length: n }, (_, k) => x0 + (k + 0.75) * p);
  const line1 = comb(c1), line2 = comb(c2).map(([x, y]) => [x, -y]).reverse();   // mirrored in y, kept counter-clockwise
  return { polys: [line1, line2], len, ...g };
}

// Splice fingers into a conductor outline (a closed polygon, mm) along its straight edge at y = yEdge: one finger of
// width wf and length lf, towards y = yTo, at each centre in xs. One outline per line, not separate rectangles: a
// finger butted against the backbone would put an edge inside the copper (the openEMS mesh's thirds rule then
// misplaces the backbone edge). Returns the new point list; throws if no edge at yEdge spans every finger.
export function spliceFingers(pts, yEdge, yTo, xs, wf, lf, eps = 1e-6) {
  const h = wf / 2, s = Math.sign(yTo - yEdge);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (Math.abs(a[1] - yEdge) > eps || Math.abs(b[1] - yEdge) > eps) continue;
    const lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
    if (!xs.every(x => x - h > lo - eps && x + h < hi + eps)) continue;
    const up = b[0] > a[0], cs = [...xs].sort((u, v) => up ? u - v : v - u), ins = [];
    for (const x of cs) { const [x1, x2] = up ? [x - h, x + h] : [x + h, x - h]; ins.push([x1, yEdge], [x1, yEdge + s * lf], [x2, yEdge + s * lf], [x2, yEdge]); }
    return [...pts.slice(0, i + 1), ...ins, ...pts.slice(i + 1)];
  }
  throw new Error(`spliceFingers: no edge at y = ${yEdge} spans the fingers`);
}
