import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { evalTrace, parseExpr } from './expr.js';
import { drawRect, drawSmith, rectIndexAt, palette } from './plot.js';
import { touchstone } from './touchstone.js';
import { optimise, writeBack, fmtSI, goalCost } from './optimize.js';
import { HELP_HTML } from './help.js';

const $ = (id) => document.getElementById(id);
const editor = $('editor'), gutter = $('gutter'), status = $('status');
const STORE = 'comb-over:netlist';

let state = { d: null, res: null, overrides: {}, hoverK: null, plots: [], paramSig: '', optRunning: false };

// ---------- editor ----------
function updateGutter(errLine) {
  const n = editor.value.split('\n').length;
  let s = '';
  for (let i = 1; i <= n; i++) s += i === errLine ? `<span class="err">${i}</span>\n` : `${i}\n`;
  gutter.innerHTML = s;
  gutter.scrollTop = editor.scrollTop;
}
editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
let debounce;
editor.addEventListener('input', () => {
  state.overrides = {};
  updateGutter();
  clearTimeout(debounce); debounce = setTimeout(run, 350);
});
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
});

function setStatus(msg, cls = '') { status.textContent = msg; status.className = 'status ' + cls; }

// ---------- run ----------
function run() {
  const text = editor.value;
  try { localStorage.setItem(STORE, text); } catch {}
  let d, res;
  const t0 = performance.now();
  try {
    d = parseNetlist(text, state.overrides);
    res = solve(d);
  } catch (e) {
    setStatus(e.message, 'err');
    updateGutter(e.line);
    return;
  }
  updateGutter();
  state.d = d; state.res = res;
  const ms = (performance.now() - t0).toFixed(0);
  let msg = `${d.ports.length} ports · ${res.nodeCount} nodes · ${d.sections.length} line section(s) · ${res.freq.length} pts · ${ms} ms`;
  if (res.failures) msg += `\n${res.failures} frequency point(s) singular (shown as gaps)`;
  if (d.goals.length) {
    const { cost, report } = goalCost(d, res);
    msg += `\ngoals: cost ${cost.toExponential(2)}` + report.map(r => `\n  ${r.goal.src} ${r.goal.op} ${r.goal.value}: worst violation ${r.maxViolation.toPrecision(3)}`).join('');
  }
  d.warnings.forEach(w => msg += `\n${w}`);
  setStatus(msg, 'ok');
  renderTune(d);
  renderInfo(d);
  renderPlots(d, res);
}

// ---------- tuning sliders ----------
const SL = 1000;
function sliderMap(p) {
  const { lo, hi } = p.tune, log = lo > 0 && hi / lo > 10;
  return {
    toVal: (s) => log ? lo * (hi / lo) ** (s / SL) : lo + (hi - lo) * s / SL,
    toPos: (v) => Math.round(SL * (log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo))),
  };
}
function renderTune(d) {
  const tuned = d.params.filter(p => p.tune);
  const sig = tuned.map(p => `${p.name}:${p.tune.lo}:${p.tune.hi}:${p.expr}`).join('|');
  const box = $('tune');
  if (sig === state.paramSig) { // just refresh values
    tuned.forEach(p => {
      const row = box.querySelector(`[data-p="${p.name}"]`); if (!row) return;
      row.querySelector('.val').textContent = fmtSI(p.value, 4);
      row.classList.toggle('changed', p.name in state.overrides);
      if (document.activeElement !== row.querySelector('input')) row.querySelector('input').value = sliderMap(p).toPos(p.value);
    });
    return;
  }
  state.paramSig = sig;
  if (!tuned.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3>Tune <span><button id="btn-apply" title="Write slider values into the netlist">Write to netlist</button> <button id="btn-reset">Reset</button></span></h3>`;
  for (const p of tuned) {
    const m = sliderMap(p);
    const row = document.createElement('div');
    row.className = 'slider'; row.dataset.p = p.name;
    row.innerHTML = `<span>${p.name}</span><input type="range" min="0" max="${SL}" value="${m.toPos(p.value)}"><span class="val">${fmtSI(p.value, 4)}</span>`;
    row.querySelector('input').addEventListener('input', (e) => {
      state.overrides[p.name] = m.toVal(+e.target.value);
      requestAnimationFrame(run);
    });
    box.appendChild(row);
  }
  $('btn-apply').onclick = () => { editor.value = writeBack(editor.value, state.overrides); state.overrides = {}; state.paramSig = ''; run(); };
  $('btn-reset').onclick = () => { state.overrides = {}; state.paramSig = ''; run(); };
}

// ---------- section info ----------
function renderInfo(d) {
  const box = $('info');
  const secs = d.sections.filter(s => s.N > 1 || d.sections.length <= 4);
  if (!secs.length) { box.innerHTML = ''; return; }
  let h = '<h3>Line sections</h3>';
  for (const s of secs) {
    const modes = s.modalInfo();
    h += `<table class="modes"><caption>${s.name} · ${s.N} line${s.N > 1 ? 's' : ''} · ℓ = ${(s.len * 1e3).toPrecision(5)} mm${isFinite(s.Q) ? ` · Q = ${s.Q}` : ''}</caption>
      <tr><th>mode</th><th>ε<sub>eff</sub></th><th>v/c</th><th>Z<sub>mode</sub> Ω</th><th style="text-align:left;padding-left:12px">voltage vector</th></tr>`;
    modes.forEach((m, i) => {
      h += `<tr><td>${i + 1}</td><td>${m.epsEff.toFixed(4)}</td><td>${(1 / Math.sqrt(m.epsEff)).toFixed(4)}</td><td>${m.Z.toPrecision(4)}</td><td style="text-align:left;padding-left:12px">[${m.vector.map(x => x.toFixed(3)).join(' ')}]</td></tr>`;
    });
    h += '</table>';
  }
  box.innerHTML = h;
}

// ---------- plots ----------
function defaultPlots(d) {
  const P = d.ports.length, tr = [];
  for (let i = 1; i <= Math.min(P, 8); i++) tr.push(`db(S_${i}_1)`);
  return [{ kind: 'plot', traces: tr.map(src => ({ src, ast: parseExpr(src) })), ylim: null }];
}
function renderPlots(d, res) {
  const box = $('plots');
  const specs = d.plots.length ? d.plots : defaultPlots(d);
  const ctx = { n: res.freq.length, freq: res.freq, S: (i, j) => res.S(i, j), scope: d.scope };
  const sig = specs.map(p => p.kind + p.traces.map(t => t.src).join(',')).join('|');
  if (sig !== box.dataset.sig) {
    box.dataset.sig = sig; box.innerHTML = '';
    state.plots = specs.map((p, pi) => {
      const el = document.createElement('div');
      el.className = 'plot ' + (p.kind === 'smith' ? 'smith' : '');
      el.innerHTML = `<div class="ptitle"><span>${p.title ?? p.traces.map(t => t.src).join(', ')}</span><span class="readout"></span></div><canvas></canvas><div class="legend"></div>`;
      box.appendChild(el);
      const cv = el.querySelector('canvas');
      const hover = (e) => {
        if (!state.res) return;
        let k;
        if (p.kind === 'smith') k = state.hoverK; else k = rectIndexAt(cv, e.clientX, state.res.freq);
        if (k == null) return;
        state.hoverK = k; drawAll();
      };
      cv.addEventListener('pointermove', hover);
      cv.addEventListener('pointerleave', () => { state.hoverK = null; drawAll(); });
      return { el, cv };
    });
  }
  // evaluate traces
  state.plotData = specs.map(p => p.traces.map(t => {
    try { const v = evalTrace(t.ast, ctx); return { label: t.src, x: res.freq, y: v.re, re: v.re, im: v.im, unit: v.unit }; }
    catch (e) { return { label: t.src + ' — ' + e.message, x: res.freq, y: new Float64Array(res.freq.length).fill(NaN), re: [], im: [], err: true }; }
  }));
  state.specs = specs;
  drawAll();
}
function drawAll() {
  if (!state.specs) return;
  const pal = palette();
  const k = state.hoverK;
  state.specs.forEach((p, i) => {
    const { el, cv } = state.plots[i];
    const data = state.plotData[i];
    if (p.kind === 'smith') drawSmith(cv, data, { hoverK: k });
    else drawRect(cv, data, { ylim: p.ylim, hoverK: k });
    const fmtV = (t) => {
      if (k == null || t.err) return '';
      if (p.kind === 'smith') { const g = Math.hypot(t.re[k], t.im[k]); return `|Γ| ${g.toFixed(3)} ∠${(Math.atan2(t.im[k], t.re[k]) * 180 / Math.PI).toFixed(1)}°`; }
      const v = t.y[k];
      return t.unit === 's' ? fmtSI(v, 4) + 's' : (+v.toPrecision(5)) + (t.unit || '');
    };
    el.querySelector('.legend').innerHTML = data.map((t, j) => `<span><span class="sw" style="background:${pal[j % pal.length]}"></span>${t.label}<span class="v">${fmtV(t)}</span></span>`).join('');
    el.querySelector('.readout').textContent = k != null ? fmtSI(state.res.freq[k], 6) + 'Hz' : '';
  });
}
window.addEventListener('resize', () => requestAnimationFrame(drawAll));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);

// ---------- optimiser ----------
$('btn-opt').onclick = async () => {
  const btn = $('btn-opt');
  if (state.optRunning) { state.optRunning = false; return; }
  let text = writeBack(editor.value, state.overrides);
  let gen;
  try { gen = optimise(text); } catch (e) { setStatus(e.message, 'err'); return; }
  state.optRunning = true; btn.textContent = 'Stop'; btn.classList.add('running');
  let last = null, lastDraw = 0;
  try {
    while (state.optRunning) {
      const t = performance.now();
      let s;
      while (performance.now() - t < 40) { s = gen.next(); last = s.value; if (s.done) break; }
      if (performance.now() - lastDraw > 150 || s.done) {
        lastDraw = performance.now();
        state.overrides = { ...last.best };
        run();
        setStatus(`optimising… iter ${last.iter}, ${last.evals} evals, cost ${last.cost.toExponential(3)}`, '');
      }
      if (s.done) break;
      await new Promise(r => setTimeout(r, 0));
    }
  } catch (e) { setStatus(e.message, 'err'); }
  state.optRunning = false; btn.textContent = 'Optimise'; btn.classList.remove('running');
  if (last) { editor.value = writeBack(editor.value, last.best); state.overrides = {}; state.paramSig = ''; run(); }
};

// ---------- files / export ----------
function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const baseName = () => (state.d?.title || 'network').replace(/[^\w.-]+/g, '_').slice(0, 40);
$('btn-save').onclick = () => download(baseName() + '.cir', editor.value);
$('btn-open').onclick = () => $('file-in').click();
$('file-in').onchange = async (e) => { const f = e.target.files[0]; if (f) { editor.value = await f.text(); state.overrides = {}; run(); } };
$('btn-ts').onclick = () => {
  if (!state.res) return;
  download(`${baseName()}.s${state.res.P}p`, touchstone(state.res, state.d.ports, { title: state.d.title || 'comb-over', format: $('ts-fmt').value }));
};
$('btn-run').onclick = run;
$('btn-share').onclick = async () => {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(editor.value)));
  const url = location.href.split('#')[0] + '#n=' + encodeURIComponent(b64);
  try { await navigator.clipboard.writeText(url); setStatus('link copied to clipboard', 'ok'); }
  catch { history.replaceState(null, '', url); setStatus('link placed in the address bar', 'ok'); }
};
$('btn-help').onclick = () => { $('help-body').innerHTML = HELP_HTML; $('help').showModal(); };

// ---------- presets ----------
async function loadPresets() {
  const sel = $('preset');
  let list = [];
  try { list = await (await fetch('examples/index.json')).json(); } catch {}
  sel.innerHTML = '<option value="">Examples…</option>' + list.map(e => `<option value="${e.file}">${e.name}</option>`).join('');
  sel.onchange = async () => {
    if (!sel.value) return;
    const t = await (await fetch('examples/' + sel.value)).text();
    editor.value = t; state.overrides = {}; state.paramSig = ''; state.hoverK = null; run();
    sel.value = '';
  };
  return list;
}

(async function init() {
  const list = await loadPresets();
  let text = null;
  const m = /#n=(.*)$/.exec(location.hash);
  if (m) { try { text = new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(m[1])), c => c.charCodeAt(0))); } catch {} }
  if (!text) { try { text = localStorage.getItem(STORE); } catch {} }
  if (!text && list.length) text = await (await fetch('examples/' + list[0].file)).text();
  editor.value = text || '.freq 1G 3G 201\nport a\nport b\nT1 a b Z0=50 len=90deg\n';
  run();
})();
