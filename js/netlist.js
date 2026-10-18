// Netlist parser. See README.md for the language. Produces a plain "design" object
// whose numeric values are already evaluated (with optional parameter overrides).

import { parseExpr, evalReal, astHasDeg } from './expr.js';
import { Section, fromY0, fromCnorm, fromEvenOdd, maxwellFromGroundMutual, C0 } from './section.js';
import { rSymFunc } from './linalg.js';
import { makeSubstrate, scopeOf, KEYS as SUB_KEYS } from './substrates.js';

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
    plots: [], goals: [], opt: { maxiter: 400 }, warnings: [],
  };
  const fail = (ln, msg) => { const e = new Error(`line ${ln + 1}: ${msg}`); e.line = ln + 1; throw e; };
  const ev = (s, ln) => {
    try { return evalReal(parseExpr(s), d.scope); } catch (e) { fail(ln, e.message); }
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

  lines.forEach((raw, ln) => {
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
        case 'q': block.Q = ev(args[0], ln); break;
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
    if (kwl === '.opt') { for (const x of toks.slice(1)) { const k = kv(x); if (k) d.opt[k[0]] = ev(k[1], ln); } return; }
    if (kwl.startsWith('.')) { d.warnings.push(`line ${ln + 1}: unknown directive ${kw} ignored`); return; }

    if (kwl === 'cline') {
      if (!toks[1]) fail(ln, 'cline needs a name');
      block = { name: toks[1], line: ln, er: 1, Q: Infinity };
      // allow inline key=value on the cline line
      for (const x of toks.slice(2)) { const k = kv(x); if (!k) fail(ln, `unexpected "${x}"`); const key = k[0].toLowerCase(); if (key === 'len') { block.lenStr = k[1]; block.lenLine = ln; } else if (key === 'er') block.er = ev(k[1], ln); else if (key === 'q') block.Q = ev(k[1], ln); else if (key === 'f0') block.f0 = ev(k[1], ln); else fail(ln, `unknown cline option ${k[0]}`); }
      return;
    }
    if (kwl === 'port') {
      if (toks.length < 2) fail(ln, 'port NODE [Z0]');
      d.ports.push({ node: toks[1], z: toks[2] ? ev(toks[2].replace(/^z0?=/i, ''), ln) : 50, line: ln + 1 });
      return;
    }
    if (kwl === 'wire') { for (let i = 2; i < toks.length; i++) d.wires.push([toks[1], toks[i]]); return; }

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
      let z0 = 50;
      for (const x of toks.slice(3)) {
        const k = kv(x); if (!k) fail(ln, `unexpected "${x}"`);
        const key = k[0].toLowerCase();
        if (key === 'z0' || key === 'z') z0 = ev(k[1], ln);
        else if (key === 'len') { b.lenStr = k[1]; b.lenLine = ln; }
        else if (key === 'er' || key === 'eeff') b.er = ev(k[1], ln);
        else if (key === 'q') b.Q = ev(k[1], ln);
        else if (key === 'f0') b.f0 = ev(k[1], ln);
        else fail(ln, `unknown T option ${k[0]}`);
      }
      b.spec = { kind: 'y0', M: [[1 / z0]] };
      pendingSections.push(b);
      return;
    }
    fail(ln, `unrecognised statement "${kw}"`);
  });
  if (block) fail(block.line, `cline ${block.name} has no "end"`);

  if (!d.freq) fail(0, 'missing .freq START STOP POINTS');
  if (!d.ports.length) fail(0, 'no ports defined');
  const fref = d.fref ?? (d.freq.start + d.freq.stop) / 2;
  d.fref = fref;

  // ---- build sections ----
  for (const b of pendingSections) {
    const ln = b.line;
    if (!b.spec) fail(ln, `${b.name}: no line parameters (Zeo, Y0, Z0, Cn, Cg/Cm, or C+L)`);
    let CL;
    const sym = (M, what) => {
      if (!M.length || M.some(r => r.length !== M.length)) fail(ln, `${b.name}: ${what} must be square`);
      for (let i = 0; i < M.length; i++) for (let j = 0; j < i; j++) if (Math.abs(M[i][j] - M[j][i]) > 1e-9 * (Math.abs(M[i][j]) + Math.abs(M[j][i]) + 1e-300)) fail(ln, `${b.name}: ${what} not symmetric`);
      return M;
    };
    try {
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
    const f0 = b.f0 ?? fref;
    let sec;
    try {
      sec = new Section({
        name: b.name, C: CL.C, L: CL.L, Q: b.Q, ends: { A: b.A, B: b.B },
        // degrees: referenced to the mean of sqrt(eps_eff) over modes at f0
        len: isDeg ? (s) => { const nbar = s.v.reduce((a, v) => a + C0 / v, 0) / s.v.length; return lenVal / 360 * C0 / nbar / f0; } : lenVal,
      });
    } catch (e) { fail(ln, e.message); }
    sec.line = ln + 1;
    d.sections.push(sec);
  }
  return d;
}

