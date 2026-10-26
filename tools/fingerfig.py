"""Figures for worked example 14 (issue #41): the finger-loaded pair's geometry, and directivity of two couplers
from their openEMS comparisons.  Needs matplotlib.

    python3 tools/fingerfig.py geometry OUT.png W G wf lf p [CELLS]
    node tools/openems.mjs --compare examples/em/coupler-15dB-ro4350b-compare.cir --csv plain.csv
    node tools/openems.mjs --compare examples/em/coupler-15dB-fingers-ro4350b-compare.cir --csv fingers.csv
    python3 tools/fingerfig.py directivity OUT.png plain.csv fingers.csv [caps.csv] [--pair 13,23 --title T --labels a,b]
    python3 tools/fingerfig.py polys OUT.png LAYOUT.json [--xlim a,b --ylim a,b --title T]   (copper from a layout's items)
"""
import csv, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Polygon

SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']
INK, INK2, GRID, SURF, COPPER = '#0b0b0b', '#52514e', '#e4e3df', '#fcfcfb', '#c98a3d'


def comb(W, G, wf, lf, p, n, offset, sign):
    """Outline of one line (as js/fingers.js): backbone on the side `sign` of y = 0, fingers towards y = 0."""
    y0 = sign * G / 2
    pts = [(0, y0 + sign * W), (n * p, y0 + sign * W), (n * p, y0)]
    for k in reversed(range(n)):
        c = (k + offset) * p
        pts += [(c + wf / 2, y0), (c + wf / 2, y0 - sign * lf), (c - wf / 2, y0 - sign * lf), (c - wf / 2, y0)]
    pts.append((0, y0))
    return pts


def geometry(out, W, G, wf, lf, p, n=3):
    W, G, wf, lf, p, n = float(W), float(G), float(wf), float(lf), float(p), int(n)
    fig, ax = plt.subplots(figsize=(6.4, 3.9), facecolor=SURF)
    ax.set_facecolor(SURF)
    for pts in (comb(W, G, wf, lf, p, n, 0.25, -1), comb(W, G, wf, lf, p, n, 0.75, 1)):
        ax.add_patch(Polygon(pts, closed=True, fc=COPPER, ec='#8a5a20', lw=0.8))
    ax.set_xlim(-0.1, n * p + 0.1); ax.set_ylim(-G / 2 - W - 0.1, G / 2 + W + 0.1); ax.set_aspect('equal')
    for s in ax.spines.values(): s.set_visible(False)
    ax.tick_params(colors=INK2, labelsize=9); ax.set_xlabel('x (mm)', color=INK2, fontsize=10); ax.set_ylabel('y (mm)', color=INK2, fontsize=10)

    def dim(x0, y0, x1, y1, text, dx=0, dy=0, ha='center'):
        ax.annotate('', (x0, y0), (x1, y1), arrowprops=dict(arrowstyle='<->', color=INK, lw=0.9, shrinkA=0, shrinkB=0))
        ax.text((x0 + x1) / 2 + dx, (y0 + y1) / 2 + dy, text, color=INK, fontsize=9, ha=ha, va='center')
    c1 = 0.25 * p
    dim(c1 - wf / 2, -G / 2 - 0.12, c1 + wf / 2, -G / 2 - 0.12, f'wf {wf:g}', dy=-0.09)
    dim(c1 + wf / 2 + 0.05, -G / 2, c1 + wf / 2 + 0.05, -G / 2 + lf, f'lf {lf:g}', dx=0.04, ha='left')
    dim(p * 1.25, -G / 2, p * 1.25 + p, -G / 2, f'p {p:g}', dy=-0.08)
    dim(n * p - 0.05, -G / 2, n * p - 0.05, G / 2, f'G {G:g}', dx=-0.04, ha='right')
    dim(n * p - 0.05, G / 2, n * p - 0.05, G / 2 + W, f'W {W:g}', dx=-0.04, ha='right')
    ax.set_title(f'Finger-loaded pair, {n} cells (mm)\ntip gap {G - lf:.3g} · overlap {2 * lf - G:.3g} · side gap {p / 2 - wf:.3g}',
                 color=INK, fontsize=10, loc='left')
    fig.tight_layout(); fig.savefig(out, dpi=130, facecolor=SURF)


def directivity(out, *args):
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d
    srcs = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or not args[i - 1].startswith('--'))]
    c, i_ = opt('--pair', '31,41').split(',')
    labels = opt('--labels', 'plain,finger-loaded,end capacitors').split(',')
    fig, ax = plt.subplots(figsize=(8, 4.2), facecolor=SURF)
    ax.set_facecolor(SURF); ax.grid(color=GRID, lw=0.8); ax.set_axisbelow(True)
    for s in ax.spines.values(): s.set_visible(False)
    ax.tick_params(colors=INK2, labelsize=9)
    for i, src in enumerate(srcs):
        rows = list(csv.DictReader(open(src)))
        f = [float(r['f_GHz']) for r in rows]
        for pre, ls in (('co_', '-'), ('em_', (0, (4, 2.5)))):
            ax.plot(f, [float(r[f'{pre}S{c}_dB']) - float(r[f'{pre}S{i_}_dB']) for r in rows], color=SERIES[i], lw=2, ls=ls)
    hs = [Line2D([], [], color=SERIES[i], lw=2) for i in range(len(srcs))] + [Line2D([], [], color=INK2, lw=2), Line2D([], [], color=INK2, lw=2, ls=(0, (4, 2.5)))]
    ax.legend(hs, labels[:len(srcs)] + ['comb-over (as built)', 'openEMS'], loc='lower left', ncol=2, frameon=False, fontsize=9, labelcolor=INK)
    ax.set_ylabel(f'Directivity |S{c}| − |S{i_}| (dB)', color=INK2, fontsize=10); ax.set_xlabel('Frequency (GHz)', color=INK2, fontsize=10)
    ax.set_ylim(-10, 50)
    ax.set_title(opt('--title', '15 dB couplers on 0.508 mm RO4350B: directivity'), color=INK, fontsize=11, loc='left')
    fig.tight_layout(); fig.savefig(out, dpi=130, facecolor=SURF)


def polys(out, src, *args):
    import json
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d
    items = json.load(open(src))
    fig, ax = plt.subplots(figsize=(8, 5), facecolor=SURF)
    ax.set_facecolor(SURF)
    for it in items:
        ax.add_patch(Polygon(it['pts'], closed=True, fc=COPPER if it.get('role') != 'feed' else '#d8b27e', ec='#8a5a20', lw=0.4))
    ax.autoscale(); ax.set_aspect('equal')
    if opt('--xlim', None): ax.set_xlim(*map(float, opt('--xlim', '').split(',')))
    if opt('--ylim', None): ax.set_ylim(*map(float, opt('--ylim', '').split(',')))
    for sp in ax.spines.values(): sp.set_visible(False)
    ax.tick_params(colors=INK2, labelsize=9); ax.set_xlabel('x (mm)', color=INK2, fontsize=10); ax.set_ylabel('y (mm)', color=INK2, fontsize=10)
    ax.set_title(opt('--title', ''), color=INK, fontsize=11, loc='left')
    fig.tight_layout(); fig.savefig(out, dpi=130, facecolor=SURF)


if __name__ == '__main__':
    cmd, out, *args = sys.argv[1:]
    {'geometry': geometry, 'directivity': directivity, 'polys': polys}[cmd](out, *args)
