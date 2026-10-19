// Edge-launch connectors (issue #8).
//
// Connector-local frame: millimetres, origin on the board edge at the centre of the signal pad,
// +x pointing OUT of the board (the connector body), y across the edge. The board is at x < 0.
//
// Geometry of the Amphenol RF 132289 from KiCad's library footprint
// Connector_Coaxial:SMA_Amphenol_132289_EdgeMount (KiCad libraries, CC-BY-SA 4.0 with the KiCad
// library exception, which allows use in designs). That footprint has its origin at the signal-pad
// centre with the board edge at x = +2.54; here everything is shifted by −2.54 so the edge is x = 0.
// Board thickness: 0.062" (1.57 mm), 0–18 GHz, from the distributor listing of 132289.

export const CONNECTORS = {
  'amphenol-132289': {
    id: 'amphenol-132289',
    name: 'Amphenol RF 132289 SMA jack, end launch',
    footprint: 'SMA_Amphenol_132289_EdgeMount',
    mpn: '132289',
    maxFreq: 18e9,
    board: { t: 1.57, tol: 0.15, note: '0.062" board' },
    signal: { w: 1.5, l: 5.08 },                       // F.Cu pad from the edge inwards
    ground: { y: 4.25, w: 1.5, l: 5.08 },              // F.Cu and B.Cu pads at y = ±4.25
    width: 11.16,                                      // courtyard across the edge (minimum port pitch)
    courtyard: { x0: -5.58, x1: 11.93, y: 5.58 },
    fab: [[1.905, -3.81, 11.43, 3.81], [-4.45, -5.08, 1.905, 5.08]],   // body and flange outlines
    source: 'KiCad library Connector_Coaxial:SMA_Amphenol_132289_EdgeMount (CC-BY-SA 4.0 with exception)',
  },
};
export const DEFAULT_CONNECTOR = 'amphenol-132289';

export function getConnector(id) {
  if (id == null) id = DEFAULT_CONNECTOR;
  if (id === 'none') return null;
  const c = CONNECTORS[id];
  if (!c) throw new Error(`unknown connector "${id}" (available: ${Object.keys(CONNECTORS).join(', ')}, none)`);
  return c;
}

// Signal-pad width for a launch mode:
//   'matched' (default): the pad is the feed width, so it is simply part of the port-impedance line.
//     KiCad's 1.5 mm pad is a ~41 Ω, 5 mm section on 0.508 mm RO4350B (about 50° at 5 GHz) and a
//     ~60 Ω one on 1.6 mm FR-4: a real mismatch at every port.
//   'library': KiCad's pad width, with a taper to the feed width.
export const LAUNCH_MODES = ['matched', 'library'];
export const padWidth = (c, wf, mode = 'matched') => (mode === 'library' ? c.signal.w : wf);

// Launch taper from the signal pad to the feed width: length max(1 mm, 2|Δw|).
export const launchTaper = (c, wf, mode) => { const pw = padWidth(c, wf, mode); return Math.abs(wf - pw) < 1e-3 ? 0 : Math.max(1, 2 * Math.abs(wf - pw)); };

// Straight feed length needed at a port: signal pad + launch taper + 1 mm of feed-width line.
export const minFeed = (c, wf, mode) => c.signal.l + launchTaper(c, wf, mode) + 1;

// Copper of a connector at a port (board coordinates): port point on the edge, outward unit dir.
// Returns polygons: signal pad + launch taper (net of the port) and ground pads (GND).
export function launchCopper(c, at, dir, wf, mode = 'matched') {
  const [ux, uy] = dir, nx = -uy, ny = ux;                 // local x → dir, local y → n
  const P = (x, y) => [at[0] + ux * x + nx * y, at[1] + uy * x + ny * y];
  const rectL = (x0, y0, x1, y1) => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
  const s = c.signal, g = c.ground, Lt = launchTaper(c, wf, mode), pw = padWidth(c, wf, mode);
  const sig = [rectL(-s.l, -pw / 2, 0, pw / 2)];
  if (Lt > 0) sig.push([P(-s.l, -pw / 2), P(-s.l, pw / 2), P(-s.l - Lt, wf / 2), P(-s.l - Lt, -wf / 2)]);
  const gnd = [rectL(-g.l, g.y - g.w / 2, 0, g.y + g.w / 2), rectL(-g.l, -g.y - g.w / 2, 0, -g.y + g.w / 2)];
  if (pw / 2 > g.y - g.w / 2 - 0.2) throw new Error(`${c.mpn}: a ${pw.toFixed(2)} mm signal pad does not fit between the ground pads; use a thinner substrate or launch=library`);
  return { sig, gnd, Lt, pw, mode, end: P(-s.l - Lt, 0) };
}

// Board thickness check: returns a warning string or null.
export function thicknessWarning(c, sub) {
  const t = (sub.dielectric.h + 2 * sub.copper.t) * 1e3;
  if (Math.abs(t - c.board.t) <= c.board.tol) return null;
  return `${c.mpn} is made for ${c.board.t} mm (${c.board.note}) boards; this board is ${t.toFixed(3)} mm. The ground legs will not clamp the board — choose a connector variant for this thickness or a ${c.board.t} mm substrate`;
}
