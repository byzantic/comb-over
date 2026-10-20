// Web Worker for geometry synthesis (issue #13): design() + realise() take a few seconds of field
// solving and optimisation, so they run off the main thread. Progress lines are posted as they come.
import { design } from './synth.js';
import { realise } from './synth-geom.js';
import { realiseHairpin } from './synth-hairpin.js';
import { realiseEdgeCoupled } from './synth-ec.js';

self.onmessage = (e) => {
  const { spec, substrate, via, cap } = e.data;
  try {
    // hairpin and edge-coupled (#38) are microstrip-only designs of their own
    const g = spec.structure === 'hairpin' ? realiseHairpin(spec, { substrate })
      : spec.structure === 'edgecoupled' ? realiseEdgeCoupled(spec, { substrate })
        : realise(design(spec), { substrate, via, cap, progress: (line) => self.postMessage({ progress: line }) });
    self.postMessage({ done: true, netlist: g.netlist, warnings: g.warnings, report: g.report });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
