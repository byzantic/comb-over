// Netlist text rewriting for the layout panel (issue #10). The netlist text stays the single source
// of truth: the panel's controls edit `.substrate` / `.layout` lines and can convert impedance-defined
// sections into microstrip geometry on the chosen substrate.
//
//   setSubstrate(text, id)              replace or insert `.substrate ID`
//   setLayout(text, {type, sections, opts}) | null    replace, insert or remove the `.layout` line
//   detectLayouts(d)                    layout templates the parsed netlist's topology fits
//   toMicrostrip(text, d, sub)          rewrite symmetric 2-line clines (any form) and single T lines
//                                       given by impedance into W/S (and W) on the substrate
import { GROUND, OPEN } from './netlist.js';
import { synthMsline, synthMscoupled, fromSubstrate } from './microstrip.js';

const lines = (t) => t.split('\n');
const isDir = (l, d) => new RegExp(`^\\s*${d.replace('.', '\\.')}(\\s|$)`, 'i').test(l);
const fmtMm = (m) => `${+(m * 1e3).toFixed(4)}mm`;

function insertAfterHeader(L, line) {
  // after the last of .title/.freq/.ref/.param-free header lines at the top, else at the start
  let at = -1;
  L.forEach((l, i) => { if (/^\s*\.(title|freq|ref)\b/i.test(l)) at = i; });
  L.splice(at + 1, 0, line);
  return L;
}

export function setSubstrate(text, id) {
  const L = lines(text), i = L.findIndex(l => isDir(l, '.substrate'));
  const line = `.substrate ${id}`;
  if (i >= 0) L[i] = line; else insertAfterHeader(L, line);
  return L.join('\n');
}

export function layoutLine({ type, sections, opts = {} }) {
  // lengths are held in mm (as the parser stores them); vias is a count; connector/launch are words
  const LEN = new Set(['pitch', 'feed', 'margin', 'gap', 'drill']);
  const o = Object.entries(opts).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${LEN.has(k) ? `${+(+v).toFixed(4)}mm` : v}`);
  return ['.layout', type, ...sections, ...o].join(' ');
}

export function setLayout(text, spec) {
  const L = lines(text), i = L.findIndex(l => isDir(l, '.layout'));
  if (!spec) { if (i >= 0) L.splice(i, 1); return L.join('\n'); }
  const line = layoutLine(spec);
  if (i >= 0) L[i] = line;
  else { while (L.length && L[L.length - 1].trim() === '') L.pop(); L.push(line, ''); }
  return L.join('\n');
}

// ---------------------------------------------------------------- topology detection
const isPort = (d, n) => d.ports.some(p => p.node === n);
const isGround = (d, n) => GROUND.has(n) || d.wires.some(([a, b]) => (a === n && GROUND.has(b)) || (b === n && GROUND.has(a)));

export function detectLayouts(d) {
  const out = [];
  const pairs = d.sections.filter(s => s.N === 2), singles = d.sections.filter(s => s.N === 1);
  for (const s of pairs) {
    const [a1, a2] = s.ends.A, [b1, b2] = s.ends.B;
    if ([a1, a2, b1, b2].every(n => isPort(d, n)) && new Set([a1, a2, b1, b2]).size === 4) out.push({ type: 'coupler', sections: [s.name], why: `${s.name}: four-port coupled pair` });
    if (b1 === b2 && isPort(d, a1) && isPort(d, a2)) {
      const ref = singles.find(t => isPort(d, t.ends.A[0]) && isPort(d, t.ends.B[0]));
      if (ref) out.push({ type: 'schiffman', sections: [s.name, ref.name], why: `${s.name}: C-section (far ends joined) with reference line ${ref.name}` });
    }
  }
  for (const s1 of pairs) for (const s2 of pairs) {
    if (s1 === s2) continue;
    const m = [0, 1].find(i => s1.ends.B[i] === s2.ends.A[i] && !OPEN.has(s1.ends.B[i]));
    if (m == null) continue;
    const s = 1 - m;
    if (OPEN.has(s2.ends.B[m]) && isGround(d, s1.ends.A[s]) && isGround(d, s2.ends.B[s]) && isPort(d, s1.ends.A[m]) && isPort(d, s1.ends.B[s]) && isPort(d, s2.ends.A[s]))
      out.push({ type: 'marchand', sections: [s1.name, s2.name], why: `${s1.name} + ${s2.name}: Marchand balun` });
  }
  return out;
}

// ---------------------------------------------------------------- impedance → microstrip geometry
// Even/odd impedances of a symmetric pair from its Maxwell C and L (per unit length).
export function evenOdd(sec) {
  const C = sec.C, L = sec.L, el = (M, i, j) => (M.get ? M.get(i, j) : M[i][j]);
  const c11 = el(C, 0, 0), c22 = el(C, 1, 1), c12 = el(C, 0, 1), l11 = el(L, 0, 0), l22 = el(L, 1, 1), l12 = el(L, 0, 1);
  const sym = Math.abs(c11 - c22) <= 1e-6 * Math.abs(c11) && Math.abs(l11 - l22) <= 1e-6 * Math.abs(l11);
  return { sym, Ze: Math.sqrt((l11 + l12) / (c11 + c12)), Zo: Math.sqrt((l11 - l12) / (c11 - c12)) };
}
export const singleZ = (sec) => { const el = (M) => (M.get ? M.get(0, 0) : M[0][0]); return Math.sqrt(el(sec.L) / el(sec.C)); };

const SPEC_KEYS = new Set(['zeo', 'y0', 'z0', 'cn', 'cg', 'cm', 'c', 'l', 'er']);

/**
 * Rewrite every impedance-defined section as microstrip on `sub` (a substrate object).
 * Returns { text, changed: [{name, from, to}], skipped: [{name, why}] }.
 */
export function toMicrostrip(text, d, sub, { all = false } = {}) {
  // all: also re-synthesise sections that are already physical, keeping the impedances they have in
  // `d` (on its substrate) — used when the substrate changes. W/S given as .param names are replaced
  // by numbers.
  const ms = fromSubstrate(sub);
  const L = lines(text), changed = [], skipped = [];
  for (const sec of d.sections) {
    if (sec.geom && !all) continue;                               // already physical
    if (sec.N === 2) {
      const eo = evenOdd(sec);
      if (!eo.sym) { skipped.push({ name: sec.name, why: 'not a symmetric pair' }); continue; }
      const r = synthMscoupled({ Ze: eo.Ze, Zo: eo.Zo, ...ms });
      if (!r.converged) { skipped.push({ name: sec.name, why: `no microstrip W/S gives Z0e ${eo.Ze.toFixed(1)} / Z0o ${eo.Zo.toFixed(1)} Ω on ${sub.id}` }); continue; }
      const i = L.findIndex(l => new RegExp(`^\\s*cline\\s+${sec.name}(\\s|$)`, 'i').test(l));
      if (i < 0) { skipped.push({ name: sec.name, why: 'cline line not found' }); continue; }
      const end = L.findIndex((l, k) => k > i && /^\s*end\b/i.test(l));
      // drop the line-constant lines inside the block, and constants given inline on the cline line
      for (let k = end - 1; k > i; k--) { const w = L[k].trim().split(/\s+/)[0]?.toLowerCase(); if (SPEC_KEYS.has(w) || /^cm\(\d+,\d+\)$/.test(w)) L.splice(k, 1); }
      const [head, ...cmt] = L[i].split('#');
      const kept = head.trim().split(/\s+/).filter((t, j) => j < 2 || !/^(er|geom|w|s)=/i.test(t));
      L[i] = `${[...kept, 'geom=msl', `W=${fmtMm(r.W)}`, `S=${fmtMm(r.S)}`].join(' ')}${cmt.length ? '   #' + cmt.join('#') : ''}`;
      changed.push({ name: sec.name, from: `Z0e ${eo.Ze.toFixed(2)} / Z0o ${eo.Zo.toFixed(2)} Ω`, to: `W ${fmtMm(r.W)}, S ${fmtMm(r.S)}` });
    } else if (sec.N === 1) {
      const z = singleZ(sec), W = synthMsline({ Z0: z, ...ms, f: d.fref }).W;
      const i = L.findIndex(l => new RegExp(`^\\s*${sec.name}\\s`, 'i').test(l));
      if (i < 0) { skipped.push({ name: sec.name, why: 'line not found' }); continue; }
      const [head, ...cmt] = L[i].split('#');
      const toks = head.trim().split(/\s+/).filter(t => !/^(er|z0|w)=/i.test(t));
      L[i] = `${[...toks.slice(0, 3), `W=${fmtMm(W)}`, ...toks.slice(3)].join(' ')}${cmt.length ? '   #' + cmt.join('#') : ''}`;
      changed.push({ name: sec.name, from: `Z0 ${z.toFixed(2)} Ω`, to: `W ${fmtMm(W)}` });
    } else skipped.push({ name: sec.name, why: `${sec.N}-line section: needs the field solver (#11/#12)` });
  }
  return { text: L.join('\n'), changed, skipped };
}
