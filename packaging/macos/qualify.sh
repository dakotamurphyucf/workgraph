#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ] || [[ "$2" != /* ]] || [ -e "$2" ]; then
  echo 'Usage: packaging/macos/qualify.sh ARCHIVE_DIRECTORY NEW_ABSOLUTE_EVIDENCE_DIRECTORY' >&2
  exit 2
fi
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]
archives=$(CDPATH= cd -- "$1" && pwd)
evidence=$2
mkdir -p "$evidence/installation" "$evidence/home"
(cd "$archives" && shasum -a 256 -c SHA256SUMS) > "$evidence/checksums.txt"
shopt -s nullglob
packages=("$archives"/workgraph-*-macos-arm64.tar.gz)
[ "${#packages[@]}" -eq 1 ]
sources=("$archives"/workgraph-*-source.tar.gz)
[ "${#sources[@]}" -eq 1 ]
project=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
python=$(command -v python3)
"$python" "$project/packaging/verify.py" "${packages[0]}" "${sources[0]}" \
  --extract "$evidence/installation" > "$evidence/manifest.json"
installations=("$evidence/installation"/workgraph-*-macos-arm64)
[ "${#installations[@]}" -eq 1 ]
installation=${installations[0]}
"$python" "$installation/tools/check_agent_guide.py" "$installation" \
  --binary "$installation/bin/workgraph" > "$evidence/agent-guide.json"
"$python" "$installation/tools/generate_api_reference.py" \
  --binary "$installation/bin/workgraph" --output "$installation/docs/api-reference" \
  --check > "$evidence/api-reference.json"
"$python" "$installation/packaging/macos/inspect.py" "$installation/bin/workgraph" "$evidence/native.json"
# Python is a qualification driver, not a runtime dependency. Executed Workgraph
# processes receive no switch PATH, OCaml variables or DYLD overrides.
env -i HOME="$evidence/home" PATH=/usr/bin:/bin TMPDIR=/tmp \
  "$python" "$installation/tools/installed_smoke.py" "$installation/bin/workgraph" "$evidence/installed" > "$evidence/installed-smoke.json"
env -i HOME="$evidence/home" PATH=/usr/bin:/bin TMPDIR=/tmp \
  "$python" "$installation/examples/history-recovery-demo.py" "$installation/bin/workgraph" \
  --directory "$evidence/history" > "$evidence/history-smoke.json"
/usr/bin/sw_vers > "$evidence/os-version.txt"
"$python" - "$evidence" <<'PYRESULT'
import json
from pathlib import Path
import sys
evidence = Path(sys.argv[1])
record = json.loads((evidence / 'manifest.json').read_text())
record.update({
    'target': 'macos-arm64',
    'native_inspection': json.loads((evidence / 'native.json').read_text()),
    'isolation': 'env -i; PATH=/usr/bin:/bin; no opam or DYLD paths; host toolchain remains installed',
    'signing': 'No Developer ID signing or notarization; downloaded Gatekeeper launch not tested',
    'checks': ['complete-manifests-source-notices', 'agent-guide-and-references',
               'installed-cli-git-export-restore', 'history-adapter-retry-search-payload'],
})
(evidence / 'result.json').write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
PYRESULT
