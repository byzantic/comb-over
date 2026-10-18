// PCB technology (substrate) definitions: presets with cited sources, user overrides and custom
// stackups. Used by the netlist (.substrate), and later by physical line models, layout and
// KiCad export (issues #3–#10).
//
// Model (SI units throughout):
//   {
//     id, name, maker, layers,                  // layers: copper layer count (2 = microstrip over ground)
//     dielectric: { material, h, er, tand, fTand },   // h = core thickness (m); tand quoted at fTand (Hz)
//     copper:     { t, sigma, roughness },      // thickness (m), conductivity (S/m), RMS roughness (m) or null
//     fab:        { minTrace, minSpace, minDrill }    // metres; null = not published / unknown
//     assumptions: [string],                    // values that are NOT from the cited sources
//     notes: [string], sources: [{ url, what, accessed }]
//   }

export const COPPER_SIGMA = 5.8e7;     // S/m, annealed copper
export const OZ = 34.79e-6;            // 1 oz/ft² copper ≈ 34.8 µm (commonly rounded to 35 µm)

const ACCESSED = '2026-10-18';
const SRC = {
  jlcCaps: { url: 'https://jlcpcb.com/capabilities/pcb-capabilities', what: 'FR-4 εr 4.5 (2-layer), thicknesses, min trace/space 0.10/0.10 mm, min via hole 0.15 mm, 1 oz outer copper', accessed: ACCESSED },
  jlcHF: { url: 'https://jlcpcb.com/pcb-fabrication/high-frequency-pcb', what: 'RO4350B and PTFE materials with Dk/Df, 2-layer only', accessed: ACCESSED },
  jlcHFBlog: { url: 'https://jlcpcb.com/blog/112-rogers-pcb-ptfe-pcb-high-frequency-pcb-is-available-on-jlcpcb', what: 'RO4350B 0.51/0.76/1.52 mm, PTFE 0.76/1.52 mm, 2-layer, 1 oz (post dated 2023-03-09)', accessed: ACCESSED },
  ro4350bDS: { url: 'https://rs.jlcpcb.com/static/file/rogers-ro4350b-datasheet.pdf', what: 'RO4350B design Dk 3.66, process Dk 3.48 (10 GHz), Df 0.0037 @ 10 GHz / 0.0031 @ 2.5 GHz', accessed: ACCESSED },
};

const JLC_2L_FAB = { minTrace: 0.10e-3, minSpace: 0.10e-3, minDrill: 0.15e-3 };
const mm = (x) => x * 1e-3;

function preset(o) {
  return {
    maker: 'JLCPCB', layers: 2,
    copper: { t: OZ, sigma: COPPER_SIGMA, roughness: null },
    fab: { ...JLC_2L_FAB },
    assumptions: [], notes: [], ...o,
  };
}

const FR4_TH = [0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0];
const RO_TH = [0.508, 0.762, 1.524];
const PTFE = [
  ['zyf255da', 'ZYF255DA', 2.55, 0.0018],
  ['zyf265d', 'ZYF265D', 2.65, 0.0019],
  ['zyf300ca-c', 'ZYF300CA-C', 2.94, 0.0016],
  ['zyf300ca-p', 'ZYF300CA-P', 3.00, 0.0018],
];
const PTFE_TH = [0.762, 1.524];

export const PRESETS = [
  ...FR4_TH.map(t => preset({
    id: `jlc-fr4-${t.toFixed(1)}`, name: `JLC FR-4 ${t.toFixed(1)} mm board, 2-layer`,
    dielectric: { material: 'FR-4', h: mm(t) - 2 * OZ, er: 4.5, tand: 0.02, fTand: 1e9 },
    assumptions: [
      'loss tangent 0.02 at 1 GHz is a typical FR-4 value; JLCPCB does not publish one',
      `dielectric h = ${t} mm board thickness − 2 × 1 oz copper; JLCPCB does not publish the 2-layer core thickness, and board thickness tolerance is typically ±10 % — confirm for impedance-critical work`,
    ],
    notes: ['FR-4 εr varies with glass style, resin content and frequency; treat 4.5 as nominal'],
    sources: [SRC.jlcCaps],
  })),
  ...RO_TH.map(t => preset({
    id: `jlc-ro4350b-${t.toFixed(3)}`, name: `JLC Rogers RO4350B ${t.toFixed(3)} mm, 2-layer`,
    dielectric: { material: 'Rogers RO4350B', h: mm(t), er: 3.66, tand: 0.0037, fTand: 10e9 },
    assumptions: ['fabrication limits taken as JLCPCB standard 2-layer rules; not published separately for Rogers'],
    notes: [
      'εr is the Rogers design Dk 3.66 (recommended for circuit design); the process Dk is 3.48 at 10 GHz, the value JLCPCB quotes',
      'Df 0.0031 at 2.5 GHz, 0.0037 at 10 GHz',
      'JLCPCB also quotes finished thicknesses of 0.6 / 0.9 / 1.65 mm for these cores; h here is the core thickness',
    ],
    sources: [SRC.jlcHF, SRC.jlcHFBlog, SRC.ro4350bDS],
  })),
  ...PTFE.flatMap(([key, mat, er, tand]) => PTFE_TH.map(t => preset({
    id: `jlc-${key}-${t.toFixed(3)}`, name: `JLC PTFE ${mat} ${t.toFixed(3)} mm, 2-layer`,
    dielectric: { material: `PTFE ${mat}`, h: mm(t), er, tand, fTand: 10e9 },
    assumptions: [
      'test frequency for Dk/Df not stated by JLCPCB; 10 GHz assumed',
      'fabrication limits taken as JLCPCB standard 2-layer rules',
    ],
    notes: ['JLCPCB lists 0.76 / 1.52 mm in one place and 0.65 / 0.9 / 1.65 mm (finished) in another; confirm before ordering'],
    sources: [SRC.jlcHF, SRC.jlcHFBlog],
  }))),
];

const byId = new Map(PRESETS.map(p => [p.id, p]));

export function listPresets() { return PRESETS.map(p => ({ id: p.id, name: p.name })); }

// Keys accepted as overrides (and for custom substrates), with their target and unit handling.
export const KEYS = {
  h: ['dielectric', 'h'], er: ['dielectric', 'er'], tand: ['dielectric', 'tand'], ftand: ['dielectric', 'fTand'],
  t: ['copper', 't'], sigma: ['copper', 'sigma'], rough: ['copper', 'roughness'],
  mintrace: ['fab', 'minTrace'], minspace: ['fab', 'minSpace'], mindrill: ['fab', 'minDrill'],
};

function clone(p) { return JSON.parse(JSON.stringify(p)); }

// Resolve a preset id (case-insensitive) or 'custom', apply overrides {key: number}. Throws with
// a helpful message on unknown ids/keys and validates the result.
export function makeSubstrate(id, overrides = {}) {
  let s;
  const key = String(id).toLowerCase();
  if (key === 'custom') {
    s = {
      id: 'custom', name: 'Custom substrate', maker: null, layers: 2,
      dielectric: { material: 'custom', h: null, er: null, tand: 0, fTand: 1e9 },
      copper: { t: OZ, sigma: COPPER_SIGMA, roughness: null },
      fab: { minTrace: null, minSpace: null, minDrill: null },
      assumptions: [], notes: [], sources: [],
    };
    for (const req of ['h', 'er']) if (!(req in overrides)) throw new Error(`custom substrate needs ${req}=`);
  } else {
    const p = byId.get(key);
    if (!p) throw new Error(`unknown substrate "${id}"${suggest(key)}`);
    s = clone(p);
  }
  const changed = [];
  for (const [k, v] of Object.entries(overrides)) {
    const path = KEYS[k.toLowerCase()];
    if (!path) throw new Error(`unknown substrate key "${k}" (use ${Object.keys(KEYS).join(', ')})`);
    s[path[0]][path[1]] = v;
    changed.push(k.toLowerCase());
  }
  if (changed.length && s.id !== 'custom') s.name += ` (modified: ${changed.join(', ')})`;
  s.overrides = { ...overrides };
  validate(s);
  return s;
}

function suggest(key) {
  // rank presets by the total length of the query's parts they contain
  const parts = key.split(/[-\s]/).filter(q => q.length > 1);
  const hits = PRESETS.map(p => ({ id: p.id, score: parts.reduce((a, q) => a + (p.id.includes(q) ? q.length : 0), 0) }))
    .filter(h => h.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map(h => h.id);
  return hits.length ? `; did you mean ${hits.join(', ')}?` : '; see the presets list';
}

export function validate(s) {
  const d = s.dielectric, c = s.copper;
  const bad = (m) => { throw new Error(`substrate ${s.id}: ${m}`); };
  if (!(d.h > 0)) bad('dielectric thickness h must be > 0');
  if (d.h > 0.02) bad(`h = ${d.h} m looks wrong (more than 20 mm) — use a unit, e.g. h=1.6mm`);
  if (!(d.er >= 1)) bad('εr must be ≥ 1');
  if (!(d.tand >= 0 && d.tand < 1)) bad('tand must be in [0, 1)');
  if (!(c.t >= 0)) bad('copper thickness t must be ≥ 0');
  if (c.t > 0.5e-3) bad(`t = ${c.t} m looks wrong — use a unit, e.g. t=35u`);
  if (!(c.sigma > 0)) bad('conductivity sigma must be > 0');
  for (const [k, v] of Object.entries(s.fab)) if (v != null && !(v > 0)) bad(`${k} must be > 0`);
  return true;
}

// Numbers for use in netlist expressions after a .substrate statement.
export function scopeOf(s) {
  return {
    sub_h: s.dielectric.h, sub_er: s.dielectric.er, sub_tand: s.dielectric.tand,
    sub_t: s.copper.t, sub_sigma: s.copper.sigma,
  };
}

// Canonical .substrate directive for a substrate (round-trips through the parser).
export function toDirective(s) {
  const f = (x) => +x.toPrecision(6);
  const unit = (x, u, scale) => `${f(x / scale)}${u}`;
  const ov = s.overrides || {};
  const parts = ['.substrate', s.id];
  const fmtKey = (k, v) => {
    const kk = k.toLowerCase();
    if (['h', 't', 'rough', 'mintrace', 'minspace', 'mindrill'].includes(kk)) return `${kk}=${v >= 1e-3 ? unit(v, 'mm', 1e-3) : unit(v, 'u', 1e-6)}`;
    if (kk === 'ftand') return `ftand=${unit(v, 'G', 1e9)}`;
    return `${kk}=${f(v)}`;
  };
  if (s.id === 'custom') {
    const d = s.dielectric, c = s.copper;
    parts.push(fmtKey('h', d.h), fmtKey('er', d.er), fmtKey('tand', d.tand), fmtKey('ftand', d.fTand), fmtKey('t', c.t));
    if (c.sigma !== COPPER_SIGMA) parts.push(fmtKey('sigma', c.sigma));
    if (c.roughness != null) parts.push(fmtKey('rough', c.roughness));
    for (const [k, path] of Object.entries(KEYS)) if (path[0] === 'fab' && s.fab[path[1]] != null) parts.push(fmtKey(k, s.fab[path[1]]));
  } else {
    for (const [k, v] of Object.entries(ov)) parts.push(fmtKey(k, v));
  }
  return parts.join(' ');
}

// Short human summary, e.g. for the status line.
export function summary(s) {
  const d = s.dielectric;
  return `${s.name}: h ${+(d.h * 1e3).toPrecision(4)} mm, εr ${d.er}, tanδ ${d.tand}, Cu ${+(s.copper.t * 1e6).toPrecision(3)} µm`;
}
