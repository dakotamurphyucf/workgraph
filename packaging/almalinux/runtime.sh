#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Usage: workgraph-runtime-smoke tar|rpm EVIDENCE_DIRECTORY' >&2
  exit 2
fi
kind=$1
evidence=$2
mkdir -p "$evidence"
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
    tar -xzf /artifacts/archives/workgraph-0.1.0-almalinux-10-x86_64.tar.gz -C /home/workgraph
    installation=/home/workgraph/workgraph-0.1.0-almalinux-10-x86_64
    executable=$installation/bin/workgraph
    chown -R workgraph:workgraph "$installation"
    ;;
  rpm)
    dnf -y install /artifacts/rpm/workgraph-0.1.0-1*.x86_64.rpm > "$evidence/rpm-install.log" 2>&1
    rpm -V workgraph > "$evidence/rpm-verify.txt"
    installation=/usr/share/doc/workgraph
    executable=/usr/bin/workgraph
    ;;
  *) echo 'Expected tar or rpm' >&2; exit 2 ;;
esac
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
  python3 /opt/workgraph-installed-smoke.py "$executable" "$evidence/installed" \
  > "$evidence/installed-smoke.json"
runuser -u workgraph -- env -i HOME=/home/workgraph PATH=/usr/bin:/bin \
  python3 "$installation/examples/history-recovery-demo.py" "$executable" \
  --directory "$evidence/history" > "$evidence/history-smoke.json"
printf '{"status":"passed","kind":"%s","checks":["no-toolchain","installed-cli-git-export-restore","history-adapter-retry-search-payload"]}\n' \
  "$kind" > "$evidence/result.json"
