"""Figure for an openEMS comparison (issue #16): |S| of comb-over (solid) and openEMS (dashed), and the
transmission phase difference.  Needs matplotlib.

    node tools/openems.mjs --compare DIR --csv cmp.csv
    python3 tools/oemsfig.py cmp.csv docs/img/ex13-coupler.png [--title TEXT]
"""
import csv, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']        # fixed categorical order, one per S-parameter
INK, INK2, GRID, SURF = '#0b0b0b', '#52514e', '#e4e3df', '#fcfcfb'

def main(src, out, title=None):
    rows = list(csv.DictReader(open(src)))
    f = [float(r['f_GHz']) for r in rows]
    names = sorted({k[3:-3] for k in rows[0] if k.startswith('co_') and k.endswith('_dB')})
    fig, (a, b) = plt.subplots(2, 1, figsize=(8, 6.4), height_ratios=[3, 1.3], sharex=True, facecolor=SURF)
    for ax in (a, b):
        ax.set_facecolor(SURF)
        ax.grid(color=GRID, lw=0.8); ax.set_axisbelow(True)
        for s in ax.spines.values(): s.set_visible(False)
        ax.tick_params(colors=INK2, labelsize=9)
    for n, c in zip(names, SERIES):
        co = [float(r[f'co_{n}_dB']) for r in rows]; em = [float(r[f'em_{n}_dB']) for r in rows]
        a.plot(f, co, color=c, lw=2)
        a.plot(f, em, color=c, lw=2, ls=(0, (4, 2.5)))
    from matplotlib.lines import Line2D
    hs = [Line2D([], [], color=c, lw=2) for c in SERIES[:len(names)]] + [Line2D([], [], color=INK2, lw=2), Line2D([], [], color=INK2, lw=2, ls=(0, (4, 2.5)))]
    a.legend(hs, names + ['comb-over (as built)', 'openEMS'], loc='lower left', ncol=3, frameon=False, fontsize=9, labelcolor=INK)
    a.set_ylabel('|S| (dB)', color=INK2, fontsize=10); a.set_ylim(-50, 1)
    tr = names[1]
    d = [((float(r[f'em_{tr}_deg']) - float(r[f'co_{tr}_deg']) + 540) % 360) - 180 for r in rows]
    b.plot(f, d, color=SERIES[1], lw=2)
    b.set_ylabel(f'∠{tr}: openEMS\n− comb-over (°)', color=INK2, fontsize=10)
    b.set_xlabel('Frequency (GHz)', color=INK2, fontsize=10)
    b.set_xlim(f[0], f[-1])
    if title: a.set_title(title, color=INK, fontsize=11, loc='left')
    fig.tight_layout()
    fig.savefig(out, dpi=130, facecolor=SURF)

if __name__ == '__main__':
    args = sys.argv[1:]
    t = args[args.index('--title') + 1] if '--title' in args else None
    main(args[0], args[1], t)
