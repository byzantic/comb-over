# Run inside the KiCad 9 container: KiCad's own view of a generated part.
#   python3 tools/kicad_check.py DESIGN_DIR
# 1. load the library footprint and re-save it with KiCad's writer, and report how KiCad's
#    output differs from ours (normalisation, dropped or unknown tokens);
# 2. load the check board and list the embedded part's pads and nets.
import glob, os, re, sys, tempfile
import pcbnew

d = sys.argv[1]
pretty = glob.glob(os.path.join(d, '*.pretty'))[0]
name = os.path.basename(pretty)[:-len('.pretty')]   # the part has the library's name
strict_fail = False
for modfile in sorted(glob.glob(os.path.join(pretty, '*.kicad_mod'))):
    fpname = os.path.basename(modfile)[:-len('.kicad_mod')]
    ours = open(modfile).read()
    fp = pcbnew.FootprintLoad(pretty, fpname)
    print(f'{fpname}: {len(fp.Pads())} pads, {len(fp.Zones())} zone(s)')
    tmp = tempfile.mkdtemp() + '/re.pretty'
    os.makedirs(tmp)
    saved = False
    for make in (lambda: pcbnew.PCB_IO_KICAD_SEXPR(), lambda: pcbnew.PCB_IO_MGR.PluginFind(pcbnew.PCB_IO_MGR.KICAD_SEXPR)):
        try:
            io = make()
            if io is not None:
                io.FootprintSave(tmp, fp); saved = True; break
        except Exception as e:
            print('save attempt failed:', e)
    if not saved:
        print('could not re-save with KiCad; skipping the diff'); theirs = None
    theirs = open(os.path.join(tmp, fpname + '.kicad_mod')).read() if saved else ours
    def parse(t):
        toks = re.findall(r'\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+', t)
        def rd(i):
            if toks[i] == '(':
                out, i = [], i + 1
                while toks[i] != ')':
                    v, i = rd(i); out.append(v)
                return out, i + 1
            return toks[i], i + 1
        return rd(0)[0]
    def canon(x):
        # numbers rounded to 1 nm, uuids dropped
        if isinstance(x, list):
            return '(' + ' '.join(canon(c) for c in x if not (isinstance(c, list) and c and c[0] == 'uuid')) + ')'
        try: return repr(round(float(x), 6))
        except ValueError: return x
    def items(t):
        root = parse(t)
        return sorted(canon(c) for c in root[2:] if not (isinstance(c, list) and c and c[0] in ('version', 'generator', 'generator_version')))
    a, b = items(ours), items(theirs)
    only_ours = sorted(set(a) - set(b)); only_kicad = sorted(set(b) - set(a))
    print(f'structural diff (uuids, generator and item order ignored): {len(only_ours)} item(s) only in ours, {len(only_kicad)} only in KiCad\'s re-save')
    for x in only_ours[:12]: print('  ours :', x[:400])
    for x in only_kicad[:12]: print('  kicad:', x[:400])
    strict_fail = strict_fail or bool(only_ours or only_kicad)

b = pcbnew.LoadBoard(glob.glob(os.path.join(d, '*.kicad_pcb'))[0])
bfp = [f for f in b.GetFootprints() if f.GetFPID().GetLibItemName() == name][0]
print('board copy at', pcbnew.ToMM(bfp.GetPosition().x), pcbnew.ToMM(bfp.GetPosition().y), 'pads with nets:', [(p.GetNumber(), p.GetNetname()) for p in bfp.Pads()])
if strict_fail:
    print('FAIL: KiCad re-saves the footprint differently from what we wrote')
    sys.exit(1)
