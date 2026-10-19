// Touchstone writer. v1.1 when all ports share one reference impedance, otherwise v2.0 with [Reference].
export function touchstone(res, ports, { title = 'comb-over', format = 'RI' } = {}) {
  const P = res.P, nf = res.freq.length;
  const zs = ports.map(p => p.z);
  const same = zs.every(z => z === zs[0]);
  const fmt = (x) => (Number.isFinite(x) ? x.toExponential(9) : 'NaN');
  const pair = (re, im) => {
    if (format === 'MA') return `${fmt(Math.hypot(re, im))} ${fmt(Math.atan2(im, re) * 180 / Math.PI)}`;
    if (format === 'DB') return `${fmt(20 * Math.log10(Math.max(Math.hypot(re, im), 1e-20)))} ${fmt(Math.atan2(im, re) * 180 / Math.PI)}`;
    return `${fmt(re)} ${fmt(im)}`;
  };
  const out = [];
  out.push(`! ${title}`, `! generated ${new Date().toISOString()}`);
  if (!same) {
    out.push('[Version] 2.0', `# Hz S ${format} R ${zs[0]}`, `[Number of Ports] ${P}`);
    if (P === 2) out.push('[Two-Port Data Order] 21_12');
    out.push(`[Number of Frequencies] ${nf}`, `[Reference] ${zs.join(' ')}`, '[Network Data]');
  } else {
    out.push(`# Hz S ${format} R ${zs[0]}`);
  }
  const at = (k, i, j) => { const o = k * P * P + i * P + j; return pair(res.Sre[o], res.Sim[o]); };
  for (let k = 0; k < nf; k++) {
    const f = res.freq[k].toPrecision(12);
    if (P === 1) out.push(`${f} ${at(k, 0, 0)}`);
    else if (P === 2) out.push(`${f} ${at(k, 0, 0)} ${at(k, 1, 0)} ${at(k, 0, 1)} ${at(k, 1, 1)}`);
    else {
      for (let i = 0; i < P; i++) {
        for (let j0 = 0; j0 < P; j0 += 4) {
          const chunk = [];
          for (let j = j0; j < Math.min(P, j0 + 4); j++) chunk.push(at(k, i, j));
          out.push((i === 0 && j0 === 0 ? f + ' ' : '  ') + chunk.join(' '));
        }
      }
    }
  }
  if (!same) out.push('[End]');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- reader (issue #17)
const UNIT = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 };

/**
 * Parse a Touchstone 1.1 or 2.0 file (S-parameters only; noise data ignored).
 * nPorts: for v1.1 files, from the .sNp extension (readTouchstone guesses it from the data otherwise).
 * Returns { P, freq: Float64Array, re, im (Float64Array, k·P² + i·P + j), z: [Zref per port], version }.
 */
export function readTouchstone(text, { nPorts = null, name = '' } = {}) {
  const lines = text.split(/\r?\n/);
  let unit = 1e9, fmt = 'MA', param = 'S', R = 50, version = 1, P = nPorts, refs = null, order21 = true, matrix = 'full', nFreq = null;
  const nums = [];
  let inNoise = false, sawOption = false;
  for (let raw of lines) {
    const line = raw.replace(/!.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (sawOption) continue;                                   // only the first option line counts
      sawOption = true;
      const t = line.slice(1).trim().toLowerCase().split(/\s+/);
      for (let i = 0; i < t.length; i++) {
        const w = t[i];
        if (w in UNIT) unit = UNIT[w];
        else if (['s', 'y', 'z', 'h', 'g'].includes(w)) param = w.toUpperCase();
        else if (['db', 'ma', 'ri'].includes(w)) fmt = w.toUpperCase();
        else if (w === 'r') R = parseFloat(t[++i]);
      }
      continue;
    }
    if (line.startsWith('[')) {
      const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
      const key = m[1].toLowerCase(), val = m[2].trim();
      if (key === 'version') version = parseFloat(val);
      else if (key === 'number of ports') P = parseInt(val, 10);
      else if (key === 'two-port data order') order21 = /21_12/.test(val);
      else if (key === 'number of frequencies') nFreq = parseInt(val, 10);
      else if (key === 'reference') refs = val.split(/\s+/).filter(Boolean).map(Number);
      else if (key === 'matrix format') matrix = val.toLowerCase();
      else if (key === 'noise data') inNoise = true;
      else if (key === 'end') break;
      continue;
    }
    // [Reference] values may continue on the next line(s), before any network data
    if (version >= 2 && refs && P && refs.length < P && nums.length === 0) { refs.push(...line.split(/\s+/).map(Number)); continue; }
    if (inNoise) continue;
    for (const tok of line.split(/\s+/)) { const v = Number(tok); if (!Number.isFinite(v)) throw new Error(`${name || 'touchstone'}: bad number "${tok}"`); nums.push(v); }
  }
  if (param !== 'S') throw new Error(`${name || 'touchstone'}: only S-parameter files are supported (this one has ${param})`);
  if (!P) P = guessPorts(nums);
  const per = matrix === 'full' ? P * P : P * (P + 1) / 2;
  // v1.1 2-ports may carry noise data after the network data: it restarts at a lower frequency
  const blocks = [];
  for (let o = 0; o + 1 + 2 * per <= nums.length; o += 1 + 2 * per) {
    if (blocks.length && nums[o] <= blocks[blocks.length - 1][0]) break;
    blocks.push(nums.slice(o, o + 1 + 2 * per));
  }
  if (!blocks.length) throw new Error(`${name || 'touchstone'}: no network data`);
  if (nFreq && blocks.length !== nFreq) throw new Error(`${name || 'touchstone'}: [Number of Frequencies] says ${nFreq}, found ${blocks.length}`);
  const nf = blocks.length, freq = new Float64Array(nf), re = new Float64Array(nf * P * P), im = new Float64Array(nf * P * P);
  const toRI = (a, b) => {
    if (fmt === 'RI') return [a, b];
    const mag = fmt === 'DB' ? 10 ** (a / 20) : a, ph = b * Math.PI / 180;
    return [mag * Math.cos(ph), mag * Math.sin(ph)];
  };
  blocks.forEach((b, k) => {
    freq[k] = b[0] * unit;
    const set = (i, j, v) => { re[k * P * P + i * P + j] = v[0]; im[k * P * P + i * P + j] = v[1]; };
    let q = 1;
    if (P === 2 && matrix === 'full') {
      // pairs in file order: 11, (21, 12) or (12, 21), 22
      const v = [0, 1, 2, 3].map(() => { const r = toRI(b[q], b[q + 1]); q += 2; return r; });
      set(0, 0, v[0]); set(1, 1, v[3]);
      if (order21) { set(1, 0, v[1]); set(0, 1, v[2]); } else { set(0, 1, v[1]); set(1, 0, v[2]); }
    } else {
      for (let i = 0; i < P; i++) for (let j = 0; j < P; j++) {
        if (matrix === 'lower' && j > i) continue;
        if (matrix === 'upper' && j < i) continue;
        const v = toRI(b[q], b[q + 1]); q += 2;
        set(i, j, v); if (matrix !== 'full') set(j, i, v);
      }
    }
  });
  const z = refs && refs.length ? refs.slice(0, P) : Array(P).fill(R);
  return { P, freq, re, im, z, version };
}

// For v1.1 files without a known port count: the P for which the numbers split into strictly increasing
// frequencies of 1 + 2P² values each.
function guessPorts(nums) {
  for (const P of [2, 1, 3, 4, 5, 6, 7, 8]) {
    const per = 1 + 2 * P * P;
    if (nums.length % per !== 0 && P !== 2) continue;
    let ok = true, last = -Infinity, cnt = 0;
    for (let o = 0; o + per <= nums.length; o += per) { if (!(nums[o] > last)) { ok = P === 2 && cnt > 0; break; } last = nums[o]; cnt++; }
    if (ok && cnt > 0) return P;
  }
  throw new Error('cannot tell the number of ports: name the file .sNp');
}
export const portsFromName = (name) => { const m = /\.s(\d+)p$/i.exec(name || ''); return m ? +m[1] : null; };

// ---------------------------------------------------------------- renormalisation
// S' for new real reference impedances: Z = √z (I + S)(I − S)⁻¹ √z, then S' = (Z' − z')(Z' + z')⁻¹ in
// normalised form, all at one frequency. Small dense complex matrices.
function cinv(Ar, Ai, n) {
  const R = Ar.slice(), I = Ai.slice(), Er = new Float64Array(n * n), Ei = new Float64Array(n * n);
  for (let i = 0; i < n; i++) Er[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let p = c, best = 0;
    for (let r = c; r < n; r++) { const m = Math.hypot(R[r * n + c], I[r * n + c]); if (m > best) { best = m; p = r; } }
    if (best < 1e-300) throw new Error('singular matrix in renormalisation');
    for (const M of [R, I, Er, Ei]) for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
    const pr = R[c * n + c], pi = I[c * n + c], d = pr * pr + pi * pi;
    for (const [M, N] of [[R, I], [Er, Ei]]) for (let k = 0; k < n; k++) { const a = M[c * n + k], b = N[c * n + k]; M[c * n + k] = (a * pr + b * pi) / d; N[c * n + k] = (b * pr - a * pi) / d; }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const fr = R[r * n + c], fi = I[r * n + c];
      if (!fr && !fi) continue;
      for (const [M, N] of [[R, I], [Er, Ei]]) for (let k = 0; k < n; k++) { const a = M[c * n + k], b = N[c * n + k]; M[r * n + k] -= fr * a - fi * b; N[r * n + k] -= fr * b + fi * a; }
    }
  }
  return [Er, Ei];
}
function cmul(Ar, Ai, Br, Bi, n) {
  const Cr = new Float64Array(n * n), Ci = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const ar = Ar[i * n + k], ai = Ai[i * n + k]; if (!ar && !ai) continue; for (let j = 0; j < n; j++) { Cr[i * n + j] += ar * Br[k * n + j] - ai * Bi[k * n + j]; Ci[i * n + j] += ar * Bi[k * n + j] + ai * Br[k * n + j]; } }
  return [Cr, Ci];
}
export function renormalize(ds, zNew) {
  const P = ds.P, n = P, nf = ds.freq.length;
  if (zNew.every((z, i) => z === ds.z[i])) return ds;
  const re = new Float64Array(ds.re.length), im = new Float64Array(ds.im.length);
  for (let k = 0; k < nf; k++) {
    const Sr = ds.re.subarray(k * P * P, (k + 1) * P * P), Si = ds.im.subarray(k * P * P, (k + 1) * P * P);
    // Z = √z (I+S)(I−S)⁻¹ √z
    const Ar = Float64Array.from(Sr), Ai = Float64Array.from(Si), Br = Float64Array.from(Sr).map(v => -v), Bi = Float64Array.from(Si).map(v => -v);
    for (let i = 0; i < n; i++) { Ar[i * n + i] += 1; Br[i * n + i] += 1; }
    const [Bir, Bii] = cinv(Br, Bi, n);
    let [Zr, Zi] = cmul(Ar, Ai, Bir, Bii, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const s = Math.sqrt(ds.z[i] * ds.z[j]); Zr[i * n + j] *= s; Zi[i * n + j] *= s; }
    // S' = (Zn − I)(Zn + I)⁻¹ with Zn = z'^-½ Z z'^-½
    const Nr = new Float64Array(n * n), Ni = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const s = 1 / Math.sqrt(zNew[i] * zNew[j]); Nr[i * n + j] = Zr[i * n + j] * s; Ni[i * n + j] = Zi[i * n + j] * s; }
    const Mr = Nr.slice(), Mi = Ni.slice(), Pr = Nr.slice(), Pi = Ni.slice();
    for (let i = 0; i < n; i++) { Mr[i * n + i] -= 1; Pr[i * n + i] += 1; }
    const [Pir, Pii] = cinv(Pr, Pi, n);
    const [Or, Oi] = cmul(Mr, Mi, Pir, Pii, n);
    re.set(Or, k * P * P); im.set(Oi, k * P * P);
  }
  return { ...ds, re, im, z: zNew.slice() };
}

// ---------------------------------------------------------------- onto a sweep
/**
 * The dataset's S(i, j) on the frequencies `freq`: magnitude and unwrapped phase interpolated linearly;
 * NaN outside the data range. Returns { S(i,j) → {re, im}, outside: count of sweep points outside }.
 */
export function onSweep(ds, freq) {
  const P = ds.P, nf = ds.freq.length, cache = new Map();
  let outside = 0;
  for (const f of freq) if (f < ds.freq[0] * (1 - 1e-12) || f > ds.freq[nf - 1] * (1 + 1e-12)) outside++;
  const S = (i, j) => {
    if (i < 1 || j < 1 || i > P || j > P) throw new Error(`S${i}${j}: the data has ${P} port(s)`);
    const key = `${i},${j}`;
    if (cache.has(key)) return cache.get(key);
    const mag = new Float64Array(nf), ph = new Float64Array(nf);
    for (let k = 0; k < nf; k++) { const o = k * P * P + (i - 1) * P + (j - 1); mag[k] = Math.hypot(ds.re[o], ds.im[o]); ph[k] = Math.atan2(ds.im[o], ds.re[o]); }
    for (let k = 1; k < nf; k++) { let d = ph[k] - ph[k - 1]; while (d > Math.PI) { ph[k] -= 2 * Math.PI; d -= 2 * Math.PI; } while (d < -Math.PI) { ph[k] += 2 * Math.PI; d += 2 * Math.PI; } }
    const re = new Float64Array(freq.length), im = new Float64Array(freq.length);
    let p = 0;
    freq.forEach((f, m) => {
      if (f < ds.freq[0] * (1 - 1e-12) || f > ds.freq[nf - 1] * (1 + 1e-12)) { re[m] = NaN; im[m] = NaN; return; }
      while (p < nf - 2 && ds.freq[p + 1] < f) p++;
      const f0 = ds.freq[p], f1 = ds.freq[Math.min(p + 1, nf - 1)], t = f1 > f0 ? Math.min(1, Math.max(0, (f - f0) / (f1 - f0))) : 0;
      const a = mag[p] + t * (mag[Math.min(p + 1, nf - 1)] - mag[p]), b = ph[p] + t * (ph[Math.min(p + 1, nf - 1)] - ph[p]);
      re[m] = a * Math.cos(b); im[m] = a * Math.sin(b);
    });
    const v = { re, im }; cache.set(key, v); return v;
  };
  return { S, outside, P, range: [ds.freq[0], ds.freq[nf - 1]] };
}
