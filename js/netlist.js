// Netlist parser. See README.md for the language. Produces a plain "design" object
// whose numeric values are already evaluated (with optional parameter overrides).

import { viaL, bendLC, stepLC, tlcY } from './discontinuities.js';
import { expandRes } from './resistors.js';
import { expandCap } from './capacitors.js';
import { parseExpr, evalReal, astHasDeg } from './expr.js';
import { Section, fromY0, fromCnorm, fromEvenOdd, maxwellFromGroundMutual, C0 } from './section.js';
import { rSymFunc } from './linalg.js';
import { makeSubstrate, scopeOf, KEYS as SUB_KEYS } from './substrates.js';
import { msline, mscoupled, mslineLoss, mscoupledLoss, fromSubstrate, fabCheck } from './microstrip.js';
import { fieldLines } from './fieldlines.js';
import { teeY } from './tee.js';

export const GROUND = new Set(['0', 'gnd', 'GND', 'ground']);
export const OPEN = new Set(['-', 'open', 'OPEN', 'nc', 'NC']);

// Split on whitespace at bracket depth 0; strip comments (# or ; at start, or ' #' / '//').
export function splitTokens(line) {
  const toks = []; let cur = '', depth = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) toks.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) toks.push(cur);
  return toks;
}

function stripComment(line) {
  let s = line;
  const i = s.search(/(^|\s)(#|\/\/)/);
  if (i >= 0) s = s.slice(0, i);
  if (/^\s*\*/.test(s)) return ''; // SPICE comment line
  return s.trim();
}

// key=value splitting
function kv(tok) { const i = tok.indexOf('='); return i > 0 ? [tok.slice(0, i), tok.slice(i + 1)] : null; }

// Parse "[a b c; d e f]" → array of arrays of expression strings. Also accepts a bare row "a b c".
function matrixStrings(tok) {
  let s = tok.trim();
  if (s.startsWith('[')) { if (!s.endsWith(']')) throw new Error(`unterminated matrix ${tok}`); s = s.slice(1, -1); }
  const rows = [];
  let cur = '', depth = 0, row = [];
  const flush = () => { if (cur.trim()) row.push(cur.trim()); cur = ''; };
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) { flush(); continue; }
    if (depth === 0 && ch === ';') { flush(); rows.push(row); row = []; continue; }
    cur += ch;
  }
  flush(); if (row.length) rows.push(row);
  return rows;
}

export function parseNetlist(text, overrides = {}) {
  const lines = text.split(/\r?\n/);
  const d = {
    freq: null, fref: null, params: [], scope: {}, ports: [], elements: [], sections: [], wires: [],
    plots: [], goals: [], opt: { maxiter: 400 }, warnings: [], text,
  };
  const fail = (ln, msg) => { const e = new Error(`line ${ln + 1}: ${msg}`); e.line = ln + 1; throw e; };
  const ev = (s, ln) => {
    try { return evalReal(parseExpr(s), d.scope); } catch (e) { fail(ln, e.message); }
  };
  // a number, or a list "[a b c]" / "a b c" → array (W and S of N-line geometry)
  const evList = (strs, ln) => {
    const joined = strs.join(' ').trim();
    let items;
    try { items = joined.startsWith('[') ? matrixStrings(joined).flat() : strs; } catch (e) { fail(ln, e.message); }
    const v = items.map(x => ev(x, ln));
    return joined.startsWith('[') || v.length > 1 ? v : v[0];
  };

  // ---- pass 1: params and .substrate, in file order (later ones may use earlier ones) ----
  lines.forEach((raw, ln) => {
    const line = stripComment(raw);
    if (/^\.substrate\b/i.test(line)) {
      if (d.substrate) fail(ln, 'only one .substrate statement is allowed');
      const toks = splitTokens(line).slice(1);
      if (!toks.length) fail(ln, '.substrate PRESET|custom [h=..] [er=..] [tand=..] [ftand=..] [t=..] [sigma=..] [rough=..]');
      const ov = {};
      for (const tk of toks.slice(1)) {
        const k = kv(tk);
        if (!k) fail(ln, `expected key=value, got "${tk}"`);
        if (!(k[0].toLowerCase() in SUB_KEYS)) fail(ln, `unknown substrate key "${k[0]}" (use ${Object.keys(SUB_KEYS).join(', ')})`);
        ov[k[0].toLowerCase()] = ev(k[1], ln);
      }
      try { d.substrate = makeSubstrate(toks[0], ov); } catch (e) { fail(ln, e.message); }
      d.substrate.line = ln + 1;
      Object.assign(d.scope, scopeOf(d.substrate));
      return;
    }
    if (!/^\.param\b/i.test(line)) return;
    const body = line.replace(/^\.param\s*/i, '');
    const m = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(body);
    if (!m) fail(ln, 'expected ".param name = expr [tune lo hi]"');
    const name = m[1];
    let rest = m[2], tune = null;
    const tm = /\s+tune\s+(\S+)\s+(\S+)\s*$/i.exec(rest);
    if (tm) { rest = rest.slice(0, tm.index); }
    const exprStr = rest.trim();
    let value = name in overrides ? overrides[name] : ev(exprStr, ln);
    if (tm) tune = { lo: ev(tm[1], ln), hi: ev(tm[2], ln) };
    d.scope[name] = value;
    d.params.push({ name, expr: exprStr, value, tune, line: ln + 1 });
  });

  // ---- pass 2: everything else ----
  let block = null; // current cline block
  let elemCount = 0;
  const pendingSections = [];

  const handleLine = (raw, ln) => {
    const line = stripComment(raw);
    if (!line) return;
    const toks = splitTokens(line);
    const kw = toks[0];
    const kwl = kw.toLowerCase();

    if (block) {
      if (kwl === 'end' || kwl === '.end' || kwl === 'endc') { pendingSections.push(block); block = null; return; }
      const args = toks.slice(1);
      switch (kwl) {
        case 'er': block.er = ev(args[0], ln); break;
        case 'len': case 'length': block.lenStr = args[0]; block.lenLine = ln; break;
        case 'f0': block.f0 = ev(args[0], ln); break;
        case 'q': block.Q = ev(args[0], ln); block.Qset = true; break;
        case 'geom': block.geom = String(args[0] || '').toLowerCase(); break;
        case 'w': block.W = evList(args, ln); break;
        case 's': block.S = evList(args, ln); break;
        case 'model': block.model = String(args[0] || '').toLowerCase(); break;
        case 'fingers': {   // finger-loaded coupled microstrip (#41): wf= lf= p= (geometry), Ze= Zo= ee= eo= (from openEMS)
          const fg = { line: ln };
          for (const x of args) { const k = kv(x); if (!k) fail(ln, `fingers: expected key=value, got "${x}"`); const key = k[0].toLowerCase();
            if (!['wf', 'lf', 'p', 'ze', 'zo', 'ee', 'eo'].includes(key)) fail(ln, `fingers: unknown option ${k[0]} (wf, lf, p, Ze, Zo, ee, eo)`);
            fg[key] = ev(k[1], ln); }
          for (const k of ['wf', 'lf', 'p', 'ze', 'zo', 'ee', 'eo']) if (!(fg[k] > 0)) fail(ln, `fingers: ${k} must be given and > 0 (the modal values come from an openEMS extraction, tools/fingerdesign.mjs)`);
          block.fingers = fg; break;
        }
        case 'a': block.A = args; block.Aline = ln; break;
        case 'b': block.B = args; block.Bline = ln; break;
        case 'zeo': {
          const v = args.map(a => ev(a, ln));
          if (v.length !== 2 && v.length !== 4) fail(ln, 'Zeo Z0e Z0o [eeff_e eeff_o]');
          block.spec = { kind: 'zeo', v }; break;
        }
        case 'y0': block.spec = { kind: 'y0', M: matrixStrings(args.join(' ')).map(r => r.map(x => ev(x, ln))) }; break;
        case 'z0': block.spec = { kind: 'z0', M: matrixStrings(args.join(' ')).map(r => r.map(x => ev(x, ln))) }; break;
        case 'cn': block.spec = { kind: 'cn', M: matrixStrings(args.join(' ')).map(r => r.map(x => ev(x, ln))) }; break;
        case 'cg': block.cg = args.map(a => ev(a, ln)); block.spec = block.spec || { kind: 'cgm' }; break;
        case 'cm': block.cm = block.cm || []; block.cm.push({ adj: args.map(a => ev(a, ln)), ln }); block.spec = block.spec || { kind: 'cgm' }; break;
        case 'c': block.Cmat = matrixStrings(args.join(' ')).map(r => r.map(x => ev(x, ln))); block.spec = { kind: 'cl' }; break;
        case 'l': block.Lmat = matrixStrings(args.join(' ')).map(r => r.map(x => ev(x, ln))); block.spec = { kind: 'cl' }; break;
        default: {
          const m = /^cm\((\d+),(\d+)\)$/i.exec(kw);
          if (m) { block.cmx = block.cmx || []; block.cmx.push({ i: +m[1] - 1, j: +m[2] - 1, v: ev(args[0], ln) }); block.spec = block.spec || { kind: 'cgm' }; break; }
          fail(ln, `unknown cline keyword "${kw}"`);
        }
      }
      return;
    }

    if (kwl === '.param' || kwl === '.substrate') return;
    if (kwl === '.freq') {
      const [a, b, n, mode] = toks.slice(1);
      d.freq = { start: ev(a, ln), stop: ev(b, ln), n: Math.max(2, Math.round(ev(n ?? '401', ln))), log: (mode || '').toLowerCase() === 'log' };
      return;
    }
    if (kwl === '.ref') { d.fref = ev(toks[1], ln); return; }
    if (kwl === '.title') { d.title = line.slice(6).trim(); return; }
    if (kwl === '.plot' || kwl === '.smith' || kwl === '.polar') {
      const p = { kind: kwl.slice(1), traces: [], ylim: null, line: ln + 1 };
      for (const t of toks.slice(1)) {
        const k = kv(t);
        if (k && k[0] === 'ylim') { const [lo, hi] = k[1].split(',').map(x => ev(x, ln)); p.ylim = [lo, hi]; continue; }
        if (k && k[0] === 'title') { p.title = k[1].replace(/_/g, ' '); continue; }
        try { p.traces.push({ src: t, ast: parseExpr(t) }); } catch (e) { fail(ln, e.message); }
      }
      d.plots.push(p); return;
    }
    if (kwl === '.goal') {
      // .goal EXPR OP VALUE [F1 F2] [w=W]
      const t = toks.slice(1);
      let w = 1; const rest = [];
      for (const x of t) { const k = kv(x); if (k && k[0] === 'w') w = ev(k[1], ln); else rest.push(x); }
      // allow "db(S11)<-20" compact form
      let exprS, op, valS, f1S, f2S;
      const cm = /^(.*?)(<=|>=|<|>|=)(.+)$/.exec(rest[0]);
      if (rest.length >= 3 && /^(<=?|>=?|=)$/.test(rest[1])) [exprS, op, valS, f1S, f2S] = rest;
      else if (cm && !/^(<|>|=)$/.test(rest[0])) { exprS = cm[1]; op = cm[2]; valS = cm[3]; [f1S, f2S] = rest.slice(1); }
      else fail(ln, '.goal EXPR <|>|= VALUE [F1 F2] [w=W]');
      let ast; try { ast = parseExpr(exprS); } catch (e) { fail(ln, e.message); }
      d.goals.push({ src: exprS, ast, op: op[0], value: ev(valS, ln), f1: f1S ? ev(f1S, ln) : -Infinity, f2: f2S ? ev(f2S, ln) : Infinity, w, line: ln + 1 });
      return;
    }
    // .data NAME FILE [overlay] [z=Z]: measured or EM S-parameters (issue #17); the caller attaches the
    // file's contents (js/data.js), traces use NAME.S21
    if (kwl === '.data') {
      if (toks.length < 3) fail(ln, '.data NAME FILE [overlay] [z=Z]');
      const name = toks[1];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(ln, `.data: "${name}" is not a valid name`);
      if ((d.data ?? []).some(x => x.name === name)) fail(ln, `.data ${name} is defined twice`);
      const e = { name, file: toks[2], overlay: false, z: null, line: ln + 1 };
      for (const x of toks.slice(3)) { const k = kv(x); if (x.toLowerCase() === 'overlay') e.overlay = true; else if (k && k[0].toLowerCase() === 'z') e.z = ev(k[1], ln); else fail(ln, `unknown .data option "${x}"`); }
      (d.data ??= []).push(e);
      return;
    }
    if (kwl === '.layout') {
      if (d.layout) fail(ln, 'only one .layout statement is allowed');
      const t = toks.slice(1), names = [], opts = {};
      if (!t.length) fail(ln, '.layout TEMPLATE SECTION… [pitch=..] [feed=..] [margin=..]');
      const LEN = new Set(['pitch', 'feed', 'margin', 'gap', 'drill', 'stub']), RAW = new Set(['vias']), STR = new Set(['connector', 'launch', 'cap']);
      for (const x of t.slice(1)) {
        const k = kv(x);
        if (!k) { names.push(x); continue; }
        const key = k[0].toLowerCase();
        if (LEN.has(key)) opts[key] = ev(k[1], ln) * 1e3;          // layout works in millimetres
        else if (RAW.has(key)) opts[key] = ev(k[1], ln);
        else if (STR.has(key)) opts[key] = k[1].toLowerCase();
        else fail(ln, `unknown .layout option "${k[0]}"`);
      }
      d.layout = { type: t[0].toLowerCase(), sections: names, opts, line: ln + 1 };
      return;
    }
    if (kwl === '.opt') { for (const x of toks.slice(1)) { const k = kv(x); if (k) d.opt[k[0]] = ev(k[1], ln); } return; }
    if (kwl.startsWith('.')) { d.warnings.push(`line ${ln + 1}: unknown directive ${kw} ignored`); return; }

    if (kwl === 'cline') {
      if (!toks[1]) fail(ln, 'cline needs a name');
      block = { name: toks[1], line: ln, er: 1, Q: Infinity };
      // allow inline key=value on the cline line
      for (const x of toks.slice(2)) { const k = kv(x); if (!k) fail(ln, `unexpected "${x}"`); const key = k[0].toLowerCase(); if (key === 'len') { block.lenStr = k[1]; block.lenLine = ln; } else if (key === 'er') block.er = ev(k[1], ln); else if (key === 'q') { block.Q = ev(k[1], ln); block.Qset = true; } else if (key === 'f0') block.f0 = ev(k[1], ln); else if (key === 'geom') block.geom = k[1].toLowerCase(); else if (key === 'w') block.W = evList([k[1]], ln); else if (key === 's') block.S = evList([k[1]], ln); else if (key === 'model') block.model = k[1].toLowerCase(); else fail(ln, `unknown cline option ${k[0]}`); }
      return;
    }
    if (kwl === 'port') {
      if (toks.length < 2) fail(ln, 'port NODE [Z0]');
      d.ports.push({ node: toks[1], z: toks[2] ? ev(toks[2].replace(/^z0?=/i, ''), ln) : 50, line: ln + 1 });
      return;
    }
    if (kwl === 'wire') { for (let i = 2; i < toks.length; i++) d.wires.push([toks[1], toks[i]]); return; }
    // cap NAME N1 [N2] C=.. [type=ideal|smd|printed|trimmer] …: a loading capacitor with its parasitic
    // model (js/capacitors.js, issue #14), expanded here into primitive elements and sections
    if (kwl === 'cap') {
      const nodes = [], o = {};
      for (const x of toks.slice(2)) { const k = kv(x); if (k) o[k[0].toLowerCase()] = k[1]; else nodes.push(x); }
      const exp = expandCap({ name: toks[1], nodes, o, ev: (x) => ev(x, ln), sub: d.substrate, f: d.fref ?? (d.freq ? (d.freq.start + d.freq.stop) / 2 : null), fail: (m) => fail(ln, m) });
      exp.warnings.forEach(w => d.warnings.push(`line ${ln + 1}: ${toks[1]}: ${w}`));
      (d.caps ??= []).push({ name: toks[1], line: ln + 1, node: nodes[0], node2: nodes[1] ?? '0', ...exp.info });
      exp.lines.forEach(l => handleLine(l, ln));
      return;
    }
    // res NAME N1 [N2] R=.. [pkg=0402|0603|0805|ideal] [esl=..] [cp=..] [d=..] [n=..]: chip resistor with
    // pads, ESL and body capacitance; to ground through vias when N2 is omitted (#37, js/resistors.js)
    if (kwl === 'res') {
      const nodes = [], o = {};
      for (const x of toks.slice(2)) { const k = kv(x); if (k) o[k[0].toLowerCase()] = k[0].toLowerCase() === 'pkg' ? k[1].toLowerCase() : k[1]; else nodes.push(x); }
      const exp = expandRes({ name: toks[1], nodes, o, ev: (x) => ev(x, ln), sub: d.substrate, fail: (m) => fail(ln, m) });
      exp.warnings.forEach(w => d.warnings.push(`line ${ln + 1}: ${toks[1]}: ${w}`));
      (d.resistors ??= []).push({ name: toks[1], line: ln + 1, node: nodes[0], node2: nodes[1] ?? '0', ...exp.info });
      exp.lines.forEach(l => handleLine(l, ln));
      return;
    }
    // via NAME NODE [NODE2] d=.. [n=..] [h=..] [Q=..]: plated via(s) to ground (or to NODE2), as the
    // Goldfarb–Pucel inductance (issue #5); h defaults to the .substrate height
    if (kwl === 'via') {
      if (toks.length < 3) fail(ln, 'via NAME NODE [NODE2] d=.. [n=..] [h=..]');
      const nodes = [], o = {};
      for (const x of toks.slice(2)) { const k = kv(x); if (k) o[k[0].toLowerCase()] = ev(k[1], ln); else nodes.push(x); }
      for (const key of Object.keys(o)) if (!['d', 'n', 'h', 'q'].includes(key)) fail(ln, `unknown via option ${key}`);
      if (!(o.d > 0)) fail(ln, 'via: d= (drill diameter) is required');
      const h = o.h ?? d.scope.sub_h;
      if (!(h > 0)) fail(ln, 'via: give h= or a .substrate');
      const n = Math.max(1, Math.round(o.n ?? 1));
      const v = viaL({ d: o.d, h, n });
      v.warnings.forEach(w => d.warnings.push(`line ${ln + 1}: ${toks[1]}: ${w}`));
      d.elements.push({ type: 'L', name: toks[1], a: nodes[0], b: nodes[1] ?? '0', value: v.L, Q: o.q ?? Infinity, line: ln + 1, via: { d: o.d, h, n, L1: v.L1 } });
      elemCount++;
      return;
    }

    // tee NAME A B SIDE Wa=.. Wb=.. W2=..: microstrip T-junction on the .substrate (Hammerstad, as in
    // Qucs; js/tee.js). A and B are the main arms, SIDE the side arm; reference planes at the edges of
    // the crossing strips.
    if (kwl === 'tee') {
      if (toks.length < 5) fail(ln, 'tee NAME A B SIDE Wa=.. Wb=.. W2=..');
      const nodes = [], o = {};
      for (const x of toks.slice(2)) { const k = kv(x); if (k) o[k[0].toLowerCase()] = ev(k[1], ln); else nodes.push(x); }
      if (nodes.length !== 3) fail(ln, 'tee: three nodes (main arm A, main arm B, side arm)');
      for (const key of Object.keys(o)) if (!['wa', 'wb', 'w2'].includes(key)) fail(ln, `unknown tee option ${key}`);
      if (!(o.wa > 0) || !(o.wb > 0) || !(o.w2 > 0)) fail(ln, 'tee: Wa, Wb and W2 (> 0) are required');
      if (!d.substrate) fail(ln, 'tee: needs a .substrate');
      const geo = { Wa: o.wa, Wb: o.wb, W2: o.w2, h: d.substrate.dielectric.h, er: d.substrate.dielectric.er, t: d.substrate.copper.t };
      (d.blocks ??= []).push({ type: 'tee', name: toks[1], nodes: [...nodes, `__tee_${toks[1]}`], geo, y: (f) => teeY(geo, f), line: ln + 1 });
      return;
    }

    // bend NAME A B W=.. [mitre=none|opt]: 90° microstrip bend; step NAME A B W1=.. W2=..: width step
    // (W1 at A). On the .substrate; T networks of js/discontinuities.js (#37).
    if (kwl === 'bend' || kwl === 'step') {
      const usage = kwl === 'bend' ? 'bend NAME A B W=.. [mitre=none|opt]' : 'step NAME A B W1=.. W2=..';
      if (toks.length < 5) fail(ln, usage);
      const nodes = [], o = {};
      for (const x of toks.slice(2)) { const k = kv(x); if (k) o[k[0].toLowerCase()] = k[0].toLowerCase() === 'mitre' ? k[1].toLowerCase() : ev(k[1], ln); else nodes.push(x); }
      if (nodes.length !== 2) fail(ln, `${kwl}: two nodes (${usage})`);
      const keys = kwl === 'bend' ? ['w', 'mitre'] : ['w1', 'w2'];
      for (const key of Object.keys(o)) if (!keys.includes(key)) fail(ln, `unknown ${kwl} option ${key}`);
      if (!d.substrate) fail(ln, `${kwl}: needs a .substrate`);
      const sub = d.substrate, h = sub.dielectric.h, er = sub.dielectric.er, t = sub.copper.t;
      let m;
      try {
        if (kwl === 'bend') { if (!(o.w > 0)) throw new Error('bend: W (> 0) is required'); m = bendLC({ W: o.w, h, er, mitre: o.mitre ?? 'none' }); }
        else { if (!(o.w1 > 0) || !(o.w2 > 0)) throw new Error('step: W1 and W2 (> 0) are required'); m = stepLC({ W1: o.w1, W2: o.w2, h, er, t, f: d.fref }); }
      } catch (e) { fail(ln, e.message); }
      m.warnings.forEach(w => d.warnings.push(`line ${ln + 1}: ${toks[1]}: ${w}`));
      const geo = kwl === 'bend' ? { W: o.w, mitre: o.mitre ?? 'none', M: m.mitre } : { W1: o.w1, W2: o.w2 };
      (d.blocks ??= []).push({ type: kwl, name: toks[1], nodes: [...nodes, `__${kwl}_${toks[1]}`], geo, lc: { L1: m.L1, C: m.C, L2: m.L2 }, y: (f) => tlcY(m.L1, m.C, m.L2, f), line: ln + 1 });
      return;
    }

    // Elements: R*, C*, L*, T*
    const type = kw[0].toUpperCase();
    if ('RCL'.includes(type)) {
      if (toks.length < 4) fail(ln, `${type} element: NAME N1 N2 VALUE [Q=..]`);
      const el = { type, name: kw, a: toks[1], b: toks[2], value: ev(toks[3], ln), Q: Infinity, line: ln + 1 };
      for (const x of toks.slice(4)) { const k = kv(x); if (k && k[0].toLowerCase() === 'q') el.Q = ev(k[1], ln); else fail(ln, `unexpected "${x}"`); }
      if (type !== 'R' && !(el.value > 0)) fail(ln, `${kw}: value must be > 0 (use "wire" for a short)`);
      d.elements.push(el); elemCount++;
      return;
    }
    if (type === 'T') {
      if (toks.length < 3) fail(ln, 'T element: NAME N1 N2 Z0=.. len=.. [er=..] [Q=..]');
      const b = { name: kw, line: ln, er: 1, Q: Infinity, A: [toks[1]], B: [toks[2]], Aline: ln, Bline: ln };
      let z0 = null, W = null, erSet = false;
      for (const x of toks.slice(3)) {
        const k = kv(x); if (!k) fail(ln, `unexpected "${x}"`);
        const key = k[0].toLowerCase();
        if (key === 'z0' || key === 'z') z0 = ev(k[1], ln);
        else if (key === 'w') W = ev(k[1], ln);
        else if (key === 'len') { b.lenStr = k[1]; b.lenLine = ln; }
        else if (key === 'er' || key === 'eeff') { b.er = ev(k[1], ln); erSet = true; }
        else if (key === 'q') { b.Q = ev(k[1], ln); b.Qset = true; }
        else if (key === 'f0') b.f0 = ev(k[1], ln);
        else fail(ln, `unknown T option ${k[0]}`);
      }
      if (W != null) {
        if (z0 != null || erSet) fail(ln, `${kw}: give either W= (microstrip on the .substrate) or Z0=/er=, not both`);
        b.spec = { kind: 'msl1' }; b.W = W;
      } else b.spec = { kind: 'y0', M: [[1 / (z0 ?? 50)]] };
      pendingSections.push(b);
      return;
    }
    fail(ln, `unrecognised statement "${kw}"`);
  };
  lines.forEach(handleLine);
  if (block) fail(block.line, `cline ${block.name} has no "end"`);

  if (!d.freq) fail(0, 'missing .freq START STOP POINTS');
  if (!d.ports.length) fail(0, 'no ports defined');
  const fref = d.fref ?? (d.freq.start + d.freq.stop) / 2;
  d.fref = fref;

  // ---- build sections ----
  for (const b of pendingSections) {
    const ln = b.line;
    if (b.W != null && b.spec?.kind !== 'msl1') {
      if (b.spec) fail(ln, `${b.name}: give either a geometry (W, S) or electrical line constants, not both`);
      if (b.geom && b.geom !== 'msl') fail(ln, `${b.name}: geometry "${b.geom}" not supported (only msl, coupled microstrip)`);
      if (b.model && !['closed', 'field'].includes(b.model)) fail(ln, `${b.name}: model is closed (closed-form pair) or field (field solver)`);
      const vec = Array.isArray(b.W) || Array.isArray(b.S);
      if (b.model === 'closed' && vec) fail(ln, `${b.name}: the closed-form model is for a symmetric pair (scalar W and S); use model=field for W=[…] S=[…]`);
      b.spec = { kind: vec || b.model === 'field' ? 'mslN' : 'msl2' };
      if (b.fingers && b.spec.kind !== 'msl2') fail(b.fingers.line, `${b.name}: fingers need a symmetric pair (scalar W and S, closed-form model)`);
    } else if (b.geom && b.W == null) fail(ln, `${b.name}: geom ${b.geom} needs W and S`);
    if (b.fingers && b.spec?.kind !== 'msl2') fail(b.fingers.line, `${b.name}: fingers need geom=msl W= S= (the backbones)`);
    if (b.model && b.W == null) fail(ln, `${b.name}: model= applies to a geometry (W and S)`);
    if (!b.spec) fail(ln, `${b.name}: no line parameters (Zeo, Y0, Z0, Cn, Cg/Cm, C+L, or W and S)`);
    const f0 = b.f0 ?? fref;
    let CL, geom = null;
    if (b.spec.kind === 'mslN') {
      if (!d.substrate) fail(ln, `${b.name}: a physical geometry (W=) needs a .substrate statement`);
      let W = b.W, S = b.S;
      if (S == null) S = [];
      if (!Array.isArray(W)) W = Array(Array.isArray(S) ? S.length + 1 : 2).fill(W);
      if (!Array.isArray(S)) S = Array(W.length - 1).fill(S);
      if (S.length !== W.length - 1) fail(ln, `${b.name}: ${W.length} strips need ${W.length - 1} gaps in S, got ${S.length}`);
      let fl;
      try { fl = fieldLines({ W, S, sub: d.substrate, f0 }); } catch (e) { fail(ln, `${b.name}: ${e.message}`); }
      CL = { C: fl.C, L: fl.L };
      for (const w of fl.warnings) { const m = `${b.name}: ${w}`; if (!d.warnings.includes(m)) d.warnings.push(m); }
      for (const w of fabCheck({ W: Math.min(...W), S: S.length ? Math.min(...S) : null }, d.substrate)) { const m = `${b.name}: ${w}`; if (!d.warnings.includes(m)) d.warnings.push(m); }
      if (!b.Qset) b.Q = fl.Q;
      if (W.length === 2 && W[0] === W[1]) {
        // a symmetric pair keeps the msl2 shape (layout templates use it)
        const Ce = fl.C[0][0] + fl.C[0][1], Co = fl.C[0][0] - fl.C[0][1], C0e = fl.C0[0][0] + fl.C0[0][1], C0o = fl.C0[0][0] - fl.C0[0][1];
        geom = { kind: 'msl2', model: 'field', W: W[0], S: S[0], Ze: 1 / (C0 * Math.sqrt(Ce * C0e)), Zo: 1 / (C0 * Math.sqrt(Co * C0o)), epse: Ce / C0e, epso: Co / C0o, f0 };
      } else geom = { kind: 'mslN', model: 'field', W, S, epsEff: fl.epsEff, f0 };
    }
    if (b.spec.kind === 'msl1' || b.spec.kind === 'msl2') {
      if (!d.substrate) fail(ln, `${b.name}: a physical geometry (W=) needs a .substrate statement`);
      const g = fromSubstrate(d.substrate);
      const warn = (list) => list.forEach(w => { const m = `${b.name}: ${w}`; if (!d.warnings.includes(m)) d.warnings.push(m); });
      try {
        if (b.spec.kind === 'msl1') {
          if (!(b.W > 0)) fail(ln, `${b.name}: W must be > 0`);
          const l = msline({ W: b.W, ...g, f: f0 });
          CL = fromY0([[1 / l.Z0]], l.epsEff);
          geom = { kind: 'msl1', W: b.W, Z0: l.Z0, epsEff: l.epsEff, f0 };
          if (!b.Qset) { const L = mslineLoss({ W: b.W, ...g, f: f0 }); b.Q = L.Q; geom.Q = L.Q; warn(L.warnings); } else warn(l.warnings);
          warn(fabCheck({ W: b.W }, d.substrate));
        } else {
          if (!(b.W > 0) || !(b.S > 0)) fail(ln, `${b.name}: coupled microstrip needs W and S (both > 0)`);
          const c = mscoupled({ W: b.W, S: b.S, ...g, f: f0 });
          CL = fromEvenOdd(c.Ze, c.Zo, c.epse, c.epso);
          geom = { kind: 'msl2', W: b.W, S: b.S, Ze: c.Ze, Zo: c.Zo, epse: c.epse, epso: c.epso, f0 };
          if (b.fingers) {
            // finger-loaded (#41): the section's modes as given (an openEMS extraction); the loss Q is the backbones'
            const fg = b.fingers, tip = b.S - fg.lf, side = fg.p / 2 - fg.wf;
            if (!(tip > 0)) fail(fg.line, `${b.name}: fingers ${fg.lf * 1e3} mm long reach the other backbone across S = ${b.S * 1e3} mm`);
            if (!(side > 0)) fail(fg.line, `${b.name}: fingers ${fg.wf * 1e3} mm wide do not fit a ${fg.p * 1e3} mm pitch`);
            CL = fromEvenOdd(fg.ze, fg.zo, fg.ee, fg.eo);
            geom = { ...geom, Ze: fg.ze, Zo: fg.zo, epse: fg.ee, epso: fg.eo, bare: { Ze: c.Ze, Zo: c.Zo, epse: c.epse, epso: c.epso },
              fingers: { wf: fg.wf, lf: fg.lf, p: fg.p, tip, side, overlap: 2 * fg.lf - b.S } };
            warn(fabCheck({ W: fg.wf, S: Math.min(tip, side) }, d.substrate).map(w => `fingers: ${w}`));
          }
          if (!b.Qset) {
            const L = mscoupledLoss({ W: b.W, S: b.S, ...g, f: f0 });
            geom.Qe = L.even.Q; geom.Qo = L.odd.Q;
            b.Q = (v) => (Math.abs(v[0] + v[1]) >= Math.abs(v[0] - v[1]) ? L.even.Q : L.odd.Q);
          }
          warn(c.warnings);
          warn(fabCheck({ W: b.W, S: b.S }, d.substrate));
        }
      } catch (e) { if (e.line) throw e; fail(ln, e.message); }
    }
    const sym = (M, what) => {
      if (!M.length || M.some(r => r.length !== M.length)) fail(ln, `${b.name}: ${what} must be square`);
      for (let i = 0; i < M.length; i++) for (let j = 0; j < i; j++) if (Math.abs(M[i][j] - M[j][i]) > 1e-9 * (Math.abs(M[i][j]) + Math.abs(M[j][i]) + 1e-300)) fail(ln, `${b.name}: ${what} not symmetric`);
      return M;
    };
    if (!CL) try {
      switch (b.spec.kind) {
        case 'zeo': {
          const [Ze, Zo, ee, eo] = b.spec.v;
          CL = fromEvenOdd(Ze, Zo, ee ?? b.er, eo ?? b.er); break;
        }
        case 'y0': CL = fromY0(sym(b.spec.M, 'Y0'), b.er); break;
        case 'z0': { // impedance matrix → invert
          const Z = sym(b.spec.M, 'Z0');
          CL = fromY0(rSymFunc(Z, x => 1 / x), b.er); break;
        }
        case 'cn': CL = fromCnorm(sym(b.spec.M, 'Cn'), b.er); break;
        case 'cgm': {
          if (!b.cg) fail(ln, `${b.name}: Cm/Cm(i,j) given without Cg`);
          const N = b.cg.length;
          const Cm = Array.from({ length: N }, () => new Array(N).fill(0));
          for (const { adj, ln: l2 } of b.cm || []) {
            if (adj.length !== N - 1) fail(l2, `${b.name}: Cm needs ${N - 1} adjacent values for ${N} lines`);
            adj.forEach((v, i) => { Cm[i][i + 1] = Cm[i + 1][i] = v; });
          }
          for (const { i, j, v } of b.cmx || []) { if (i >= N || j >= N || i === j) fail(ln, `${b.name}: bad Cm(${i + 1},${j + 1})`); Cm[i][j] = Cm[j][i] = v; }
          CL = fromCnorm(maxwellFromGroundMutual(b.cg, Cm), b.er); break;
        }
        case 'cl': {
          if (!b.Cmat || !b.Lmat) fail(ln, `${b.name}: need both C and L matrices`);
          CL = { C: sym(b.Cmat, 'C'), L: sym(b.Lmat, 'L') };
          if (CL.C.length !== CL.L.length) fail(ln, `${b.name}: C and L sizes differ`);
          break;
        }
      }
    } catch (e) { if (e.line) throw e; fail(ln, e.message); }
    const N = CL.C.length;
    if (!b.A || !b.B) fail(ln, `${b.name}: needs "A node..." and "B node..." end connections`);
    if (b.A.length !== N) fail(b.Aline, `${b.name}: A lists ${b.A.length} nodes, section has ${N} lines`);
    if (b.B.length !== N) fail(b.Bline, `${b.name}: B lists ${b.B.length} nodes, section has ${N} lines`);
    if (!b.lenStr) fail(ln, `${b.name}: missing len`);
    let lenAst; try { lenAst = parseExpr(b.lenStr); } catch (e) { fail(b.lenLine, e.message); }
    const lenVal = (() => { try { return evalReal(lenAst, d.scope); } catch (e) { fail(b.lenLine, e.message); } })();
    const isDeg = astHasDeg(lenAst);
    let sec;
    try {
      sec = new Section({
        name: b.name, C: CL.C, L: CL.L, Q: b.Q, ends: { A: b.A, B: b.B },
        // degrees: referenced to the mean of sqrt(eps_eff) over modes at f0
        len: isDeg ? (s) => { const nbar = s.v.reduce((a, v) => a + C0 / v, 0) / s.v.length; return lenVal / 360 * C0 / nbar / f0; } : lenVal,
      });
    } catch (e) { fail(ln, e.message); }
    sec.line = ln + 1;
    sec.geom = geom;
    d.sections.push(sec);
  }
  return d;
}

