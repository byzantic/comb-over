// Node helper: the files a netlist's .data lines name, read relative to the netlist (issue #17).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { parseNetlist } from '../js/netlist.js';
export function dataFiles(netlistPath, text = readFileSync(netlistPath, 'utf8')) {
  const files = {};
  let d; try { d = parseNetlist(text); } catch { return files; }
  for (const e of d.data ?? []) {
    const p = resolve(dirname(netlistPath), e.file);
    if (existsSync(p)) files[basename(e.file)] = readFileSync(p, 'utf8');
  }
  return files;
}
