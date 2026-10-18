# Run inside the KiCad 9 container: KiCad's own view of a generated part.
#   python3 tools/kicad_check.py DESIGN_DIR
# 1. load the library footprint and re-save it with KiCad's writer, and report how KiCad's
#    output differs from ours (normalisation, dropped or unknown tokens);
# 2. compare the footprint embedded in the check board with the library copy (FootprintNeedsUpdate).
import difflib, glob, os, re, sys, tempfile
import pcbnew

d = sys.argv[1]
pretty = glob.glob(os.path.join(d, '*.pretty'))[0]
name = os.path.splitext(os.path.basename(glob.glob(os.path.join(pretty, '*.kicad_mod'))[0]))[0]
ours = open(os.path.join(pretty, name + '.kicad_mod')).read()
fp = pcbnew.FootprintLoad(pretty, name)
print(f'{name}: {len(fp.Pads())} pads, {len(fp.Zones())} zone(s)')
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
theirs = open(os.path.join(tmp, name + '.kicad_mod')).read() if saved else ours
norm = lambda t: [l.strip() for l in re.sub(r'\(uuid "[^"]*"\)', '', t).replace('(', '\n(').splitlines() if l.strip()]
diff = [l for l in difflib.unified_diff(norm(ours), norm(theirs), 'ours', 'kicad', n=0, lineterm='') if not l.startswith('@@')]
print(f'resave diff ({len(diff)} lines, uuids ignored):')
print('\n'.join(diff[:80]))
b = pcbnew.LoadBoard(glob.glob(os.path.join(d, 'check', '*.kicad_pcb'))[0])
bfp = [f for f in b.GetFootprints() if f.GetFPID().GetLibItemName() == name][0]
try:
    rep = pcbnew.WX_STRING_REPORTER()
    need = bfp.FootprintNeedsUpdate(fp, 0, rep)
    print('board copy needs update:', need, rep.GetMessages())
except Exception as e:
    print('FootprintNeedsUpdate not available from Python:', e)
