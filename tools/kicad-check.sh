#!/usr/bin/env bash
# Validate generated KiCad parts with kicad-cli (runs inside the kicad/kicad:9.0 container).
#   tools/kicad-check.sh OUTDIR     OUTDIR holds one folder per design, as written by tools/kicad.mjs --check
# For each design: parse the footprint and symbol libraries (SVG export), run DRC on the check
# board (zones refilled; any error-level violation fails), and export Gerbers.
set -u
out=${1:?usage: kicad-check.sh OUTDIR}
export HOME=${HOME:-/tmp}
kicad-cli version
status=0
for d in "$out"/*/; do
  d=${d%/}; name=$(basename "$d")
  echo "=== $name"
  pretty=$(ls -d "$d"/*.pretty | head -1); sym=$(ls "$d"/*.kicad_sym | head -1)
  board=$(ls "$d"/check/*.kicad_pcb | head -1)
  kicad-cli fp export svg --output "$d/svg" "$pretty" || { echo "FAIL footprint parse: $name"; status=1; }
  kicad-cli sym export svg --output "$d/svg" "$sym" || { echo "FAIL symbol parse: $name"; status=1; }
  kicad-cli pcb drc --refill-zones --severity-all --format json --units mm --output "$d/drc-all.json" "$board" || true
  kicad-cli pcb drc --refill-zones --severity-all --units mm --output "$d/drc-all.rpt" "$board" || true
  cat "$d/drc-all.rpt"
  if ! kicad-cli pcb drc --refill-zones --severity-error --exit-code-violations --units mm --output "$d/drc-err.rpt" "$board"; then
    echo "FAIL DRC errors: $name"; status=1
  fi
  kicad-cli pcb export gerbers --output "$d/gerbers/" "$board" || { echo "FAIL gerber export: $name"; status=1; }
  ls "$d/gerbers" | head -20
done
exit $status
