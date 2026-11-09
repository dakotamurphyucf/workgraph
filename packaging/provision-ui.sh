#!/usr/bin/env bash
set -euo pipefail
# Explicit optional path only: no caller/default OPAMROOT or global Node writes.
if [ "$#" -ne 2 ] || [[ "$1" != /* ]] || [ -e "$1" ]; then
  echo 'Usage: packaging/provision-ui.sh NEW_ABSOLUTE_ROOT macos-arm64|almalinux-10-x86_64' >&2
  exit 2
fi
owned_root=$1
target=$2
case "$target:$(uname -s):$(uname -m)" in
  macos-arm64:Darwin:arm64|almalinux-10-x86_64:Linux:x86_64) ;;
  *) echo 'Provision only on the named native platform' >&2; exit 2 ;;
esac
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source "$project/packaging/clean-ocaml-env.sh"
mkdir -m 700 "$owned_root"
export OPAMROOT="$owned_root/opam"
export OPAMSWITCH=workgraph-ui
export WORKGRAPH_OPAM_SWITCH=workgraph-ui
repository_commit=e4cd7ede2d55a46570977c0ffaa7e96845190817
git init -q "$owned_root/repository"
git -C "$owned_root/repository" remote add origin https://github.com/ocaml/opam-repository.git
git -C "$owned_root/repository" fetch --depth=1 origin "$repository_commit"
git -C "$owned_root/repository" checkout --detach FETCH_HEAD
test "$(git -C "$owned_root/repository" rev-parse HEAD)" = "$repository_commit"
node_root=$(python3 "$project/packaging/ui_inputs.py" "node-$target" "$owned_root/node")
cohttp_root=$(python3 "$project/packaging/ui_inputs.py" cohttp "$owned_root/cohttp")
export PATH="$node_root/bin:$PATH"
test "$(node --version)" = v22.14.0
test "$(npm --version)" = 10.9.2
# Sandbox changes, if required by a disposable container, belong to that image's
# own opam initialization; this native macOS path never changes host defaults.
opam init --bare --no-setup --yes workgraph-snapshot "$owned_root/repository"
opam switch create "$OPAMSWITCH" ocaml-base-compiler.5.3.0 --yes
opam pin add --yes --no-action dune 3.21.1
opam install --yes dune.3.21.1
for package in http cohttp cohttp-eio; do
  opam pin add --yes --no-action "$package.6.3.0" "$cohttp_root"
done
opam install --yes --deps-only --with-test "$project/workgraph.opam" "$project/workgraph-ui.opam"
test "$(opam exec -- ocamlc -version)" = 5.3.0
test "$(opam exec -- dune --version)" = 3.21.1
test "$(opam exec -- ocamlformat --version)" = 0.28.1
# Path pins cannot be exported with --freeze. Their reproducibility is bound by
# the separately retained verified upstream archive/member hashes, not a VCS ref.
opam switch export --full "$owned_root/toolchain.export"
python3 - "$owned_root" "$node_root" "$repository_commit" "$project/packaging/clean-ocaml-env.sh" "$(opam var prefix)" <<'PY'
from pathlib import Path
import json, shlex, sys
root, node = map(Path, sys.argv[1:3])
values = {'OPAMROOT': str(root / 'opam'), 'OPAMSWITCH': 'workgraph-ui', 'WORKGRAPH_OPAM_SWITCH': 'workgraph-ui',
          'OPAM_SWITCH_PREFIX': sys.argv[5]}
environment = ''.join('export ' + name + '=' + shlex.quote(value) + '\n' for name, value in values.items())
cleanup = Path(sys.argv[4]).read_text()
environment = cleanup + environment
environment += 'export PATH=' + shlex.quote(sys.argv[5] + '/bin') + ':' + shlex.quote(str(node / 'bin')) + ':"$PATH"\n'
(root / 'environment.sh').write_text(environment)
(root / 'provision.json').write_text(json.dumps({'schema': 1, 'opam_repository_commit': sys.argv[3], 'environment': values,
    'node_upstream': 'node/upstream.json', 'cohttp_upstream': 'cohttp/upstream.json', 'switch_export': 'toolchain.export',
    'switch_export_mode': 'full; local path pins bound by verified upstream archive/member hashes'}, indent=2) + '\n')
PY
printf 'Provisioned isolated optional UI inputs. Source %s/environment.sh before the optional build.\n' "$owned_root"
