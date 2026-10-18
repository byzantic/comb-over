// Nodal (admittance) solver: stamps sections and lumped elements, terminates each port in its
// reference conductance and solves for S directly (real reference impedances).

import { CMat, csolve } from './linalg.js';
import { GROUND, OPEN } from './netlist.js';

export function frequencies({ start, stop, n, log }) {
  const f = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1);
    f[k] = log ? start * (stop / start) ** t : start + (stop - start) * t;
  }
  return f;
}

// Map node names → indices, honouring wires (union-find), ground and open terminals.
function buildNodes(d) {
  const parent = new Map();
  const find = (x) => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x); return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const isG = (x) => GROUND.has(x);
  for (const [a, b] of d.wires) {
    const na = isG(a) ? '0' : a, nb = isG(b) ? '0' : b;
    add(na); add(nb);
    const ra = find(na), rb = find(nb);
    if (ra !== rb) { if (ra === '0') parent.set(rb, ra); else parent.set(ra, rb); }
  }
  const index = new Map();
  let openCount = 0;
  const idx = (name) => {
    if (OPEN.has(name)) return `__open${openCount++}`; // unique, unconnected
    const r = find(isG(name) ? '0' : name);
    return r === '0' ? -1 : r;
  };
  const resolve = (name) => {
    const r = idx(name);
    if (r === -1) return -1;
    if (!index.has(r)) index.set(r, index.size);
    return index.get(r);
  };
  // ports first so they are easy to identify
  const portIdx = d.ports.map(p => {
    const i = resolve(p.node);
    if (i === -1) throw new Error(`port on ground node "${p.node}"`);
    return i;
  });
  const secTerms = d.sections.map(s => [...s.ends.A, ...s.ends.B].map(resolve));
  const elTerms = d.elements.map(e => [resolve(e.a), resolve(e.b)]);
  return { n: index.size, portIdx, secTerms, elTerms, names: [...index.keys()] };
}

// Solve the network over the sweep. Returns {freq, P, S:{re,im} (nf×P×P)}.
export function solve(d, freqs = frequencies(d.freq)) {
  const nodes = buildNodes(d);
  const P = d.ports.length, n = nodes.n, nf = freqs.length;
  const portSet = new Set(nodes.portIdx);
  if (portSet.size !== P) throw new Error('two ports share a node; this is not supported');
  const Sre = new Float64Array(nf * P * P), Sim = new Float64Array(nf * P * P);
  const zr = d.ports.map(p => p.z);
  let failures = 0;

  for (let k = 0, retry = 0; k < nf; k++) {
    let f = freqs[k];
    if (f <= 0) f = Math.max(1e-9 * freqs[nf - 1], 1e-3);
    // exact half-wave points of lossless lines are singular: evaluate a hair away (limit value)
    if (retry) f *= 1 + 1e-9 * retry;
    const w = 2 * Math.PI * f;
    const Y = new CMat(n);
    // sections
    d.sections.forEach((s, si) => {
      const t = nodes.secTerms[si];
      const ys = s.admittance(f), m = ys.n;
      for (let i = 0; i < m; i++) {
        const a = t[i]; if (a < 0) continue;
        for (let j = 0; j < m; j++) { const b = t[j]; if (b < 0) continue; Y.add(a, b, ys.re[i * m + j], ys.im[i * m + j]); }
      }
    });
    // lumped
    d.elements.forEach((e, ei) => {
      let yr, yi;
      if (e.type === 'R') { yr = 1 / e.value; yi = 0; }
      else if (e.type === 'C') { yi = w * e.value; yr = isFinite(e.Q) ? yi / e.Q : 0; }
      else { // L: z = wL/Q + j wL
        const x = w * e.value, r = isFinite(e.Q) ? x / e.Q : 0, dd = r * r + x * x;
        yr = r / dd; yi = -x / dd;
      }
      const [a, b] = nodes.elTerms[ei];
      if (a >= 0) Y.add(a, a, yr, yi);
      if (b >= 0) Y.add(b, b, yr, yi);
      if (a >= 0 && b >= 0) { Y.add(a, b, -yr, -yi); Y.add(b, a, -yr, -yi); }
    });
    try {
      // Terminated-network formulation (robust where the Kron-reduced Yii is singular, e.g. internal
      // resonances with the ports shorted): A = Y + diag(G_port), A X = E_ports,
      // S = 2 √G X_pp √G − I.
      const pi = nodes.portIdx;
      const A = Y.clone(), E = new CMat(n, P);
      for (let i = 0; i < P; i++) { A.add(pi[i], pi[i], 1 / zr[i], 0); E.set(pi[i], i, 1, 0); }
      const X = csolve(A, E);
      const S = new CMat(P);
      for (let i = 0; i < P; i++) for (let j = 0; j < P; j++) {
        const g = 2 / Math.sqrt(zr[i] * zr[j]);
        S.set(i, j, g * X.re[pi[i] * P + j] - (i === j ? 1 : 0), g * X.im[pi[i] * P + j]);
      }
      if (S.re.some(x => !isFinite(x)) || S.im.some(x => !isFinite(x))) throw new Error('non-finite');
      Sre.set(S.re, k * P * P); Sim.set(S.im, k * P * P);
      retry = 0;
    } catch (e) {
      if (retry < 3) { retry++; k--; continue; }
      retry = 0;
      failures++;
      Sre.fill(NaN, k * P * P, (k + 1) * P * P); Sim.fill(NaN, k * P * P, (k + 1) * P * P);
    }
  }
  return {
    freq: freqs, P, Sre, Sim, failures, nodeCount: n,
    S(i, j) { // 1-based
      if (!(i >= 1 && i <= P && j >= 1 && j <= P)) throw new Error(`S${i}${j}: only ${P} port(s)`);
      const re = new Float64Array(nf), im = new Float64Array(nf), o = (i - 1) * P + (j - 1);
      for (let k = 0; k < nf; k++) { re[k] = Sre[k * P * P + o]; im[k] = Sim[k * P * P + o]; }
      return { re, im };
    },
  };
}
