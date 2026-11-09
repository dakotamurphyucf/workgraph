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
sources=("$archives"/workgraph-*-source.tar.gz)
[ "${#sources[@]}" -eq 1 ]
project=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
python=$(command -v python3)
version=$("$python" - "$project/packaging" "${sources[0]}" <<'PYVERSION'
import sys
sys.path.insert(0, sys.argv[1])
from verify import read_archive
print(read_archive(sys.argv[2]).manifest['version'])
PYVERSION
)
packages=("$archives/workgraph-$version-macos-arm64.tar.gz")
test -f "${packages[0]}"
"$python" "$project/packaging/verify.py" "${packages[0]}" "${sources[0]}" \
  --extract "$evidence/installation" > "$evidence/manifest.json"
installations=("$evidence/installation"/workgraph-*-macos-arm64)
[ "${#installations[@]}" -eq 1 ]
installation=${installations[0]}
"$python" "$installation/tools/check_skill.py" "$installation" \
  --binary "$installation/bin/workgraph" > "$evidence/skill.json"
"$python" "$installation/tools/generate_api_reference.py" \
  --binary "$installation/bin/workgraph" --output "$installation/skills/workgraph/references/api" \
  --check > "$evidence/api-reference.json"
"$python" "$installation/packaging/macos/inspect.py" "$installation/bin/workgraph" "$evidence/native.json"
# Python is a qualification driver, not a runtime dependency. Executed Workgraph
# processes receive no switch PATH, OCaml variables or DYLD overrides.
env -i HOME="$evidence/home" PATH=/usr/bin:/bin TMPDIR=/tmp \
  "$python" "$installation/tools/installed_smoke.py" "$installation/bin/workgraph" "$evidence/installed" > "$evidence/installed-smoke.json"
# macOS Unix socket paths are short. Keep the helper's owned live socket under
# /tmp even when the retained qualification directory has a long checkout path.
history_work=$(mktemp -d /tmp/wg-package-history.XXXXXXXX)
trap 'rm -rf -- "$history_work"' EXIT
history_status=0
env -i HOME="$evidence/home" PATH=/usr/bin:/bin TMPDIR=/tmp \
  "$python" "$installation/skills/workgraph/scripts/history-recovery-demo.py" "$installation/bin/workgraph" \
  --directory "$history_work" > "$evidence/history-smoke.json" 2> "$evidence/history-smoke.stderr" || history_status=$?
# The helper's finally terminates and waits its daemon before returning, including
# failure. Copy its regular evidence before deleting the short owned root.
history_copy_status=0
"$python" - "$history_work" "$evidence/history" "$history_status" <<'PYHISTORY' || history_copy_status=$?
from pathlib import Path
import json, shutil, stat, sys
skipped = []
def sockets(directory, names):
    ignored = []
    for name in names:
        mode = (Path(directory) / name).lstat().st_mode
        if stat.S_ISSOCK(mode):
            ignored.append(name)
            skipped.append(str((Path(directory) / name).relative_to(sys.argv[1])))
        elif not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError('Unexpected link/special history evidence member: ' + name)
    return ignored
shutil.copytree(sys.argv[1], sys.argv[2], ignore=sockets, symlinks=True)
Path(sys.argv[2], 'qualification-relocation.json').write_text(json.dumps({
    'original_directory': sys.argv[1], 'retained_directory': sys.argv[2],
    'helper_exit_status': int(sys.argv[3]), 'skipped_owned_sockets': skipped,
    'copy_policy': 'Only regular files and directories; links and other special files rejected',
}, indent=2, sort_keys=True) + '\n')
PYHISTORY
rm -rf -- "$history_work"
trap - EXIT
if [ "$history_status" -ne 0 ]; then exit "$history_status"; fi
if [ "$history_copy_status" -ne 0 ]; then exit "$history_copy_status"; fi
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
    'checks': ['complete-manifests-source-notices', 'portable-agent-skill',
               'installed-cli-git-export-restore', 'history-adapter-retry-search-payload'],
})
(evidence / 'result.json').write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
PYRESULT
ui_archive="$archives/workgraph-ui-$version-macos-arm64.tar.gz"
if [ -f "$ui_archive" ]; then
  mkdir "$evidence/ui-installation"
  "$python" "$project/packaging/verify.py" "$ui_archive" "${sources[0]}" \
    --extract "$evidence/ui-installation" > "$evidence/ui-manifest.json"
  ui_installation="$evidence/ui-installation/workgraph-ui-$version-macos-arm64"
  "$python" "$project/packaging/macos/inspect.py" "$ui_installation/bin/workgraph-ui" "$evidence/ui-native.json" bin/workgraph-ui
  env -i HOME="$evidence/home" PATH=/usr/bin:/bin TMPDIR=/tmp \
    "$python" "$ui_installation/packaging/ui_smoke.py" "$ui_installation" "$evidence/ui-runtime" \
    > "$evidence/ui-smoke.json"
fi
