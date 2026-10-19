// Imported S-parameter data (issue #17): attach the files named by .data lines to a solved netlist, as
// trace-expression data sets on the simulation sweep (ctx.data[NAME].S(i, j)).
//   files: { basename → text } (designer: the files you loaded; tools: read from disk)
import { readTouchstone, portsFromName, renormalize, onSweep } from './touchstone.js';

const base = (p) => String(p).split(/[\\/]/).pop();
const cache = new Map();                                     // text+name → parsed (parsing is the slow part)

/** Returns { data: { NAME → onSweep result }, warnings: [..], sets: [{name, file, P, range, z}] }. */
export function attachData(d, freq, files) {
  const data = {}, warnings = [], sets = [];
  for (const e of d.data ?? []) {
    const key = base(e.file), text = files?.[key] ?? files?.[e.file];
    if (text == null) { warnings.push(`.data ${e.name}: file ${key} is not loaded (use Data… or put it next to the netlist)`); continue; }
    let ds;
    try {
      const ck = key + '\0' + text.length + '\0' + text.slice(0, 200) + text.slice(-200);
      ds = cache.get(ck);
      if (!ds) { ds = readTouchstone(text, { nPorts: portsFromName(key), name: key }); cache.set(ck, ds); if (cache.size > 20) cache.delete(cache.keys().next().value); }
    } catch (err) { warnings.push(`.data ${e.name}: ${err.message}`); continue; }
    if (e.z != null) ds = renormalize(ds, Array(ds.P).fill(e.z));
    else ds.z.forEach((z, i) => { const pz = d.ports[i]?.z; if (pz != null && Math.abs(pz - z) > 1e-9) warnings.push(`.data ${e.name}: port ${i + 1} of the data is referenced to ${z} Ω, the circuit's to ${pz} Ω (add z=${pz} to renormalise)`); });
    const sw = onSweep(ds, freq);
    if (sw.outside) warnings.push(`.data ${e.name}: ${sw.outside} sweep point(s) outside the data (${(sw.range[0] / 1e9).toPrecision(4)}–${(sw.range[1] / 1e9).toPrecision(4)} GHz) are left blank`);
    if (ds.P !== d.ports.length) warnings.push(`.data ${e.name}: ${ds.P}-port data, ${d.ports.length}-port circuit`);
    data[e.name] = sw;
    sets.push({ name: e.name, file: key, P: ds.P, range: sw.range, z: ds.z, overlay: e.overlay, n: ds.freq.length });
  }
  return { data, warnings, sets };
}
