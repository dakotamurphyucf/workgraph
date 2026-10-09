#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: packaging/almalinux/qualify.sh BUILD_OUTPUT_DIRECTORY' >&2
  exit 2
fi
# A linux/amd64 container on ARM through emulation does not qualify native AMD64.
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]
[ "$(docker info --format '{{.OSType}}/{{.Architecture}}')" = linux/x86_64 ]
project=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
output=$(realpath "$1")
test -f "$output/build-metadata.json"
test ! -e "$output/runtime"
mkdir "$output/runtime"
image="workgraph-alma-runtime-$(id -u)"
docker build --platform linux/amd64 -f "$project/packaging/almalinux/Containerfile.runtime" \
  --build-arg "BUILDER_UID=$(id -u)" --build-arg "BUILDER_GID=$(id -g)" \
  -t "$image" "$project"
for kind in tar rpm; do
  mkdir "$output/runtime/$kind"
  docker run --rm --platform linux/amd64 \
    -v "$output:/artifacts:ro" -v "$output/runtime/$kind:/evidence" \
    "$image" /usr/local/bin/workgraph-runtime-smoke "$kind" /evidence
done
python3 - "$output" <<'PY'
import json
from pathlib import Path
import sys

out = Path(sys.argv[1])
metadata = json.loads((out / 'build-metadata.json').read_text())
runtime = {kind: json.loads((out / 'runtime' / kind / 'result.json').read_text()) for kind in ['tar', 'rpm']}
assert all(item['status'] == 'passed' for item in runtime.values()), runtime
assert ((out / 'runtime/tar/executable.sha256').read_text().split()[0]
        == (out / 'runtime/rpm/executable.sha256').read_text().split()[0]), 'RPM changed executable bytes'
metadata['status'] = 'passed'
metadata['runtime_checks'] = runtime
metadata['executable_sha256'] = (out / 'runtime/tar/executable.sha256').read_text().split()[0]
(out / 'qualification.json').write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
print(json.dumps({'status': 'passed', 'qualification': str(out / 'qualification.json')}))
PY
