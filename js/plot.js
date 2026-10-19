// Canvas plotting: rectangular (vs frequency) and Smith chart, with hover readout.
import { fmtSI } from './optimize.js';

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
export const palette = () => [1, 2, 3, 4, 5, 6, 7, 8].map(i => css(`--trace-${i}`));

function niceTicks(lo, hi, n = 6) {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (hi === lo) { hi = lo + 1; lo -= 1; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export const RECT_MARGIN = { l: 56, r: 12, t: 10, b: 30 };

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W: r.width, H: r.height };
}

// traces: [{label, x:Float64Array, y:Float64Array, unit}]
export function drawRect(canvas, traces, opts = {}) {
  const { ctx, W, H } = setupCanvas(canvas);
  const font = css('--mono');
  const m = RECT_MARGIN;
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const x0 = traces[0]?.x[0] ?? 0, x1 = traces[0]?.x[traces[0].x.length - 1] ?? 1;
  let ylo = Infinity, yhi = -Infinity;
  for (const t of traces) for (const v of t.y) if (isFinite(v)) { ylo = Math.min(ylo, v); yhi = Math.max(yhi, v); }
  if (opts.ylim) [ylo, yhi] = opts.ylim;
  if (!isFinite(ylo)) { ylo = -1; yhi = 1; }
  if (yhi - ylo < 1e-9 * (Math.abs(yhi) + 1)) { ylo -= 0.5 * (Math.abs(ylo) || 1); yhi += 0.5 * (Math.abs(yhi) || 1); }
  const pad = opts.ylim ? 0 : (yhi - ylo) * 0.05; ylo -= pad; yhi += pad;
  const X = (x) => m.l + (x - x0) / (x1 - x0 || 1) * pw;
  const Y = (y) => m.t + (1 - (y - ylo) / (yhi - ylo)) * ph;

  ctx.clearRect(0, 0, W, H);
  ctx.font = `11px ${font}`;
  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--muted'); ctx.lineWidth = 1;
  // grid
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of niceTicks(ylo, yhi)) {
    const y = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
    ctx.fillText(fmtAxis(v, traces[0]?.unit), m.l - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of niceTicks(x0, x1, Math.max(3, Math.floor(pw / 80)))) {
    const x = Math.round(X(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, m.t + ph); ctx.stroke();
    ctx.fillText(fmtSI(v, 4) + 'Hz', x, m.t + ph + 6);
  }
  ctx.strokeStyle = css('--axis'); ctx.strokeRect(m.l + 0.5, m.t + 0.5, pw, ph);
  // traces
  ctx.save(); ctx.beginPath(); ctx.rect(m.l, m.t, pw, ph); ctx.clip();
  const pal = palette();
  traces.forEach((t, i) => {
    // t.ci: colour index (a dashed "as built" trace shares its design trace's colour); t.dash: line dash
    ctx.strokeStyle = pal[(t.ci ?? i) % pal.length]; ctx.lineWidth = t.dash ? 1.3 : 1.6; ctx.setLineDash(t.dash || []); ctx.beginPath();
    let pen = false;
    for (let k = 0; k < t.x.length; k++) {
      const v = t.y[k];
      if (!isFinite(v)) { pen = false; continue; }
      const px = X(t.x[k]), py = Y(Math.max(ylo - (yhi - ylo), Math.min(yhi + (yhi - ylo), v)));
      if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
    }
    ctx.stroke(); ctx.setLineDash([]);
  });
  ctx.restore();
  // hover marker
  if (opts.hoverK != null && traces.length && opts.hoverK < traces[0].x.length) {
    const px = Math.round(X(traces[0].x[opts.hoverK])) + 0.5;
    ctx.strokeStyle = css('--axis'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(px, m.t); ctx.lineTo(px, m.t + ph); ctx.stroke(); ctx.setLineDash([]);
    traces.forEach((t, i) => {
      const v = t.y[opts.hoverK]; if (!isFinite(v) || v < ylo || v > yhi) return;
      ctx.fillStyle = pal[(t.ci ?? i) % pal.length]; ctx.beginPath(); ctx.arc(px, Y(v), 3, 0, 2 * Math.PI); ctx.fill();
    });
  }
  return { plotLeft: m.l, plotWidth: pw };
}

// map a canvas x position to the nearest sample index
export function rectIndexAt(canvas, clientX, xs) {
  const r = canvas.getBoundingClientRect();
  const pw = r.width - RECT_MARGIN.l - RECT_MARGIN.r;
  const t = (clientX - r.left - RECT_MARGIN.l) / pw;
  if (t < -0.02 || t > 1.02) return null;
  const f = xs[0] + Math.min(1, Math.max(0, t)) * (xs[xs.length - 1] - xs[0]);
  let k = 0, best = Infinity; for (let i = 0; i < xs.length; i++) { const d = Math.abs(xs[i] - f); if (d < best) { best = d; k = i; } }
  return k;
}

function fmtAxis(v, unit) {
  if (unit === 's') return fmtSI(v, 3) + 's';
  if (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0)) return v.toExponential(1);
  return String(+v.toPrecision(4));
}

// traces: [{label, re:Float64Array, im:Float64Array}]
export function drawSmith(canvas, traces, opts = {}) {
  const { ctx, W, H } = setupCanvas(canvas);
  const R = Math.min(W, H) / 2 - 14, cx = W / 2, cy = H / 2;
  const P = (re, im) => [cx + re * R, cy - im * R];
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.clip();
  ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
  for (const r of [0.2, 0.5, 1, 2, 5]) { // constant-r circles: centre r/(1+r), radius 1/(1+r)
    ctx.beginPath(); ctx.arc(cx + R * r / (1 + r), cy, R / (1 + r), 0, 2 * Math.PI); ctx.stroke();
  }
  for (const x of [0.2, 0.5, 1, 2, 5]) for (const s of [1, -1]) { // constant-x arcs: centre (1, 1/x), radius 1/x
    ctx.beginPath(); ctx.arc(cx + R, cy - s * R / x, R / x, 0, 2 * Math.PI); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
  const pal = palette();
  traces.forEach((t, i) => {
    ctx.strokeStyle = pal[(t.ci ?? i) % pal.length]; ctx.lineWidth = t.dash ? 1.3 : 1.6; ctx.setLineDash(t.dash || []); ctx.beginPath();
    let pen = false;
    for (let k = 0; k < t.re.length; k++) {
      if (!isFinite(t.re[k])) { pen = false; continue; }
      const [x, y] = P(t.re[k], t.im[k]);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke(); ctx.setLineDash([]);
    const [sx, sy] = P(t.re[0], t.im[0]); ctx.fillStyle = pal[(t.ci ?? i) % pal.length]; ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
  });
  ctx.restore();
  ctx.strokeStyle = css('--axis'); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
  if (opts.hoverK != null && traces.length) {
    const k = opts.hoverK;
    traces.forEach((t, i) => {
      if (!isFinite(t.re[k])) return;
      const [x, y] = P(t.re[k], t.im[k]);
      ctx.strokeStyle = pal[(t.ci ?? i) % pal.length]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.stroke();
    });
  }
}
