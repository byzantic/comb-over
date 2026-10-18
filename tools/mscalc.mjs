// Microstrip calculator (issue #3 models) from the command line.
//
//   node tools/mscalc.mjs --sub jlc-ro4350b-0.508 --z0 50 [--f 2G]          single line: width for Z0
//   node tools/mscalc.mjs --sub jlc-fr4-1.6 --ze 69.4 --zo 36                coupled pair: W and S
//   node tools/mscalc.mjs --sub jlc-ro4350b-0.762 --w 1.7mm [--s 0.3mm] --f 5G   analyse a geometry
//   node tools/mscalc.mjs --list                                              substrate presets
//
// Values accept SI suffixes (mm, u, G …). Add --model hammerstad to compare conductor-loss models.
import { evalRealStr } from '../js/expr.js';
import { makeSubstrate, listPresets, summary } from '../js/substrates.js';
import { msline, mscoupled, mslineLoss, mscoupledLoss, synthMsline, synthMscoupled, fabCheck, fromSubstrate } from '../js/microstrip.js';

const a = process.argv.slice(2), opt = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) { const k = a[i].slice(2); opt[k] = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true; }
if (opt.list) { for (const p of listPresets()) console.log(p.id.padEnd(24), p.name); process.exit(0); }
if (!opt.sub) { console.error('need --sub PRESET (see --list)'); process.exit(1); }
const num = (k) => (opt[k] == null ? undefined : evalRealStr(String(opt[k]), {}));
const sub = makeSubstrate(opt.sub), g = fromSubstrate(sub), f = num('f') ?? 1e9, model = opt.model || 'wheeler';
const mm = (x) => (x * 1e3).toFixed(4) + ' mm';
console.log(summary(sub));
const report = (W, S) => {
  if (S == null) {
    const l = msline({ W, ...g, f }), L = mslineLoss({ W, ...g, f, model });
    console.log(`W = ${mm(W)}   Z0 = ${l.Z0.toFixed(3)} Ω (static ${l.Z0_static.toFixed(3)})   εeff = ${l.epsEff.toFixed(4)} at ${f / 1e9} GHz`);
    console.log(`loss at ${f / 1e9} GHz (${model}): ${(L.dBperM / 100).toFixed(4)} dB/cm   Qc ${L.Qc.toFixed(0)}  Qd ${isFinite(L.Qd) ? L.Qd.toFixed(0) : '∞'}  Q ${L.Q.toFixed(0)}`);
    [...l.warnings, ...fabCheck({ W }, sub)].forEach(w => console.log('warning:', w));
  } else {
    const c = mscoupled({ W, S, ...g, f }), L = mscoupledLoss({ W, S, ...g, f });
    console.log(`W = ${mm(W)}   S = ${mm(S)}   Ze = ${c.Ze.toFixed(3)} Ω   Zo = ${c.Zo.toFixed(3)} Ω   (static; √(ZeZo) = ${Math.sqrt(c.Ze * c.Zo).toFixed(2)} Ω, k = ${((c.Ze - c.Zo) / (c.Ze + c.Zo)).toFixed(4)})`);
    console.log(`εeff even ${c.epse.toFixed(4)}  odd ${c.epso.toFixed(4)} at ${f / 1e9} GHz   Q even ${L.even.Q.toFixed(0)}  odd ${L.odd.Q.toFixed(0)}`);
    [...c.warnings, ...fabCheck({ W, S }, sub)].forEach(w => console.log('warning:', w));
  }
};
if (opt.z0) report(synthMsline({ Z0: num('z0'), ...g, f: opt.f ? f : 0 }).W);
else if (opt.ze) { const s = synthMscoupled({ Ze: num('ze'), Zo: num('zo'), ...g }); if (!s.converged) console.log('warning:', s.warnings[0]); report(s.W, s.S); }
else if (opt.w) report(num('w'), opt.s ? num('s') : undefined);
else { console.error('need --z0, --ze/--zo, or --w [--s]'); process.exit(1); }
