// Web Worker for geometry synthesis (issue #13): design() + realise() take a few seconds of field
// solving and optimisation, so they run off the main thread. Progress lines are posted as they come.
import { design } from './synth.js';
import { realise } from './synth-geom.js';

self.onmessage = (e) => {
  const { spec, substrate, via } = e.data;
  try {
    const r = design(spec);
    const g = realise(r, { substrate, via, progress: (line) => self.postMessage({ progress: line }) });
    self.postMessage({ done: true, netlist: g.netlist, warnings: g.warnings, report: g.report });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
