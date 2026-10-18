// Touchstone writer. v1.1 when all ports share one reference impedance, otherwise v2.0 with [Reference].
export function touchstone(res, ports, { title = 'comb-over', format = 'RI' } = {}) {
  const P = res.P, nf = res.freq.length;
  const zs = ports.map(p => p.z);
  const same = zs.every(z => z === zs[0]);
  const fmt = (x) => (Number.isFinite(x) ? x.toExponential(9) : 'NaN');
  const pair = (re, im) => {
    if (format === 'MA') return `${fmt(Math.hypot(re, im))} ${fmt(Math.atan2(im, re) * 180 / Math.PI)}`;
    if (format === 'DB') return `${fmt(20 * Math.log10(Math.hypot(re, im)))} ${fmt(Math.atan2(im, re) * 180 / Math.PI)}`;
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
