#!/usr/bin/env bash
# Validate generated KiCad parts with kicad-cli (runs inside the kicad/kicad:9.0 container).
#   tools/kicad-check.sh OUTDIR     OUTDIR holds one folder per design, as written by tools/kicad.mjs --board
# For each design: parse the footprint and symbol libraries (SVG export), run DRC on the
# board (zones refilled; any error-level violation fails), and export Gerbers.
set -u
out=${1:?usage: kicad-check.sh OUTDIR}
export HOME=${HOME:-/tmp}
note notice "kicad-cli" "$(kicad-cli version 2>&1)"
status=0
# GitHub annotation with a whole file (or text) as its message, so results are visible without the log
note() { local level=$1 title=$2; shift 2; local msg; msg=$(printf '%s' "$*" | head -c 60000 | sed ':a;N;$!ba;s/%/%25/g;s/\r/%0D/g;s/\n/%0A/g'); echo "::${level} title=${title}::${msg}"; }
run() { local log; log=$("$@" 2>&1); local rc=$?; echo "$log"; LAST="$log"; return $rc; }
for d in "$out"/*/; do
  d=${d%/}; name=$(basename "$d")
  echo "=== $name"
  pretty=$(ls -d "$d"/*.pretty | head -1); sym=$(ls "$d"/*.kicad_sym | head -1)
  board=$(ls "$d"/*.kicad_pcb | head -1)
  run kicad-cli fp export svg --output "$d/svg" "$pretty" || { note error "$name footprint" "$LAST"; status=1; }
  run kicad-cli sym export svg --output "$d/svg" "$sym" || { note error "$name symbol" "$LAST"; status=1; }
  run python3 tools/kicad_check.py "$d" && note notice "$name KiCad view" "$LAST" || { note error "$name KiCad view" "$LAST"; status=1; }
  # fill zones with KiCad's own filler (kicad-cli 9.0 drc has no --refill-zones)
  run python3 -c "import pcbnew,sys; b=pcbnew.LoadBoard(sys.argv[1]); pcbnew.ZONE_FILLER(b).Fill(b.Zones()); b.Save(sys.argv[1])" "$board" || { note error "$name zone fill" "$LAST"; status=1; }
  kicad-cli pcb drc --severity-all --format json --units mm --output "$d/drc-all.json" "$board" || true
  kicad-cli pcb drc --severity-all --units mm --output "$d/drc-all.rpt" "$board" || true
  cat "$d/drc-all.rpt"
  if ! run kicad-cli pcb drc --severity-error --exit-code-violations --units mm --output "$d/drc-err.rpt" "$board"; then
    note error "$name DRC" "$LAST
$(cat "$d/drc-all.rpt" 2>/dev/null)"; status=1
  else
    note notice "$name DRC" "$(cat "$d/drc-all.rpt" 2>/dev/null)"
  fi
  run kicad-cli pcb export gerbers --output "$d/gerbers/" "$board" || { note error "$name gerbers" "$LAST"; status=1; }
  ls "$d/gerbers" | head -20
done
exit $status
