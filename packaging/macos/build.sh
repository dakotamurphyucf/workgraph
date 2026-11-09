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
source "$root/packaging/clean-ocaml-env.sh"
switch=${WORKGRAPH_OPAM_SWITCH:-default}
optional_ui=${WORKGRAPH_PACKAGE_UI:-false}
case "$optional_ui" in true|false) ;; *) echo 'WORKGRAPH_PACKAGE_UI must be true or false' >&2; exit 2 ;; esac
notice_options=()
ui_options=()
if [ "$optional_ui" = true ]; then
  test -n "${WORKGRAPH_UI_INPUTS:-}"
  test "$switch" = workgraph-ui
  test "${OPAMROOT:-}" = "$WORKGRAPH_UI_INPUTS/opam"
  test "$(opam var prefix --switch="$switch")" = "$WORKGRAPH_UI_INPUTS/opam/$switch"
  test "$(node --version)" = v22.14.0
  test "$(npm --version)" = 10.9.2
  notice_options=(--ui --cohttp-source "$WORKGRAPH_UI_INPUTS/cohttp")
fi
test "$(opam exec --switch="$switch" -- ocamlc -version)" = 5.3.0
test "$(opam exec --switch="$switch" -- dune --version)" = 3.21.1
test "$(opam exec --switch="$switch" -- ocamlformat --version)" = 0.28.1
./dev build @fmt @runtest @install > "$output/evidence/build.log" 2>&1
if [ "$optional_ui" = true ]; then
  ./dev-ui install > "$output/evidence/ui-install.log" 2>&1
  ./dev-ui frontend > "$output/evidence/ui-frontend.log" 2>&1
  ./dev-ui native > "$output/evidence/ui-native-build.log" 2>&1
  WORKGRAPH_UI_BUILD=true ./dev build @fmt @runtest @install > "$output/evidence/ui-enabled-gate.log" 2>&1
  python3 packaging/macos/inspect.py _build/default/ui/companion/bin/main.exe "$output/evidence/ui-native.json" bin/workgraph-ui
  ui_options=(--ui-binary "$root/_build/default/ui/companion/bin/main.exe"
              --ui-manifest "$root/ui/tools/embedded/manifest.json"
              --ui-notices "$root/ui/tools/embedded/frontend-notices.txt"
              --ui-qualification "$output/evidence/ui-native.json")
  cp "$WORKGRAPH_UI_INPUTS/provision.json" "$WORKGRAPH_UI_INPUTS/cohttp/upstream.json" "$output/evidence/"
fi
if [ "$optional_ui" = true ]; then
  opam switch export --switch="$switch" --full "$output/evidence/toolchain.export"
else
  opam switch export --switch="$switch" "$output/evidence/toolchain.export"
fi
opam exec --switch="$switch" -- python3 packaging/almalinux/collect_notices.py "$output/notices" ${notice_options[@]+"${notice_options[@]}"} > "$output/evidence/notices.log" 2>&1
# The collector is shared; describe this artifact's platform accurately.
python3 - "$output/notices/README.md" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace('supplied by AlmaLinux packages', 'supplied by macOS'))
PY
python3 packaging/macos/inspect.py _build/default/bin/main.exe "$output/evidence/native.json"
python3 tools/package.py "$output/archives" --binary "$root/_build/default/bin/main.exe" \
  --platform macos-arm64 --notices "$output/notices" --qualification "$output/evidence/native.json" \
  ${ui_options[@]+"${ui_options[@]}"} > "$output/evidence/package.json"
packaging/macos/qualify.sh "$output/archives" "$output/evidence/runtime"
python3 - "$output" <<'PYQUALIFICATION'
import json
from pathlib import Path
import sys
output = Path(sys.argv[1])
record = json.loads((output / 'evidence/runtime/result.json').read_text())
record['artifacts'] = json.loads((output / 'evidence/package.json').read_text())['archives']
record['build_checks'] = ['@fmt', '@runtest', '@install']
ui = output / 'evidence/runtime/ui-runtime/result.json'
if ui.is_file():
    record['optional_ui'] = json.loads(ui.read_text())
(output / 'qualification.json').write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
PYQUALIFICATION
