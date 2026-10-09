#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ] || [[ "$1" != /* ]] || [ -e "$1" ]; then
  echo 'Usage: packaging/macos/build.sh NEW_ABSOLUTE_OUTPUT_DIRECTORY' >&2
  exit 2
fi
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
output=$1
mkdir -p "$output/evidence"
cd "$root"
switch=${WORKGRAPH_OPAM_SWITCH:-default}
test "$(opam exec --switch="$switch" -- ocamlc -version)" = 5.3.0
test "$(opam exec --switch="$switch" -- dune --version)" = 3.21.1
test "$(opam exec --switch="$switch" -- ocamlformat --version)" = 0.28.1
./dev build @fmt @runtest @install > "$output/evidence/build.log" 2>&1
opam switch export --switch="$switch" "$output/evidence/toolchain.export"
opam exec --switch="$switch" -- python3 packaging/almalinux/collect_notices.py "$output/notices" > "$output/evidence/notices.log" 2>&1
# The collector is shared; describe this artifact's platform accurately.
python3 - "$output/notices/README.md" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace('supplied by AlmaLinux packages', 'supplied by macOS'))
PY
python3 packaging/macos/inspect.py _build/default/bin/main.exe "$output/evidence/native.json"
python3 tools/package.py "$output/archives" --binary "$root/_build/default/bin/main.exe" \
  --platform macos-arm64 --notices "$output/notices" --qualification "$output/evidence/native.json" > "$output/evidence/package.json"
packaging/macos/qualify.sh "$output/archives" "$output/evidence/runtime"
python3 - "$output" <<'PYQUALIFICATION'
import json
from pathlib import Path
import sys
output = Path(sys.argv[1])
record = json.loads((output / 'evidence/runtime/result.json').read_text())
record['artifacts'] = json.loads((output / 'evidence/package.json').read_text())['archives']
record['build_checks'] = ['@fmt', '@runtest', '@install']
(output / 'qualification.json').write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
PYQUALIFICATION
