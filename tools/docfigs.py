"""Regenerate the PNG figures used in docs/ (needs: pip install playwright; playwright install chromium).

    python3 -m http.server 8765 &      # from the repository root
    python3 tools/docfigs.py
"""
import asyncio, base64, re, pathlib
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = 'http://localhost:8765/index.html'
OUT = ROOT / 'docs' / 'img'

def text(name):
    return (ROOT / 'examples' / name).read_text()

def lossy_comb():
    t = text('combline-synth-5pole.cir')
    t = t.replace('  er 1\n', '  er 1\n  Q 2000\n')
    t = re.sub(r'^(C\d r\d 0 cl1?)$', r'\1 Q=1000', t, flags=re.M)
    t = t.replace('.title Comb-line', '.title Lossy comb-line')
    t = re.sub(r'^\.freq .*$', '.freq 0.94G 1.06G 801', t, flags=re.M)
    t = re.sub(r'^\.plot ylim=-70,0 .*$', '.plot ylim=-1.5,0 title=Insertion_loss_(dB) db(S21)', t, flags=re.M)
    return t

def wide_comb():
    t = text('combline-synth-5pole.cir')
    t = re.sub(r'^\.freq .*$', '.freq 0.2G 6G 12001', t, flags=re.M)
    t = re.sub(r'^\.plot ylim=-70,0 .*$', '.plot ylim=-120,0 title=Wideband_|S21|_(dB) db(S21)', t, flags=re.M)
    return t

FIGS = [
    # (file name, netlist text, plot indices to capture)
    ('transformers', text('transformers.cir'), [0, 1]),
    ('coupler3db', text('coupler-3dB-stripline.cir'), [0, 1]),
    ('coupler10db', text('coupler-10dB-microstrip.cir'), [0, 1]),
    ('comb-polished', text('combline-synth-5pole.cir'), [0, 1]),
    ('comb-lossy', lossy_comb(), [0]),
    ('comb-wide', wide_comb(), [0]),
    ('id-hand', text('interdigital-by-hand.cir'), [0]),
    ('id-synth', text('interdigital-synth-3pole.cir'), [0]),
    ('marchand', text('marchand-balun.cir'), [0, 1, 2]),
    ('schiffman', text('schiffman-90.cir'), [0]),
    ('three-line', text('three-line-CL.cir'), [0]),
]

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1360, 'height': 900}, color_scheme='light', device_scale_factor=2)
        for name, net, idx in FIGS:
            h = base64.b64encode(net.encode()).decode()
            await pg.goto(URL + '#n=' + h)
            await pg.evaluate('localStorage.clear()')
            await pg.reload()
            await pg.wait_for_timeout(900)
            plots = await pg.query_selector_all('.plot')
            for i in idx:
                await plots[i].screenshot(path=str(OUT / f'{name}-{i + 1}.png'))
            st = await pg.inner_text('#status')
            print(name, '|', st.splitlines()[0])
        # UI overview and synthesis dialog
        await pg.goto(URL + '#n=' + base64.b64encode(text('combline-synth-5pole.cir').encode()).decode())
        await pg.evaluate('localStorage.clear()')
        await pg.reload(); await pg.wait_for_timeout(900)
        await pg.screenshot(path=str(OUT / 'ui-overview.png'))
        await pg.click('#btn-synth'); await pg.wait_for_timeout(300)
        await pg.fill('input[name=n]', '5'); await pg.fill('input[name=fbw]', '6'); await pg.fill('input[name=theta0Deg]', '40')
        await pg.fill('input[name=f0]', '1G'); await pg.fill('input[name=Zr]', '70'); await pg.fill('input[name=er]', '1')
        await (await pg.query_selector('#synth')).screenshot(path=str(OUT / 'ui-synth.png'))
        await b.close()

asyncio.run(main())
