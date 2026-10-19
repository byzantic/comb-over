#!/usr/bin/env bash
# Validate generated KiCad projects with KiCad's own tools (runs inside a kicad/kicad container).
#   tools/kicad-check.sh OUTDIR     OUTDIR holds one folder per design, as written by tools/kicad.mjs --board
# For each design:
#   - footprint and symbol libraries parse (kicad-cli SVG export);
#   - every footprint re-saves identically with KiCad's writer, and the board loads (tools/kicad_check.py);
#   - zones are filled with KiCad's filler and DRC is judged against tools/kicad-expected.json
#     (tools/kicad_drc.py): unexpected violation types fail, deliberately broken designs must be caught;
#   - Gerbers and drill files export.
# Results are also posted as GitHub annotations, so they can be read without the job log.
set -u
out=${1:?usage: kicad-check.sh OUTDIR}
export HOME=${HOME:-/tmp}
here=$(cd "$(dirname "$0")" && pwd)
note() { local level=$1 title=$2; shift 2; local msg; msg=$(printf '%s' "$*" | head -c 60000 | sed ':a;N;$!ba;s/%/%25/g;s/\r/%0D/g;s/\n/%0A/g'); echo "::${level} title=${title}::${msg}"; }
run() { local log; log=$("$@" 2>&1); local rc=$?; echo "$log"; LAST="$log"; return $rc; }
ver=$(kicad-cli version 2>&1)
note notice "kicad-cli" "$ver"
status=0
for d in "$out"/*/; do
  d=${d%/}; name=$(basename "$d")
  echo "=== $name (KiCad $ver)"
  pretty=$(ls -d "$d"/*.pretty | head -1); sym=$(ls "$d"/*.kicad_sym | head -1)
  board=$(ls "$d"/*.kicad_pcb | head -1)
  run kicad-cli fp export svg --output "$d/svg" "$pretty" || { note error "$name footprint" "$LAST"; status=1; }
  run kicad-cli sym export svg --output "$d/svg" "$sym" || { note error "$name symbol" "$LAST"; status=1; }
  if run python3 "$here/kicad_check.py" "$d"; then view="$LAST"; else note error "$name KiCad view" "$LAST"; status=1; view=""; fi
  # fill zones with KiCad's own filler (kicad-cli 9.0 drc has no --refill-zones)
  run python3 -c "import pcbnew,sys; b=pcbnew.LoadBoard(sys.argv[1]); pcbnew.ZONE_FILLER(b).Fill(b.Zones()); b.Save(sys.argv[1])" "$board" || { note error "$name zone fill" "$LAST"; status=1; }
  kicad-cli pcb drc --severity-all --format json --units mm --output "$d/drc-all.json" "$board" >/dev/null 2>&1 || true
  kicad-cli pcb drc --severity-all --units mm --output "$d/drc-all.rpt" "$board" >/dev/null 2>&1 || true
  # one notice per design (GitHub keeps at most 10 notices per step)
  if run python3 "$here/kicad_drc.py" "$d/drc-all.json" "$name" "$here/kicad-expected.json"; then
    note notice "$name" "$LAST
$view"
  else
    note error "$name DRC" "$LAST
$(cat "$d/drc-all.rpt" 2>/dev/null)"; status=1
  fi
  run kicad-cli pcb export gerbers --output "$d/gerbers/" "$board" || { note error "$name gerbers" "$LAST"; status=1; }
  run kicad-cli pcb export drill --output "$d/gerbers/" "$board" || { note error "$name drill" "$LAST"; status=1; }
done
exit $status
