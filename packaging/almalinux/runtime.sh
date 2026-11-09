#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Usage: workgraph-runtime-smoke tar|rpm EVIDENCE_DIRECTORY' >&2
  exit 2
fi
kind=$1
evidence=$2
mkdir -p "$evidence"
[ "$(uname -m)" = x86_64 ]
(cd /artifacts/archives && sha256sum -c SHA256SUMS) > "$evidence/archive-checksums.txt"
shopt -s nullglob
sources=(/artifacts/archives/workgraph-*-source.tar.gz)
[ "${#sources[@]}" -eq 1 ]
source_archive=${sources[0]}
version=$(python3 - "$source_archive" <<'PYVERSION'
import sys
sys.path.insert(0, '/opt')
from verify import read_archive
print(read_archive(sys.argv[1]).manifest['version'])
PYVERSION
)
native_archive="/artifacts/archives/workgraph-$version-almalinux-10-x86_64.tar.gz"
python3 /opt/verify.py "$native_archive" "$source_archive" > "$evidence/archive-manifest.json"
cat /etc/os-release > "$evidence/os-release.txt"
uname -a > "$evidence/uname.txt"
rpm -qa --queryformat '%{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' | sort > "$evidence/runtime-rpms-before.txt"
for tool in opam ocamlc ocamlopt dune gcc cc node npm; do
  if command -v "$tool"; then
    echo "Compiler/build tool present in clean runtime: $tool" >&2
    exit 1
  fi
done

case "$kind" in
  tar)
    mkdir /home/workgraph/installation
    python3 /opt/verify.py "$native_archive" "$source_archive" \
      --extract /home/workgraph/installation > "$evidence/installed-manifest.json"
    installation="/home/workgraph/installation/workgraph-$version-almalinux-10-x86_64"
    executable=$installation/bin/workgraph
    chown -R workgraph:workgraph "$installation"
    ;;
  rpm)
    (cd /artifacts/rpm && sha256sum -c SHA256SUMS) > "$evidence/rpm-checksums.txt"
    dnf -y install /artifacts/rpm/workgraph-"$version"-*.x86_64.rpm > "$evidence/rpm-install.log" 2>&1
    rpm -V workgraph > "$evidence/rpm-verify.txt"
    installation=/usr/share/doc/workgraph
    executable=/usr/bin/workgraph
    python3 /opt/verify.py "$native_archive" "$source_archive" \
      --installation / --rpm > "$evidence/installed-manifest.json"
    ;;
  *) echo 'Expected tar or rpm' >&2; exit 2 ;;
esac
python3 "$installation/tools/check_skill.py" "$installation" \
  --binary "$executable" > "$evidence/skill.json"
python3 "$installation/tools/generate_api_reference.py" \
  --binary "$executable" --output "$installation/skills/workgraph/references/api" \
  --check > "$evidence/api-reference.json"
python3 - "$installation" "$evidence" "$source_archive" "$version" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
import tarfile

installation, evidence, source_path = map(Path, sys.argv[1:4])
version = sys.argv[4]
report = json.loads((evidence / 'skill.json').read_text())
with tarfile.open(source_path) as source:
    for name, digest in report['files'].items():
        content = (installation / name).read_bytes()
        assert content == source.extractfile('workgraph-' + version + '/' + name).read()
        assert hashlib.sha256(content).hexdigest() == digest
report['matches_source_archive'] = True
(evidence / 'skill.json').write_text(json.dumps(report, indent=2) + '\n')
PY
ldd "$executable" > "$evidence/linked-libraries.txt"
sha256sum "$executable" > "$evidence/executable.sha256"
if grep -q 'not found' "$evidence/linked-libraries.txt"; then
  echo 'Unresolved runtime shared library' >&2
  exit 1
fi
rpm -qa --queryformat '%{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' | sort > "$evidence/runtime-rpms-after.txt"
chown -R workgraph:workgraph "$evidence"

# Minimal environment; no switch PATH, compiler, opam or developer checkout.
runuser -u workgraph -- env -i HOME=/home/workgraph PATH=/usr/bin:/bin \
  python3 "$installation/tools/installed_smoke.py" "$executable" "$evidence/installed" \
  > "$evidence/installed-smoke.json"
runuser -u workgraph -- env -i HOME=/home/workgraph PATH=/usr/bin:/bin \
  python3 "$installation/skills/workgraph/scripts/history-recovery-demo.py" "$executable" \
  --directory "$evidence/history" > "$evidence/history-smoke.json"
ui_archive="/artifacts/archives/workgraph-ui-$version-almalinux-10-x86_64.tar.gz"
if [ -f "$ui_archive" ]; then
  case "$kind" in
    tar)
      mkdir /home/workgraph/ui-installation
      python3 /opt/verify.py "$ui_archive" "$source_archive" --extract /home/workgraph/ui-installation \
        > "$evidence/ui-installed-manifest.json"
      ui_installation="/home/workgraph/ui-installation/workgraph-ui-$version-almalinux-10-x86_64"
      companion="$ui_installation/bin/workgraph-ui"
      ui_core="$ui_installation/bin/workgraph"
      chown -R workgraph:workgraph /home/workgraph/ui-installation
      ;;
    rpm)
      dnf -y install /artifacts/rpm/workgraph-ui-"$version"-*.x86_64.rpm > "$evidence/ui-rpm-install.log" 2>&1
      rpm -V workgraph-ui > "$evidence/ui-rpm-verify.txt"
      rpm -q --requires workgraph-ui > "$evidence/ui-rpm-requires.txt"
      python3 /opt/verify.py "$ui_archive" "$source_archive" --installation / --rpm \
        > "$evidence/ui-installed-manifest.json"
      ui_installation=/usr/share/doc/workgraph-ui
      companion=/usr/bin/workgraph-ui
      ui_core=/usr/bin/workgraph
      ;;
  esac
  runuser -u workgraph -- env -i HOME=/home/workgraph PATH=/usr/bin:/bin \
    python3 "$ui_installation/packaging/ui_smoke.py" "$ui_installation" "$evidence/ui-runtime" \
    --companion "$companion" --core "$ui_core" > "$evidence/ui-smoke.json"
  if [ "$kind" = rpm ]; then
    # Removal owns only the UI package. Preserve exact dependency and user data.
    mkdir /home/workgraph/package-preservation
    printf 'owned user-state sentinel\n' > /home/workgraph/package-preservation/sentinel
    sha256sum /usr/bin/workgraph /home/workgraph/package-preservation/sentinel > "$evidence/ui-remove-before.sha256"
    dnf -y --setopt=clean_requirements_on_remove=False remove workgraph-ui > "$evidence/ui-rpm-remove.log" 2>&1
    sha256sum -c "$evidence/ui-remove-before.sha256" > "$evidence/ui-remove-preserved.txt"
    test ! -e /usr/bin/workgraph-ui
    rpm -V workgraph > "$evidence/core-after-ui-remove.txt"
  fi
fi
python3 - "$evidence" "$kind" <<'PYRESULT'
import json, sys
from pathlib import Path
evidence = Path(sys.argv[1])
result = {'status': 'passed', 'kind': sys.argv[2], 'checks': ['no-toolchain', 'portable-agent-skill',
    'installed-cli-git-export-restore', 'history-adapter-retry-search-payload']}
ui = evidence / 'ui-runtime/result.json'
if ui.is_file():
    result['optional_ui'] = {'result_path': 'ui-runtime/result.json', 'result': json.loads(ui.read_bytes())}
    assert result['optional_ui']['result']['status'] == 'passed'
(evidence / 'result.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
PYRESULT
