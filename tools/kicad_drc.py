# Judge a kicad-cli DRC JSON report against tools/kicad-expected.json (issue #9).
#   python3 tools/kicad_drc.py REPORT.json DESIGN EXPECTED.json
# Exit 0 when the design has only allowed violation types (or, for a must_fail design, when every
# required type is reported); 1 otherwise. Prints a one-line verdict and the violation counts.
import json, sys
from collections import Counter

report, design, expected = sys.argv[1], sys.argv[2], sys.argv[3]
r = json.load(open(report))
exp = json.load(open(expected))
found = Counter()
for key, val in r.items():                       # 'violations', 'unconnected_items', 'schematic_parity'
    if isinstance(val, list):
        for v in val:
            if isinstance(v, dict) and 'type' in v:
                found[(v['type'], v.get('severity', '?'))] += 1
types = {t for t, _ in found}
summary = ', '.join(f'{t} ({s}) ×{n}' for (t, s), n in sorted(found.items())) or 'none'
print(f'KiCad {r.get("kicad_version", "?")} DRC for {design}: {summary}')
if design in exp.get('must_fail', {}):
    need = set(exp['must_fail'][design])
    missing = need - types
    if missing:
        print(f'FAIL: {design} is broken on purpose, but DRC did not report {sorted(missing)}'); sys.exit(1)
    print(f'ok: DRC caught the deliberate fault ({sorted(need)})'); sys.exit(0)
allowed = set(exp.get('allow', {}).get(design, []))
unexpected = sorted(types - allowed)
if unexpected:
    print(f'FAIL: unexpected violation types {unexpected} (allowed for {design}: {sorted(allowed) or "none"})'); sys.exit(1)
print('ok: only allowed violations')
