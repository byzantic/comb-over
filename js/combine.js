// Combine the core netlists of several comb-over parts into one netlist, for simulating a system built from them.
//
//   combine([{ prefix: 'A', text }, { prefix: 'B', text }, …], { title, ports: ['A.in', 'B.o1:50', …] })
//       → { text, parts: [{ prefix, title, ports: [{ node, z, as }] }] }
//
// Each part's names get its prefix: nodes (except ground and open), element and section names, and .param names (also
// where expressions use them). Every part must be on the same .substrate. The parts' own ports become ordinary nodes
// (PREFIX_node), listed in a comment; .plot, .goal, .smith, .opt and .layout lines are dropped. The netlist takes .freq
// and .ref from the first part. `ports` lists the system's ports in order (PREFIX.node[:Z]); the interconnecting
// tracks between parts are yours to add (e.g. T lines of the feed width), after the combined text.
import { GROUND, OPEN } from './netlist.js';

const KEEP = (n) => GROUND.has(n) || OPEN.has(n);
const isKV = (t) => /^[A-Za-z_]\w*=/.test(t);
const NAMED = new Set(['cap', 'via', 'tee', 'bend', 'step', 'res']);     // keyword NAME node… key=value…
const DROP = new Set(['.plot', '.goal', '.smith', '.opt', '.layout', '.data']);

function splitComment(line) {
  const i = line.indexOf('#');
  return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i)];
}

export function combine(parts, { title, ports = [] } = {}) {
  if (!parts.length) throw new Error('combine: no parts');
  const seen = new Set();
  for (const p of parts) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(p.prefix)) throw new Error(`combine: prefix "${p.prefix}": a letter, then letters or digits`);
    if (seen.has(p.prefix)) throw new Error(`combine: prefix ${p.prefix} used twice`);
    seen.add(p.prefix);
  }
  let freq = null, ref = null, sub = null, subFrom = null;
  const body = [], info = [];
  for (const { prefix: P, text } of parts) {
    const lines = text.split(/\r?\n/);
    // the part's .param names, renamed wherever an expression uses them
    const params = new Set(lines.map(l => l.match(/^\s*\.param\s+([A-Za-z_]\w*)\s*=/)?.[1]).filter(Boolean));
    const ren = (expr) => expr.replace(/[A-Za-z_]\w*/g, (w, i, s) => (params.has(w) && !/[\d.]/.test(s[i - 1] ?? '') ? `${P}_${w}` : w));
    const node = (n) => (KEEP(n) ? n : `${P}_${n}`);
    const kvs = (toks) => toks.map(t => (isKV(t) ? t.replace(/=(.*)$/, (m, v) => `=${ren(v)}`) : ren(t)));
    const me = { prefix: P, title: '', ports: [] };
    const out = [];
    let inCline = false;
    for (const raw of lines) {
      if (!inCline && /^\s*\.title\b/i.test(raw)) { me.title = raw.trim().slice(6).trim(); continue; }   // a title may hold '#'
      const [code, cmt] = splitComment(raw), t = code.trim().split(/\s+/).filter(Boolean);
      if (!t.length) { if (cmt.trim()) out.push(raw); continue; }
      const k = t[0], kl = k.toLowerCase();
      if (inCline) {
        if (kl === 'end') { out.push(raw); inCline = false; continue; }
        if (k === 'A' || k === 'B') { out.push(`  ${k} ${t.slice(1).map(node).join(' ')}${cmt ? ' ' + cmt : ''}`); continue; }
        out.push(`  ${k} ${kvs(t.slice(1)).join(' ')}${cmt ? ' ' + cmt : ''}`.trimEnd());
        continue;
      }
      if (kl === '.freq') { freq ??= code.trim(); continue; }
      if (kl === '.ref') { ref ??= code.trim(); continue; }
      if (kl === '.substrate') {
        const s = t.join(' ');
        if (sub == null) { sub = s; subFrom = P; } else if (s !== sub) throw new Error(`combine: part ${P} is on "${s}", part ${subFrom} on "${sub}"; one netlist has one substrate`);
        continue;
      }
      if (DROP.has(kl)) continue;
      if (kl === '.param') { out.push(`.param ${P}_${t[1].replace(/=.*$/, '')} ${ren(code.trim().replace(/^\.param\s+[A-Za-z_]\w*\s*/, ''))}${cmt ? '   ' + cmt : ''}`); continue; }
      if (k.startsWith('.')) throw new Error(`combine: part ${P}: cannot combine a ${k} statement`);
      if (kl === 'port') { me.ports.push({ node: t[1], z: t[2] != null ? +t[2] : 50, as: node(t[1]) }); continue; }
      if (kl === 'cline') { out.push(`cline ${P}_${t[1]} ${kvs(t.slice(2)).join(' ')}${cmt ? ' ' + cmt : ''}`.trimEnd()); inCline = true; continue; }
      if (kl === 'wire') { out.push(`wire ${t.slice(1).map(node).join(' ')}${cmt ? ' ' + cmt : ''}`); continue; }
      if (NAMED.has(kl)) {
        const rest = t.slice(2), nodes = rest.filter(x => !isKV(x)), kv = rest.filter(isKV);
        out.push(`${k} ${P}_${t[1]} ${[...nodes.map(node), ...kvs(kv)].join(' ')}${cmt ? ' ' + cmt : ''}`);
        continue;
      }
      const c = k[0].toUpperCase();
      if ('RCLT'.includes(c) && k.length > 1) {
        // R/C/L: name n1 n2 value [key=…]; T: name n1 n2 key=…
        out.push(`${k[0]}${P}_${k.slice(1)} ${node(t[1])} ${node(t[2])} ${kvs(t.slice(3)).join(' ')}${cmt ? ' ' + cmt : ''}`.trimEnd());
        continue;
      }
      throw new Error(`combine: part ${P}: cannot read "${code.trim()}"`);
    }
    if (inCline) throw new Error(`combine: part ${P}: cline without end`);
    info.push(me);
    body.push(`# ---- part ${P}: ${me.title || '(untitled)'}`, `# ${P}'s ports: ${me.ports.map((p, i) => `${i + 1} ${p.node} → ${p.as} (${p.z} Ω)`).join(', ')}`, ...out, '');
  }
  if (!freq) throw new Error('combine: no .freq in the first part');
  const portLines = ports.map((s) => {
    const m = s.match(/^([A-Za-z][A-Za-z0-9]*)\.([^:\s]+)(?::(\S+))?$/);
    if (!m) throw new Error(`combine: port "${s}": write PREFIX.node[:Z]`);
    const part = info.find(p => p.prefix === m[1]);
    if (!part) throw new Error(`combine: port ${s}: no part ${m[1]}`);
    const pp = part.ports.find(p => p.node === m[2]);
    if (!pp) throw new Error(`combine: port ${s}: part ${m[1]} has no port ${m[2]} (it has ${part.ports.map(p => p.node).join(', ')})`);
    return `port ${pp.as} ${m[3] ?? pp.z}`;
  });
  const text = [
    `.title ${title ?? info.map(p => p.prefix).join(' + ')}`,
    `# combined by comb-over from the parts' core netlists: ${info.map(p => `${p.prefix} = ${p.title || '(untitled)'}`).join('; ')}`,
    freq, ...(ref ? [ref] : []), ...(sub ? [sub] : []),
    ...portLines, '',
    ...body,
    '# ---- the tracks between the parts (add yours here, e.g. Tlink1 A_thru B_c W=<feed width from the README> len=<track length>)',
  ].join('\n') + '\n';
  return { text, parts: info };
}
