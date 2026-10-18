// Build the HTML documentation from the Markdown sources in docs/.
//
//   npm run docs            write docs/manual.html, docs/examples/*.html
//   npm run docs -- --check exit 1 if any generated page is out of date
//
// The Markdown stays the source of truth (it also renders on GitHub). Links to .md pages become
// .html, links to examples/*.cir open that netlist in the designer, and headings get GitHub-style
// ids so in-page anchors work the same in both places.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

// page list: [source md, output html, nav title]
const EXAMPLES = [
  ['01-transformers', 'Quarter-wave transformers'],
  ['02-couplers', 'Coupled-line couplers'],
  ['03-combline-synthesis', 'Comb-line: spec to loss budget'],
  ['04-interdigital-by-hand', 'Interdigital by hand'],
  ['05-marchand-balun', 'Marchand balun'],
  ['06-schiffman', 'Schiffman phase shifter'],
  ['07-three-line-CL', 'Three-line section from C, L'],
];
const PAGES = [
  { src: 'docs/manual.md', out: 'docs/manual.html', title: 'Manual', kind: 'manual' },
  { src: 'docs/examples/README.md', out: 'docs/examples/index.html', title: 'Worked examples', kind: 'index' },
  ...EXAMPLES.map(([f, t], i) => ({ src: `docs/examples/${f}.md`, out: `docs/examples/${f}.html`, title: `${i + 1}. ${t}`, kind: 'example', idx: i })),
];

// GitHub-compatible heading slugs
function slugger() {
  const seen = new Map();
  return (text) => {
    let s = text.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(s) || 0; seen.set(s, n + 1);
    return n ? `${s}-${n}` : s;
  };
}
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function rewriteHref(href, pageOut) {
  if (/^[a-z]+:|^#/.test(href)) return { href };
  const [path, hash = ''] = href.split('#');
  const pageDir = dirname(pageOut);
  const target = posix.normalize(posix.join(pageDir, path));
  if (target.endsWith('.md')) {
    const html = target.endsWith('README.md') ? target.replace(/README\.md$/, 'index.html') : target.replace(/\.md$/, '.html');
    return { href: posix.relative(pageDir, html) + (hash ? '#' + hash : '') };
  }
  const m = /^examples\/([\w.-]+\.cir)$/.exec(target);
  if (m) return { href: posix.relative(pageDir, 'index.html') + '?example=' + encodeURIComponent(m[1]), designer: true };
  return { href };
}

function render(page) {
  const md = readFileSync(join(ROOT, page.src), 'utf8');
  const slug = slugger();
  const toc = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const id = slug(plain(inner));
        if (depth === 2) toc.push({ id, text: plain(inner) });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const r = rewriteHref(href, page.out);
        const text = this.parser.parseInline(tokens);
        const t = title ? ` title="${title}"` : r.designer ? ' title="Open this netlist in the designer"' : '';
        return `<a href="${r.href}"${t}${r.designer ? ' class="designer-link"' : ''}>${text}</a>`;
      },
      image({ href, title, text }) {
        return `<figure><img src="${href}" alt="${text}" loading="lazy"${title ? ` title="${title}"` : ''}>${text ? `<figcaption>${text}</figcaption>` : ''}</figure>`;
      },
    },
  });
  let body = marked.parse(md).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  // The first h1 is the page title; drop it from the body and use it in the header.
  const h1 = /<h1 id="[^"]*">(?:<a[^>]*>#<\/a>)?([\s\S]*?)<\/h1>\n?/.exec(body);
  const pageTitle = h1 ? plain(h1[1]) : page.title;
  if (h1) body = body.replace(h1[0], '');
  return { body, toc, pageTitle, h1: h1 ? h1[1] : page.title };
}

function layout(page, { body, toc, pageTitle, h1 }) {
  const rel = (p) => posix.relative(dirname(page.out), p) || '.';
  const nav = [];
  nav.push(`<a class="${page.kind === 'manual' ? 'current' : ''}" href="${rel('docs/manual.html')}">Manual</a>`);
  if (page.kind === 'manual') nav.push('<ol class="toc">' + toc.filter(t => t.id !== 'contents').map(t => `<li><a href="#${t.id}">${t.text}</a></li>`).join('') + '</ol>');
  nav.push(`<a class="${page.kind === 'index' ? 'current' : ''}" href="${rel('docs/examples/index.html')}">Worked examples</a>`);
  nav.push('<ol class="examples">' + EXAMPLES.map(([f, t], i) => `<li><a class="${page.idx === i ? 'current' : ''}" href="${rel(`docs/examples/${f}.html`)}">${t}</a></li>`).join('') + '</ol>');
  let pager = '';
  if (page.kind === 'example') {
    const prev = page.idx > 0 ? EXAMPLES[page.idx - 1] : null, next = EXAMPLES[page.idx + 1];
    pager = `<nav class="pager">${prev ? `<a href="${prev[0]}.html">← ${page.idx}. ${prev[1]}</a>` : `<a href="index.html">← All examples</a>`}${next ? `<a class="next" href="${next[0]}.html">${page.idx + 2}. ${next[1]} →</a>` : `<a class="next" href="${rel('docs/manual.html')}">Manual →</a>`}</nav>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle} · comb-over</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${rel('css/tokens.css')}">
<link rel="stylesheet" href="${rel('docs/docs.css')}">
</head>
<body>
<!-- Generated by tools/build-docs.mjs from ${page.src}; edit the Markdown, then run "npm run docs". -->
<header class="top">
  <a class="brand" href="${rel('index.html')}"><span class="logo">⫼</span> comb-over</a>
  <nav class="top-links">
    <a href="${rel('index.html')}" class="btn primary">Open the designer</a>
    <a href="${rel('docs/manual.html')}" class="${page.kind === 'manual' ? 'current' : ''}">Manual</a>
    <a href="${rel('docs/examples/index.html')}" class="${page.kind !== 'manual' ? 'current' : ''}">Examples</a>
  </nav>
</header>
<div class="layout">
  <aside class="side"><nav>${nav.join('\n')}</nav></aside>
  <main class="doc">
    <h1>${h1}</h1>
${body}
${pager}
  </main>
</div>
</body>
</html>
`;
}

let stale = 0;
for (const page of PAGES) {
  const html = layout(page, render(page));
  const out = join(ROOT, page.out);
  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== html) { console.log(`stale: ${page.out}`); stale++; }
  } else {
    writeFileSync(out, html);
    console.log(`wrote ${page.out}`);
  }
}
if (check) { if (stale) { console.log('run "npm run docs" to regenerate'); process.exit(1); } else console.log('docs up to date'); }
