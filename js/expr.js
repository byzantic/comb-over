import { idealS21 } from './synth-ideal.js';

// Numbers with SI suffixes, and a small expression language used for
// netlist values (real scalars) and plot traces (complex arrays over frequency).

const SI = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
const SPECIAL = { mil: 25.4e-6, in: 25.4e-3, deg: 1 }; // deg handled by caller semantics (kept as plain number)

// Interpret a unit/suffix string attached to a number. Returns multiplier, or throws.
export function suffixMultiplier(s) {
  if (!s) return 1;
  if (s in SPECIAL) return SPECIAL[s];
  if (s === 'meg' || s === 'Meg' || s === 'MEG') return 1e6;
  const c = s[0];
  if (c in SI) {
    const rest = s.slice(1);
    if (rest === 'mil') throw new Error(`ambiguous unit "${s}"`);
    if (rest === '' || /^[A-Za-zΩ]+$/.test(rest)) return SI[c];
  }
  // bare unit with no prefix: Hz, F, H, Ohm, S, V, A, Ω, m (metres caught above as milli only if alone)
  if (/^(Hz|F|H|Ohm|ohm|Ω|S|V|A|s|rad)$/.test(s)) return 1;
  throw new Error(`unknown unit suffix "${s}"`);
}

// ---------------- tokenizer ----------------
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?([A-Za-zµΩ]+)?/.exec(src.slice(i));
    if (num) {
      let v = parseFloat(num[1] + (num[2] || ''));
      const suf = num[3];
      let isDeg = false;
      if (suf) {
        if (suf === 'deg') isDeg = true;
        v *= suffixMultiplier(suf);
      }
      toks.push({ t: 'num', v, isDeg });
      i += num[0].length; continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i));   // dotted: dataset.S21
    if (id) { toks.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/^(),'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error(`unexpected character "${ch}" in "${src}"`);
  }
  return toks;
}

// ---------------- parser -> AST ----------------
// expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary)* ; unary := '-' unary | power
// power := atom ('^' unary)? ; atom := num | id | id '(' args ')' | '(' expr ')'
export function parseExpr(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (!t || t.v !== v) throw new Error(`expected "${v}" in "${src}"`); p++; return t; };
  function expr() {
    let a = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) { const op = toks[p++].v; a = { op, a, b: term() }; }
    return a;
  }
  function term() {
    let a = unary();
    while (peek() && (peek().v === '*' || peek().v === '/')) { const op = toks[p++].v; a = { op, a, b: unary() }; }
    return a;
  }
  function unary() {
    if (peek() && peek().v === '-' && peek().t === 'op') { p++; return { op: 'neg', a: unary() }; }
    if (peek() && peek().v === '+' && peek().t === 'op') { p++; return unary(); }
    return power();
  }
  function power() {
    const a = atom();
    if (peek() && peek().v === '^') { p++; return { op: '^', a, b: unary() }; }
    return a;
  }
  function atom() {
    const t = toks[p++];
    if (!t) throw new Error(`unexpected end of expression "${src}"`);
    if (t.t === 'num') return { num: t.v, isDeg: t.isDeg };
    if (t.t === 'id') {
      if (peek() && peek().v === '(') {
        p++;
        const args = [];
        if (peek() && peek().v !== ')') { args.push(expr()); while (peek() && peek().v === ',') { p++; args.push(expr()); } }
        eat(')');
        return { fn: t.v, args };
      }
      return { id: t.v };
    }
    if (t.v === '(') { const e = expr(); eat(')'); return e; }
    throw new Error(`unexpected "${t.v}" in "${src}"`);
  }
  const ast = expr();
  if (p !== toks.length) throw new Error(`trailing input in "${src}"`);
  return ast;
}

// Does the expression consist of a single number with a 'deg' suffix, or end in deg (e.g. "theta*1deg")?
export function astHasDeg(ast) {
  if (!ast || typeof ast !== 'object') return false;
  if (ast.isDeg) return true;
  return astHasDeg(ast.a) || astHasDeg(ast.b) || (ast.args || []).some(astHasDeg);
}

// ---------------- real evaluation ----------------
const RFN = {
  sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, atan2: Math.atan2, exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10,
  abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, acosh: Math.acosh, asinh: Math.asinh, atanh: Math.atanh,
  db2mag: x => 10 ** (x / 20), mag2db: x => 20 * Math.log10(x),
  sind: x => Math.sin(x * Math.PI / 180), cosd: x => Math.cos(x * Math.PI / 180), tand: x => Math.tan(x * Math.PI / 180),
  cotd: x => 1 / Math.tan(x * Math.PI / 180), cot: x => 1 / Math.tan(x),
};
const RCONST = { pi: Math.PI, c0: 299792458, mu0: 4e-7 * Math.PI, eps0: 1 / (4e-7 * Math.PI * 299792458 ** 2), eta0: 4e-7 * Math.PI * 299792458, e: Math.E };

export function evalReal(ast, scope = {}) {
  if ('num' in ast) return ast.num;
  if ('id' in ast) {
    if (ast.id in scope) return scope[ast.id];
    if (ast.id in RCONST) return RCONST[ast.id];
    throw new Error(`undefined name "${ast.id}"`);
  }
  if ('fn' in ast) {
    const f = RFN[ast.fn];
    if (!f) throw new Error(`unknown function "${ast.fn}"`);
    return f(...ast.args.map(a => evalReal(a, scope)));
  }
  const a = evalReal(ast.a, scope);
  switch (ast.op) {
    case 'neg': return -a;
    case '+': return a + evalReal(ast.b, scope);
    case '-': return a - evalReal(ast.b, scope);
    case '*': return a * evalReal(ast.b, scope);
    case '/': return a / evalReal(ast.b, scope);
    case '^': return a ** evalReal(ast.b, scope);
  }
  throw new Error('bad expression');
}

export function evalRealStr(s, scope) { return evalReal(parseExpr(s), scope); }

// Identifiers referenced by an expression (for dependency checks).
export function astIds(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.id) out.add(ast.id);
  astIds(ast.a, out); astIds(ast.b, out);
  (ast.args || []).forEach(a => astIds(a, out));
  return out;
}

// ---------------- complex-array evaluation (plot traces) ----------------
// A value is {re: Float64Array, im: Float64Array, unit?: string}. ctx: {n, freq:Float64Array, S(i,j)->value}
function cconst(n, re, im = 0) { return { re: new Float64Array(n).fill(re), im: new Float64Array(n).fill(im) }; }
function unwrapDeg(ph) {
  const out = Float64Array.from(ph);
  for (let k = 1; k < out.length; k++) {
    let d = out[k] - out[k - 1];
    if (!isFinite(d)) continue;
    while (d > 180) { out[k] -= 360; d -= 360; }
    while (d < -180) { out[k] += 360; d += 360; }
  }
  return out;
}
function realOut(n, f, unit) { const re = new Float64Array(n); for (let k = 0; k < n; k++) re[k] = f(k); return { re, im: new Float64Array(n), unit, real: true }; }

const scalarArg = (x, name) => { const v = x.re[0]; if (!x.re.every(y => y === v)) throw new Error(`${name}: arguments must be constants`); return v; };
const CFN = {
  // ideal band-pass prototype responses |S21| (real):  cheby(n, ripple_dB, f0, fbw), butter(n, f0, fbw)
  cheby: (ctx, n, r, f0, fbw) => realOut(ctx.n, k => idealS21('chebyshev', scalarArg(n, 'cheby'), scalarArg(r, 'cheby'), scalarArg(f0, 'cheby'), scalarArg(fbw, 'cheby'), ctx.freq[k]), ''),
  butter: (ctx, n, f0, fbw) => realOut(ctx.n, k => idealS21('butterworth', scalarArg(n, 'butter'), 0, scalarArg(f0, 'butter'), scalarArg(fbw, 'butter'), ctx.freq[k]), ''),
  db: (ctx, x) => realOut(ctx.n, k => 20 * Math.log10(Math.hypot(x.re[k], x.im[k])), 'dB'),
  db10: (ctx, x) => realOut(ctx.n, k => 10 * Math.log10(Math.hypot(x.re[k], x.im[k])), 'dB'),
  mag: (ctx, x) => realOut(ctx.n, k => Math.hypot(x.re[k], x.im[k]), ''),
  abs: (ctx, x) => realOut(ctx.n, k => Math.hypot(x.re[k], x.im[k]), ''),
  ang: (ctx, x) => realOut(ctx.n, k => Math.atan2(x.im[k], x.re[k]) * 180 / Math.PI, '°'),
  angu: (ctx, x) => { const v = realOut(ctx.n, k => Math.atan2(x.im[k], x.re[k]) * 180 / Math.PI, '°'); v.re = unwrapDeg(v.re); return v; },
  re: (ctx, x) => realOut(ctx.n, k => x.re[k], ''),
  im: (ctx, x) => realOut(ctx.n, k => x.im[k], ''),
  conj: (ctx, x) => ({ re: x.re, im: x.im.map(v => -v) }),
  vswr: (ctx, x) => realOut(ctx.n, k => { const g = Math.hypot(x.re[k], x.im[k]); return (1 + g) / (1 - g); }, ''),
  // group delay  -dphi/domega  (seconds)
  gd: (ctx, x) => {
    const ph = unwrapDeg(Float64Array.from({ length: ctx.n }, (_, k) => Math.atan2(x.im[k], x.re[k]) * 180 / Math.PI));
    const f = ctx.freq, n = ctx.n;
    return realOut(n, k => {
      const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
      if (a === b) return NaN;
      return -((ph[b] - ph[a]) * Math.PI / 180) / (2 * Math.PI * (f[b] - f[a]));
    }, 's');
  },
  sqrt: (ctx, x) => {
    const re = new Float64Array(ctx.n), im = new Float64Array(ctx.n);
    for (let k = 0; k < ctx.n; k++) { const r = Math.hypot(x.re[k], x.im[k]), t = Math.atan2(x.im[k], x.re[k]) / 2; re[k] = Math.sqrt(r) * Math.cos(t); im[k] = Math.sqrt(r) * Math.sin(t); }
    return { re, im };
  },
};

export function evalTrace(ast, ctx) {
  const n = ctx.n;
  if ('num' in ast) return cconst(n, ast.num);
  if ('id' in ast) {
    const dot = ast.id.indexOf('.');
    if (dot > 0) {                                    // imported data: NAME.S21 / NAME.S_10_3 (issue #17)
      const name = ast.id.slice(0, dot), v = ast.id.slice(dot + 1), ds = ctx.data?.[name];
      if (!ds) throw new Error(`unknown data set "${name}" (load it with .data ${name} FILE)`);
      const m = /^S(\d)(\d)$/.exec(v) || /^S_(\d+)_(\d+)$/.exec(v);
      if (!m) throw new Error(`${ast.id}: use ${name}.S21 or ${name}.S_10_3`);
      return ds.S(+m[1], +m[2]);
    }
    const m = /^S(\d)(\d)$/.exec(ast.id) || /^S_(\d+)_(\d+)$/.exec(ast.id);
    if (m) return ctx.S(+m[1], +m[2]);
    if (ast.id === 'f' || ast.id === 'freq') return { re: ctx.freq, im: new Float64Array(n) };
    if (ast.id === 'j') return cconst(n, 0, 1);
    if (ast.id in RCONST) return cconst(n, RCONST[ast.id]);
    if (ctx.scope && ast.id in ctx.scope) return cconst(n, ctx.scope[ast.id]);
    throw new Error(`unknown trace variable "${ast.id}" (use S21, S_10_3, f, j)`);
  }
  if ('fn' in ast) {
    if (ast.fn === 'S' && ast.args.length === 2) {
      const i = evalReal(ast.args[0], ctx.scope || {}), j = evalReal(ast.args[1], ctx.scope || {});
      return ctx.S(i, j);
    }
    const f = CFN[ast.fn];
    if (!f) throw new Error(`unknown trace function "${ast.fn}"`);
    return f(ctx, ...ast.args.map(a => evalTrace(a, ctx)));
  }
  const a = evalTrace(ast.a, ctx);
  if (ast.op === 'neg') return { re: a.re.map(v => -v), im: a.im.map(v => -v) };
  const b = evalTrace(ast.b, ctx);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ar = a.re[k], ai = a.im[k], br = b.re[k], bi = b.im[k];
    switch (ast.op) {
      case '+': re[k] = ar + br; im[k] = ai + bi; break;
      case '-': re[k] = ar - br; im[k] = ai - bi; break;
      case '*': re[k] = ar * br - ai * bi; im[k] = ar * bi + ai * br; break;
      case '/': { const d = br * br + bi * bi; re[k] = (ar * br + ai * bi) / d; im[k] = (ai * br - ar * bi) / d; break; }
      case '^': { // complex power with real exponent
        const r = Math.hypot(ar, ai) ** br, t = Math.atan2(ai, ar) * br; re[k] = r * Math.cos(t); im[k] = r * Math.sin(t); break;
      }
    }
  }
  const out = { re, im };
  if (a.real && b.real) { out.real = true; out.unit = (ast.op === '+' || ast.op === '-') && a.unit === b.unit ? a.unit : ''; }
  return out;
}
