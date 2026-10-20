import { parseNetlist } from './netlist.js';
import { solve } from './solver.js';
import { evalTrace, parseExpr } from './expr.js';
import { drawRect, drawSmith, rectIndexAt, palette } from './plot.js';
import { touchstone } from './touchstone.js';
import { attachData } from './data.js';
import { optimise, writeBack, fmtSI, goalCost } from './optimize.js';
import { HELP_HTML } from './help.js';
import { design, returnLossDb } from './synth.js';
import { evalRealStr } from './expr.js';
import { buildLayout } from './layout-templates.js';
import { toSVG } from './layout.js';
import { componentLibrary, boardProject, zip } from './kicad.js';
import { setSubstrate, setLayout, detectLayouts, toMicrostrip } from './netlist-edit.js';
import { realiseCaps } from './synth-caps.js';
import { listPresets, makeSubstrate } from './substrates.js';
import { CONNECTORS, LAUNCH_MODES } from './connectors.js';

const $ = (id) => document.getElementById(id);
const editor = $('editor'), gutter = $('gutter'), status = $('status');
const STORE = 'comb-over:netlist';

let state = { d: null, res: null, overrides: {}, hoverK: null, plots: [], paramSig: null, optRunning: false };
// imported S-parameter files (issue #17): { name → text }, kept in this browser
const DATA_KEY = 'comb-over:data';
state.files = (() => { try { return JSON.parse(localStorage.getItem(DATA_KEY) || '{}'); } catch { return {}; } })();
const saveFiles = () => { try { localStorage.setItem(DATA_KEY, JSON.stringify(state.files)); } catch { /* too big for storage: kept for this session only */ } };

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
  const att = attachData(d, res.freq, state.files);
  state.data = att.data; state.dataSets = att.sets;
  att.warnings.forEach(w => d.warnings.push(w));
  const ms = (performance.now() - t0).toFixed(0);
  let msg = `${d.ports.length} ports · ${res.nodeCount} nodes · ${d.sections.length} line section(s) · ${res.freq.length} pts · ${ms} ms`;
  if (res.failures) msg += `\n${res.failures} frequency point(s) singular (shown as gaps)`;
  if (d.goals.length) {
    const { cost, report } = goalCost(d, res, state.data);
    msg += `\ngoals: cost ${cost.toExponential(2)}` + report.map(r => `\n  ${r.goal.src} ${r.goal.op} ${r.goal.value}: worst violation ${r.maxViolation.toPrecision(3)}`).join('');
  }
  d.warnings.forEach(w => msg += `\n${w}`);
  setStatus(msg, 'ok');
  renderTune(d);
  renderInfo(d);
  renderLayout(d);
  renderPlots(d, res);
}

// ---------- layout panel (.layout, issue #10) ----------
// The netlist text is the source of truth: every control here rewrites the .substrate / .layout
// lines (or converts sections to microstrip) and re-runs.
const LAYOUT_DEFAULT_SUB = 'jlc-ro4350b-1.524';      // fits the default 0.062" edge-launch SMA
const PHYS_KEY = 'comb-over:physical-view';
state.physical = (() => { try { return localStorage.getItem(PHYS_KEY) === '1'; } catch { return false; } })();

function applyText(text, what) {
  // deferred: controls fire 'change' on blur, while the panel would be replaced underneath them
  setTimeout(() => applyTextNow(text, what), 0);
}
function applyTextNow(text, what) {
  const prev = editor.value;
  if (text === prev) return;
  editor.value = text; state.overrides = {}; state.paramSig = null;
  updateGutter(); run();
  if (what) offerRestore(prev, what);
}
const subOptions = (cur) => {
  const presets = listPresets();
  const extra = cur && (!presets.some(p => p.id === cur.id) || Object.keys(cur.overrides || {}).length) ? `<option value="" selected>${esc(cur.name)} (from the netlist)</option>` : '';
  return extra + presets.map(p => `<option value="${p.id}"${!extra && cur?.id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
};
const selectHTML = (id, opts, cur, title = '') => `<select id="${id}" title="${esc(title)}">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;

// Make the netlist physical (substrate + microstrip sections) and give it a .layout.
function makeLayout(d, cand, subId) {
  let text = editor.value;
  if (subId || !d.substrate) text = setSubstrate(text, subId || LAYOUT_DEFAULT_SUB);
  let d2 = parseNetlist(text, state.overrides);
  const conv = toMicrostrip(text, d2, d2.substrate);
  if (conv.skipped.length) { setStatus(`cannot lay out: ${conv.skipped.map(x => `${x.name}: ${x.why}`).join('; ')}`, 'err'); return; }
  text = conv.text;
  if (cand) text = setLayout(text, { type: cand.type, sections: cand.sections, opts: d.layout?.opts && cand.type === d.layout?.type ? rawLayoutOpts(d) : {} });
  applyText(text, conv.changed.length ? `a microstrip layout (${conv.changed.map(c => `${c.name}: ${c.from} → ${c.to}`).join('; ')})` : 'a layout');
}
// .layout options as written (mm numbers back from the parser's mm values)
function rawLayoutOpts(d) { const o = { ...(d.layout?.opts || {}) }; return o; }

function layoutControls(d, L) {
  const lo = d.layout, o = L?.opts || lo?.opts || {};
  const cands = detectLayouts(d);
  const cur = lo ? `${lo.type}:${lo.sections.join(',')}` : '';
  const tOpts = [...(lo && !cands.some(c => `${c.type}:${c.sections.join(',')}` === cur) ? [[cur, `${lo.type} ${lo.sections.join(' ')}`]] : []), ...cands.map(c => [`${c.type}:${c.sections.join(',')}`, `${c.type} ${c.sections.join(' ')}`])];
  const num = (k, label, title) => `<label title="${esc(title)}"><span>${label}</span><input id="lo-${k}" type="number" step="0.5" min="0" placeholder="${o[k] != null ? +o[k].toFixed(2) : 'auto'}" value="${lo?.opts?.[k] != null ? +lo.opts[k].toFixed(3) : ''}"></label>`;
  return `<div class="layout-ctl">
    <label><span>Substrate</span><select id="lo-sub" title="Changing the substrate keeps W and S; use Convert to re-synthesise them for the new substrate">${subOptions(d.substrate)}</select></label>
    <label><span>Template</span>${selectHTML('lo-type', tOpts, cur, 'Layout template and the sections it uses')}</label>
    <label><span>Connector</span>${selectHTML('lo-conn', [...Object.values(CONNECTORS).map(c => [c.id, c.mpn + ' SMA']), ['none', 'none']], o.connector ?? 'amphenol-132289', 'Edge-launch connector at every port')}</label>
    <label><span>Launch</span>${selectHTML('lo-launch', LAUNCH_MODES.map(m => [m, m]), o.launch ?? 'matched', 'matched: signal pad = feed width; library: KiCad pad + taper')}</label>
    ${num('pitch', 'Pitch mm', 'Port spacing on an edge (blank: from the connector)')}
    ${num('feed', 'Feed mm', 'Straight feed length at each port (blank: connector pad + launch + 1 mm)')}
    ${num('margin', 'Margin mm', 'Board margin (blank: from the connector)')}
    <label class="check" title="Overlay the response of the layout as built (feeds, tapers, connector pads, vias, open ends) as dashed traces"><input id="lo-phys" type="checkbox"${state.physical ? ' checked' : ''}> Physical view</label>
  </div>`;
}

function wireLayoutControls(d) {
  const lo = d.layout;
  const rewrite = () => {
    const [type, secs] = $('lo-type').value.split(':');
    const opts = { ...lo.opts };
    for (const k of ['pitch', 'feed', 'margin']) { const v = $(`lo-${k}`).value; opts[k] = v === '' ? null : +v; }
    opts.connector = $('lo-conn').value === 'amphenol-132289' ? null : $('lo-conn').value;   // default omitted
    opts.launch = $('lo-launch').value === 'matched' ? null : $('lo-launch').value;
    applyText(setLayout(editor.value, { type, sections: secs.split(','), opts }));
  };
  for (const id of ['lo-type', 'lo-conn', 'lo-launch', 'lo-pitch', 'lo-feed', 'lo-margin']) $(id)?.addEventListener('change', rewrite);
  // new substrate: keep each section's impedances and re-synthesise its W/S for the new substrate
  $('lo-sub').addEventListener('change', () => {
    const v = $('lo-sub').value; if (!v) return;
    const conv = toMicrostrip(setSubstrate(editor.value, v), d, makeSubstrate(v), { all: true });
    if (conv.skipped.length) { setStatus(`substrate changed; not re-synthesised: ${conv.skipped.map(x => `${x.name}: ${x.why}`).join('; ')}`, 'err'); }
    applyText(conv.text, `${v}, with W/S re-synthesised for the same impedances (${conv.changed.map(c => `${c.name}: ${c.to}`).join('; ')})`);
  });
  $('lo-phys').addEventListener('change', () => { state.physical = $('lo-phys').checked; try { localStorage.setItem(PHYS_KEY, state.physical ? '1' : '0'); } catch {} run(); });
}

function renderLayout(d) {
  const box = $('layout-card');
  state.asBuilt = null;
  if (!d.layout) {
    // offer a layout when the topology fits a template
    const cands = detectLayouts(d);
    state.layout = null;
    if (!cands.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="plot layout-card"><div class="ptitle"><span>Layout · this netlist fits ${cands.map(c => `<b>${esc(c.type)}</b> (${esc(c.sections.join(' '))})`).join(', ')}</span></div>
      <div class="layout-ctl">
        <label><span>Template</span>${selectHTML('lo-new-type', cands.map((c, i) => [String(i), `${c.type} ${c.sections.join(' ')}`]), '0')}</label>
        <label><span>Substrate</span><select id="lo-new-sub">${listPresets().map(p => `<option value="${p.id}"${(d.substrate?.id ?? LAYOUT_DEFAULT_SUB) === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <button id="lo-make" class="primary" title="Sets .substrate, converts impedance-defined sections to microstrip W/S and adds a .layout line">Make PCB layout</button>
      </div>
      <p class="lnotes">Sections given by impedance are converted to microstrip on the substrate (your netlist is kept for Restore).</p></div>`;
    $('lo-make').onclick = () => makeLayout(d, cands[+$('lo-new-type').value], $('lo-new-sub').value);
    return;
  }
  let L, err = null;
  try { L = buildLayout(d); } catch (e) { err = e; }
  if (err) {
    const needsPhys = /physical dimensions/.test(err.message);
    box.innerHTML = `<div class="plot layout-card"><div class="ptitle"><span>Layout · ${esc(d.layout.type)}</span>
      ${needsPhys ? `<span><button id="lo-convert" class="primary" title="Convert the impedance-defined sections to microstrip W/S on the substrate">Convert to microstrip${d.substrate ? ` on ${esc(d.substrate.id)}` : ''}</button></span>` : ''}</div>
      ${layoutControls(d, null)}<ul class="drc bad"><li>${esc(err.message)}</li></ul></div>`;
    wireLayoutControls(d);
    if (needsPhys) $('lo-convert').onclick = () => makeLayout(d, null, d.substrate ? null : LAYOUT_DEFAULT_SUB);
    state.layout = null; return;
  }
  state.layout = L;
  if (state.physical) { try { state.asBuilt = solve(parseNetlist(L.netlist)); } catch (e) { L.warnings.push(`as-built netlist: ${e.message}`); } }
  const ok = !L.errors.length;
  box.innerHTML = `<div class="plot layout-card">
    <div class="ptitle"><span>Layout · ${esc(L.type)} · ${L.size[0].toFixed(1)} × ${L.size[1].toFixed(1)} mm · ${esc(L.substrate.name)}</span>
      <span><button id="btn-asbuilt" title="Open the netlist of the layout, including its feed lines">As-built netlist</button> <button id="btn-svg">SVG</button> <button id="btn-kicadlib" title="Footprint + symbol + core netlist as a self-contained KiCad 9 library"${ok ? '' : ' disabled'}>KiCad library</button> <button id="btn-kicadpcb" class="primary" title="Whole KiCad 9 project: board with feeds, connectors, ground pours, stitching vias and stack-up, plus the library"${ok ? '' : ' disabled'}>KiCad project</button></span></div>
    ${layoutControls(d, L)}
    <div class="svgbox">${toSVG(L, { errors: L.errors })}</div>
    <ul class="drc ${ok ? 'ok' : 'bad'}">${ok ? '<li>✓ design rules met</li>' : L.errors.map(e => `<li>${esc(e.msg)}</li>`).join('')}</ul>
    ${L.warnings?.length ? `<ul class="drc warn">${L.warnings.map(w => `<li>⚠ ${esc(w)}</li>`).join('')}</ul>` : ''}
    ${L.notes.length ? `<ul class="lnotes">${L.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>`;
  wireLayoutControls(d);
  $('btn-svg').onclick = () => download(`${baseName()}-layout.svg`, toSVG(L), 'image/svg+xml');
  $('btn-kicadpcb').onclick = () => { const b = boardProject(L, { source: editor.value }); download(`${b.lib}-kicad.zip`, zip(b.files, b.lib), 'application/zip'); };
  $('btn-kicadlib').onclick = () => { const lib = componentLibrary(L, { source: editor.value }); download(`${lib.lib}.zip`, zip(lib.files, lib.lib), 'application/zip'); };
  $('btn-asbuilt').onclick = () => applyText(L.netlist, 'the as-built netlist');
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
  $('btn-apply').onclick = () => { editor.value = writeBack(editor.value, state.overrides); state.overrides = {}; state.paramSig = null; run(); };
  $('btn-reset').onclick = () => { state.overrides = {}; state.paramSig = null; run(); };
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
  if (!secs.length && !d.substrate && !state.dataSets?.length) { box.innerHTML = ''; return; }
  let h = d.substrate ? substrateHTML(d.substrate) : '';
  if (state.dataSets?.length) {
    h += `<h3>Data</h3><table class="modes sub">${state.dataSets.map(s => `<tr><th>${esc(s.name)}</th><td>${esc(s.file)} · ${s.P} port${s.P > 1 ? 's' : ''} · ${s.n} pts · ${(s.range[0] / 1e9).toPrecision(4)}–${(s.range[1] / 1e9).toPrecision(4)} GHz · ${s.z.join('/')} Ω${s.overlay ? ' · overlaid' : ''}</td></tr>`).join('')}</table>`;
  }
  if (secs.length) h += '<h3>Line sections</h3>';
  for (const s of secs) {
    const modes = s.modalInfo();
    const qs = [...new Set(s.Qm.map(q => (isFinite(q) && q < 1e20 ? +q.toPrecision(3) : null)))].filter(q => q != null);
    const mm = (x) => +(x * 1e3).toPrecision(4);
    let geo = '';
    if (s.geom?.kind === 'msl1') geo = `<br><span class="geo">microstrip W ${mm(s.geom.W)} mm → Z0 ${s.geom.Z0.toFixed(2)} Ω, ε<sub>eff</sub> ${s.geom.epsEff.toFixed(3)} at ${+(s.geom.f0 / 1e9).toPrecision(4)} GHz</span>`;
    if (s.geom?.kind === 'msl2') geo = `<br><span class="geo">coupled microstrip W ${mm(s.geom.W)} mm, S ${mm(s.geom.S)} mm → Z<sub>e</sub> ${s.geom.Ze.toFixed(2)} Ω, Z<sub>o</sub> ${s.geom.Zo.toFixed(2)} Ω ${s.geom.model === 'field' ? '(field solver, quasi-static)' : `at ${+(s.geom.f0 / 1e9).toPrecision(4)} GHz`}</span>`;
    if (s.geom?.kind === 'mslN') geo = `<br><span class="geo">${s.geom.W.length} coupled microstrip lines, field solver: W ${s.geom.W.map(mm).join(' ')} mm, S ${s.geom.S.map(mm).join(' ')} mm</span>`;
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
  const ctx = { n: res.freq.length, freq: res.freq, S: (i, j) => res.S(i, j), scope: d.scope, data: state.data };
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
  const evalAll = (c, extra = {}) => specs.map(p => p.traces.map((t, j) => {
    try { const v = evalTrace(t.ast, c); return { label: t.src, x: c.freq, y: v.re, re: v.re, im: v.im, unit: v.unit, ...extra, ci: j }; }
    catch (e) { return { label: t.src + ' — ' + e.message, x: c.freq, y: new Float64Array(c.freq.length).fill(NaN), re: [], im: [], err: true, ...extra, ci: j }; }
  }));
  state.plotData = evalAll(ctx);
  // imported data with `overlay`: each S-parameter trace gets a dotted twin from the data set
  for (const ds of (state.dataSets || []).filter(x => x.overlay)) {
    const twins = specs.map(p => p.traces.map((t, j) => {
      const src = t.src.replace(/\b(S\d\d|S_\d+_\d+)\b/g, `${ds.name}.$1`);
      if (src === t.src) return null;
      try { const v = evalTrace(parseExpr(src), ctx); return { label: `${t.src} (${ds.name})`, x: res.freq, y: v.re, re: v.re, im: v.im, unit: v.unit, dash: [2, 3], ci: j, data: true }; }
      catch { return null; }
    }).filter(Boolean));
    state.plotData = state.plotData.map((ts, i) => [...ts, ...twins[i]]);
  }
  // physical view: the same traces from the as-built netlist, dashed in the same colours
  const ab = state.physical && state.asBuilt;
  if (ab) {
    const ghost = evalAll({ n: ab.freq.length, freq: ab.freq, S: (i, j) => ab.S(i, j), scope: d.scope }, { dash: [6, 4], asBuilt: true });
    state.plotData = state.plotData.map((ts, i) => [...ts, ...ghost[i].map(t => ({ ...t, label: t.label + ' as built' }))]);
  }
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
    el.querySelector('.legend').innerHTML = data.map((t, j) => `<span><span class="sw${t.dash ? (t.dash[0] <= 2 ? ' dash dot' : ' dash') : ''}" style="${t.dash ? 'border-top-color' : 'background'}:${pal[(t.ci ?? j) % pal.length]}"></span>${t.label}<span class="v">${fmtV(t)}</span></span>`).join('');
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
  try { gen = optimise(text, { files: state.files }); } catch (e) { setStatus(e.message, 'err'); return; }
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
  if (last) { editor.value = writeBack(editor.value, last.best); state.overrides = {}; state.paramSig = null; run(); }
};

// ---------- synthesis ----------
{
  const dlg = $('synth'), form = $('synth-form'), msg = $('synth-msg');
  const SKEY = 'comb-over:synth';
  form.elements.capsub.innerHTML = listPresets().map(p => `<option value="${p.id}"${p.id === 'jlc-ro4350b-0.508' ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  form.elements.phys.innerHTML = '<option value="">no — ideal TEM lines</option>' + listPresets().map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  try { const saved = JSON.parse(localStorage.getItem(SKEY) || 'null'); if (saved) for (const [k, v] of Object.entries(saved)) { const el = form.elements[k]; if (el) el.type === 'checkbox' ? (el.checked = v) : (el.value = v); } } catch {}
  const sync = () => {
    dlg.classList.toggle('hide-comb', form.elements.structure.value !== 'comb');
    const phys = !!form.elements.phys.value;
    dlg.classList.toggle('hide-phys', !phys);

    form.elements.er.disabled = phys;
    dlg.classList.toggle('hide-capopt', phys || form.elements.captype.value === 'ideal');   // physical: the parts sit on the chosen substrate, nominal values exact
    const cheb = form.elements.type.value === 'chebyshev';
    form.elements.ripple.disabled = !cheb;
    const r = parseFloat(form.elements.ripple.value);
    form.querySelector('.rl').textContent = cheb && r > 0 ? `return loss ${returnLossDb(r).toFixed(2)} dB` : '';
  };
  form.addEventListener('input', sync);
  const saveForm = () => { try { localStorage.setItem(SKEY, JSON.stringify(Object.fromEntries([...form.elements].filter(x => x.name).map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])))); } catch {} };
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
      if ((spec.structure === 'hairpin' || spec.structure === 'edgecoupled') && !F.phys.value) throw new Error(`${spec.structure === 'hairpin' ? 'Hairpin' : 'Edge-coupled'} filters are designed in microstrip only: choose a substrate under "Realise in microstrip"`);
      if (F.phys.value) {
        // geometry synthesis: off the main thread, with progress
        const via = { d: num('viad'), n: Math.max(1, Math.round(num('vian'))) };
        const w = new Worker(new URL('./synth-worker.js', import.meta.url), { type: 'module' });
        $('synth-go').disabled = true;
        msg.textContent = 'synthesising the geometry (field solver and optimiser, a few seconds)…';
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.progress) { msg.textContent = `synthesising the geometry… ${m.progress}`; return; }
          w.terminate(); $('synth-go').disabled = false;
          if (m.error) { msg.textContent = m.error; msg.className = 'status err'; return; }
          saveForm();
          dlg.close();
          editor.value = m.netlist; state.overrides = {}; state.paramSig = null; state.hoverK = null; run();
        };
        w.onerror = (ev) => { w.terminate(); $('synth-go').disabled = false; msg.textContent = `synthesis failed: ${ev.message}`; msg.className = 'status err'; };
        const ct = F.captype.value, [ctype, cpkg] = ct.split('-');
        w.postMessage({ spec, substrate: F.phys.value, via, cap: { type: ctype, pkg: cpkg } });
        return;
      }
      r = design(spec);
      // loading capacitors (#14): realise the ideal end capacitors as SMD parts, trimmers or printed pads
      const ct = F.captype.value;
      if (spec.structure === 'comb' && ct !== 'ideal') {
        const [type, pkg] = ct.split('-');
        const out = realiseCaps(r, r.netlist, { type, pkg, series: F.capseries.value, substrate: F.capsub.value });
        r.netlist = out.text; r.capWarnings = out.warnings;
      }
    } catch (err) { msg.textContent = err.message; msg.className = 'status err'; return; }
    saveForm();
    dlg.close();
    editor.value = r.netlist; state.overrides = {}; state.paramSig = null; state.hoverK = null; run();
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
// Data…: load .sNp files; each gets a `.data NAME FILE overlay` line unless the netlist already names it
$('btn-data').onclick = () => $('data-in').click();
$('data-in').onchange = async (e) => {
  const lines = [];
  for (const f of e.target.files) {
    state.files[f.name] = await f.text();
    const d = state.d;
    if (d?.data?.some(x => x.file.split(/[\\/]/).pop() === f.name)) continue;
    const used = new Set([...(d?.data ?? []).map(x => x.name), ...lines.map(l => l.split(' ')[1])]);
    let k = 1; while (used.has(`meas${k}`)) k++;
    lines.push(`.data meas${k} ${f.name} overlay`);
  }
  saveFiles();
  e.target.value = '';
  if (lines.length) { editor.value = editor.value.replace(/\s*$/, '\n') + lines.join('\n') + '\n'; updateGutter(); }
  run();
};
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
    editor.value = t; state.overrides = {}; state.paramSig = null; state.hoverK = null; run();
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
  $('btn-restore').onclick = () => { editor.value = prev; state.overrides = {}; state.paramSig = null; box.hidden = true; run(); };
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
