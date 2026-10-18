import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { evalTrace, parseExpr } from './expr.js';
import { drawRect, drawSmith, rectIndexAt, palette } from './plot.js';
import { touchstone } from './touchstone.js';
import { optimise, writeBack, fmtSI, goalCost } from './optimize.js';
import { HELP_HTML } from './help.js';
import { design, returnLossDb } from './synth.js';
import { evalRealStr } from './expr.js';
import { buildLayout } from './layout-templates.js';
import { toSVG } from './layout.js';

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
  renderLayout(d);
}

// ---------- layout preview (.layout) ----------
function renderLayout(d) {
  const box = $('layout-card');
  if (!d.layout) { box.innerHTML = ''; state.layout = null; return; }
  let L;
  try { L = buildLayout(d); } catch (e) {
    box.innerHTML = `<div class="plot layout-card"><div class="ptitle"><span>Layout</span></div><ul class="drc bad"><li>${esc(e.message)}</li></ul></div>`;
    state.layout = null; return;
  }
  state.layout = L;
  const ok = !L.errors.length;
  box.innerHTML = `<div class="plot layout-card">
    <div class="ptitle"><span>Layout · ${esc(L.type)} · ${L.size[0].toFixed(1)} × ${L.size[1].toFixed(1)} mm · ${esc(L.substrate.name)}</span>
      <span><button id="btn-asbuilt" title="Open the netlist of the layout, including its feed lines">As-built netlist</button> <button id="btn-svg">SVG</button></span></div>
    <div class="svgbox">${toSVG(L, { errors: L.errors })}</div>
    <ul class="drc ${ok ? 'ok' : 'bad'}">${ok ? '<li>✓ design rules met</li>' : L.errors.map(e => `<li>${esc(e.msg)}</li>`).join('')}</ul>
    ${L.notes.length ? `<ul class="lnotes">${L.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>`;
  $('btn-svg').onclick = () => download(`${baseName()}-layout.svg`, toSVG(L), 'image/svg+xml');
  $('btn-asbuilt').onclick = () => { const prev = editor.value; editor.value = L.netlist; state.overrides = {}; state.paramSig = ''; run(); offerRestore(prev, 'the as-built netlist'); };
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
const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function substrateHTML(sub) {
  const d = sub.dielectric, c = sub.copper, f = sub.fab;
  const um = (x) => x == null ? '—' : `${+(x * 1e6).toPrecision(4)} µm`;
  const mmv = (x) => x == null ? '—' : `${+(x * 1e3).toPrecision(4)} mm`;
  const rows = [
    ['dielectric', `${esc(d.material)}, h = ${mmv(d.h)}`],
    ['ε<sub>r</sub> / tan δ', `${d.er} / ${d.tand} at ${+(d.fTand / 1e9).toPrecision(3)} GHz`],
    ['copper', `${um(c.t)}, σ = ${(c.sigma / 1e7).toPrecision(3)}×10⁷ S/m${c.roughness != null ? `, roughness ${um(c.roughness)}` : ''}`],
    ['min trace / space / drill', `${mmv(f.minTrace)} / ${mmv(f.minSpace)} / ${mmv(f.minDrill)}`],
  ];
  let h = `<h3>Substrate</h3><table class="modes sub"><caption>${esc(sub.name)}</caption>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
  const li = (a) => a.map(x => `<li>${esc(x)}</li>`).join('');
  if (sub.assumptions.length || sub.notes.length || sub.sources.length) {
    h += `<details class="sub-notes"><summary>${sub.assumptions.length ? `${sub.assumptions.length} assumption${sub.assumptions.length > 1 ? 's' : ''}, ` : ''}notes and sources</summary>`;
    if (sub.assumptions.length) h += `<p class="label">Assumed (not from the sources):</p><ul>${li(sub.assumptions)}</ul>`;
    if (sub.notes.length) h += `<p class="label">Notes:</p><ul>${li(sub.notes)}</ul>`;
    if (sub.sources.length) h += `<p class="label">Sources:</p><ul>${sub.sources.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(new URL(x.url).hostname + new URL(x.url).pathname)}</a> — ${esc(x.what)} (accessed ${esc(x.accessed)})</li>`).join('')}</ul>`;
    h += '</details>';
  }
  return h;
}

function renderInfo(d) {
  const box = $('info');
  const secs = d.sections.filter(s => s.N > 1 || d.sections.length <= 4);
  if (!secs.length && !d.substrate) { box.innerHTML = ''; return; }
  let h = d.substrate ? substrateHTML(d.substrate) : '';
  if (secs.length) h += '<h3>Line sections</h3>';
  for (const s of secs) {
    const modes = s.modalInfo();
    const qs = [...new Set(s.Qm.map(q => (isFinite(q) && q < 1e20 ? +q.toPrecision(3) : null)))].filter(q => q != null);
    const mm = (x) => +(x * 1e3).toPrecision(4);
    let geo = '';
    if (s.geom?.kind === 'msl1') geo = `<br><span class="geo">microstrip W ${mm(s.geom.W)} mm → Z0 ${s.geom.Z0.toFixed(2)} Ω, ε<sub>eff</sub> ${s.geom.epsEff.toFixed(3)} at ${+(s.geom.f0 / 1e9).toPrecision(4)} GHz</span>`;
    if (s.geom?.kind === 'msl2') geo = `<br><span class="geo">coupled microstrip W ${mm(s.geom.W)} mm, S ${mm(s.geom.S)} mm → Z<sub>e</sub> ${s.geom.Ze.toFixed(2)} Ω, Z<sub>o</sub> ${s.geom.Zo.toFixed(2)} Ω at ${+(s.geom.f0 / 1e9).toPrecision(4)} GHz</span>`;
    h += `<table class="modes"><caption>${s.name} · ${s.N} line${s.N > 1 ? 's' : ''} · ℓ = ${(s.len * 1e3).toPrecision(5)} mm${qs.length ? ` · Q ${qs.join(' / ')}` : ''}${geo}</caption>
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

// ---------- synthesis ----------
{
  const dlg = $('synth'), form = $('synth-form'), msg = $('synth-msg');
  const SKEY = 'comb-over:synth';
  try { const saved = JSON.parse(localStorage.getItem(SKEY) || 'null'); if (saved) for (const [k, v] of Object.entries(saved)) { const el = form.elements[k]; if (el) el.type === 'checkbox' ? (el.checked = v) : (el.value = v); } } catch {}
  const sync = () => {
    dlg.classList.toggle('hide-comb', form.elements.structure.value !== 'comb');
    const cheb = form.elements.type.value === 'chebyshev';
    form.elements.ripple.disabled = !cheb;
    const r = parseFloat(form.elements.ripple.value);
    form.querySelector('.rl').textContent = cheb && r > 0 ? `return loss ${returnLossDb(r).toFixed(2)} dB` : '';
  };
  form.addEventListener('input', sync);
  $('btn-synth').onclick = () => { msg.textContent = ''; msg.className = 'status'; sync(); dlg.showModal(); };
  $('synth-go').onclick = (e) => {
    e.preventDefault();
    const F = form.elements;
    const num = (name) => { const v = evalRealStr(F[name].value, {}); if (!isFinite(v)) throw new Error(`${name}: not a number`); return v; };
    let r;
    try {
      const spec = {
        structure: F.structure.value, type: F.type.value, n: Math.round(num('n')), ripple: F.type.value === 'chebyshev' ? num('ripple') : 0,
        f0: num('f0'), fbw: num('fbw') / 100, theta0Deg: num('theta0Deg'), Zr: num('Zr'), er: num('er'), R0: num('R0'), refine: F.refine.checked,
      };
      msg.textContent = 'synthesising…'; msg.className = 'status';
      r = design(spec);
    } catch (err) { msg.textContent = err.message; msg.className = 'status err'; return; }
    try { localStorage.setItem(SKEY, JSON.stringify(Object.fromEntries([...form.elements].filter(x => x.name).map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])))); } catch {}
    dlg.close();
    editor.value = r.netlist; state.overrides = {}; state.paramSig = ''; state.hoverK = null; run();
    if (F.polish.checked && r.spec.type === 'chebyshev') $('btn-opt').click();
  };
}

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

// A netlist loaded from a link (?example= or #n=) replaces the editor; keep what was there so it
// can be restored with one click.
function offerRestore(prev, what) {
  const box = $('notice');
  if (!prev || prev === editor.value) { box.hidden = true; return; }
  try { localStorage.setItem(STORE + ':previous', prev); } catch {}
  box.innerHTML = `<span>Loaded ${what}. Your previous netlist was kept.</span> <button id="btn-restore">Restore it</button> <button id="btn-dismiss" title="Dismiss">×</button>`;
  box.hidden = false;
  $('btn-restore').onclick = () => { editor.value = prev; state.overrides = {}; state.paramSig = ''; box.hidden = true; run(); };
  $('btn-dismiss').onclick = () => { box.hidden = true; };
}

(async function init() {
  const list = await loadPresets();
  let saved = null;
  try { saved = localStorage.getItem(STORE); } catch {}
  let text = null, source = null;
  const ex = new URLSearchParams(location.search).get('example');
  if (ex && /^[\w.-]+\.cir$/.test(ex)) {
    try { const r = await fetch('examples/' + ex); if (r.ok) { text = await r.text(); source = `example ${ex}`; } } catch {}
    history.replaceState(null, '', location.pathname + location.hash);   // a reload keeps the user's edits
  }
  const m = /#n=(.*)$/.exec(location.hash);
  if (!text && m) { try { text = new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(m[1])), c => c.charCodeAt(0))); source = 'the netlist from the link'; } catch {} }
  if (!text) text = saved;
  if (!text && list.length) text = await (await fetch('examples/' + list[0].file)).text();
  editor.value = text || '.freq 1G 3G 201\nport a\nport b\nT1 a b Z0=50 len=90deg\n';
  run();
  if (source) offerRestore(saved, source);
})();
