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
python3 /opt/workgraph-verify.py \
  /artifacts/archives/workgraph-0.1.0-almalinux-10-x86_64.tar.gz \
  /artifacts/archives/workgraph-0.1.0-source.tar.gz > "$evidence/archive-manifest.json"
cat /etc/os-release > "$evidence/os-release.txt"
uname -a > "$evidence/uname.txt"
rpm -qa --queryformat '%{NAME} %{VERSION}-%{RELEASE} %{ARCH}\n' | sort > "$evidence/runtime-rpms-before.txt"
for tool in opam ocamlc ocamlopt dune gcc cc; do
  if command -v "$tool"; then
    echo "Compiler/build tool present in clean runtime: $tool" >&2
    exit 1
  fi
done

case "$kind" in
  tar)
    mkdir /home/workgraph/installation
    python3 /opt/workgraph-verify.py \
      /artifacts/archives/workgraph-0.1.0-almalinux-10-x86_64.tar.gz \
      /artifacts/archives/workgraph-0.1.0-source.tar.gz \
      --extract /home/workgraph/installation > "$evidence/installed-manifest.json"
    installation=/home/workgraph/installation/workgraph-0.1.0-almalinux-10-x86_64
    executable=$installation/bin/workgraph
    chown -R workgraph:workgraph "$installation"
    ;;
  rpm)
    (cd /artifacts/rpm && sha256sum -c SHA256SUMS) > "$evidence/rpm-checksums.txt"
    dnf -y install /artifacts/rpm/workgraph-0.1.0-*.x86_64.rpm > "$evidence/rpm-install.log" 2>&1
    rpm -V workgraph > "$evidence/rpm-verify.txt"
    installation=/usr/share/doc/workgraph
    executable=/usr/bin/workgraph
    python3 /opt/workgraph-verify.py \
      /artifacts/archives/workgraph-0.1.0-almalinux-10-x86_64.tar.gz \
      /artifacts/archives/workgraph-0.1.0-source.tar.gz \
      --installation / --rpm > "$evidence/installed-manifest.json"
    ;;
  *) echo 'Expected tar or rpm' >&2; exit 2 ;;
esac
python3 "$installation/tools/check_agent_guide.py" "$installation" \
  --binary "$executable" > "$evidence/agent-guide.json"
python3 "$installation/tools/generate_api_reference.py" \
  --binary "$executable" --output "$installation/docs/api-reference" \
  --check > "$evidence/api-reference.json"
python3 - "$installation" "$evidence" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
import tarfile

installation, evidence = map(Path, sys.argv[1:])
report = json.loads((evidence / 'agent-guide.json').read_text())
with tarfile.open('/artifacts/archives/workgraph-0.1.0-source.tar.gz') as source:
    for name, digest in report['files'].items():
        content = (installation / name).read_bytes()
        assert content == source.extractfile('workgraph-0.1.0/' + name).read()
        assert hashlib.sha256(content).hexdigest() == digest
report['matches_source_archive'] = True
(evidence / 'agent-guide.json').write_text(json.dumps(report, indent=2) + '\n')
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
  python3 "$installation/examples/history-recovery-demo.py" "$executable" \
  --directory "$evidence/history" > "$evidence/history-smoke.json"
printf '{"status":"passed","kind":"%s","checks":["no-toolchain","agent-guide-and-references","installed-cli-git-export-restore","history-adapter-retry-search-payload"]}\n' \
  "$kind" > "$evidence/result.json"
