#!/usr/bin/env node
// mtl2d command line (issue #11). Dimensions in mm.
//
//   node solver/cli.mjs --W 1,1,1 --S 0.2[,0.3] --h 0.508 --er 3.66 [--t 0.035] [--order K] [--json]
//   node solver/cli.mjs --W 0.4,0.4 --S 0.2 --stripline 1.0 [--hb 0.5] --er 3
//   node solver/cli.mjs --W 1 --h 0.5 --er 6 --cover 0.3            (covered microstrip, air gap 0.3)
//
// Prints C (pF/m), L (nH/m), modal εeff, Z0 / even–odd values when they apply, and a comb-over
// `cline` body; --json prints all of it as JSON (SI units).
import { solve, microstrip, stripline, coveredMicrostrip, stripsFromWS, evenOdd, single, netlistSnippet } from './mtl2d.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].replace(/^--/, '');
  if (k === 'json') args.json = true; else args[k] = process.argv[++i];
}
const usage = 'usage: node solver/cli.mjs --W w1,w2,… [--S s12,…] (--h H | --stripline B [--hb HB]) --er ER [--t T] [--cover HC] [--order K] [--json]   (mm; --t: strip thickness)';
const list = (s) => (s ?? '').split(',').filter(Boolean).map(x => +x * 1e-3);
const W = list(args.W);
if (!W.length || !args.er || (!args.h && !args.stripline)) { console.error(usage); process.exit(1); }
const S = list(args.S);
const er = +args.er;
const stack = args.stripline ? stripline({ b: +args.stripline * 1e-3, er, hb: args.hb ? +args.hb * 1e-3 : undefined })
  : args.cover ? coveredMicrostrip({ h: +args.h * 1e-3, er, hc: +args.cover * 1e-3 })
  : microstrip({ h: +args.h * 1e-3, er });
let r;
try {
  r = solve(stripsFromWS(W, W.length > 1 ? (S.length === 1 ? S[0] : S) : [], args.t ? +args.t * 1e-3 : 0), stack, { order: args.order ? +args.order : undefined });
} catch (e) { console.error(e.message); process.exit(2); }
const extra = W.length === 1 ? single(r) : W.length === 2 && W[0] === W[1] ? evenOdd(r) : null;
if (args.json) { console.log(JSON.stringify({ C: r.C, C0: r.C0, L: r.L, epsEff: r.epsEff, ...extra, order: r.order }, null, 1)); process.exit(0); }
const show = (A, s) => A.map(row => row.map(v => (v * s).toFixed(4).padStart(11)).join(' ')).join('\n');
console.log(`C (pF/m)\n${show(r.C, 1e12)}\nL (nH/m)\n${show(r.L, 1e9)}`);
console.log(`modal εeff: ${r.epsEff.map(x => x.toFixed(5)).join(' ')}`);
if (extra?.Z0) console.log(`Z0 ${extra.Z0.toFixed(4)} Ω, εeff ${extra.epsEff.toFixed(5)}`);
if (extra?.Ze) console.log(`Z0e ${extra.Ze.toFixed(4)} Ω, Z0o ${extra.Zo.toFixed(4)} Ω, εe ${extra.epse.toFixed(5)}, εo ${extra.epso.toFixed(5)}`);
console.log(`\n# comb-over cline body (${W.length} line${W.length > 1 ? 's' : ''}, basis order ${r.order}, ${r.ms.toFixed(0)} ms)\n${netlistSnippet(r)}`);
