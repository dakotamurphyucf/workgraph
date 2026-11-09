#!/usr/bin/env bash
set -euo pipefail
source /opt/clean-ocaml-env.sh

# A fixed opam repository tree pins the complete dependency selection and source
# checksums. Exported switch metadata in each build records the resolved closure.
repository_commit=e4cd7ede2d55a46570977c0ffaa7e96845190817
repository=/home/workgraph/opam-repository
git init -q "$repository"
git -C "$repository" remote add origin https://github.com/ocaml/opam-repository.git
git -C "$repository" fetch --depth=1 origin "$repository_commit"
git -C "$repository" checkout --detach FETCH_HEAD
test "$(git -C "$repository" rev-parse HEAD)" = "$repository_commit"

# Bubblewrap needs namespace privileges not granted to ordinary Docker builds.
# Only this disposable container-owned opam root disables its nested sandbox.
opam init --yes --bare --no-setup --disable-sandboxing workgraph-snapshot "$repository"
opam switch create workgraph ocaml-base-compiler.5.3.0 --yes
cd /opt/workgraph-deps
# Dune is a build tool to install, not a root to exclude with --deps-only.
opam pin add --yes --no-action dune 3.21.1
opam install --yes dune.3.21.1
opam install --yes --deps-only --with-test ./workgraph.opam
case "${WORKGRAPH_PACKAGE_UI:-false}" in
  false) ;;
  true)
    mkdir -m 700 "$WORKGRAPH_UI_INPUTS"
    node_root=$(python3 /opt/ui_inputs.py node-almalinux-10-x86_64 "$WORKGRAPH_UI_INPUTS/node")
    cohttp_root=$(python3 /opt/ui_inputs.py cohttp "$WORKGRAPH_UI_INPUTS/cohttp")
    export PATH="$node_root/bin:$PATH"
    test "$(node --version)" = v22.14.0
    test "$(npm --version)" = 10.9.2
    for package in http cohttp cohttp-eio; do
      opam pin add --yes --no-action "$package.6.3.0" "$cohttp_root"
    done
    opam install --yes --deps-only --with-test ./workgraph.opam ./workgraph-ui.opam
    python3 - "$WORKGRAPH_UI_INPUTS/provision.json" "$repository_commit" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({'schema': 1, 'opam_repository_commit': sys.argv[2],
    'node_upstream': 'node/upstream.json', 'cohttp_upstream': 'cohttp/upstream.json'}, indent=2) + '\n')
PY
    ;;
  *) echo 'WORKGRAPH_PACKAGE_UI must be true or false' >&2; exit 2 ;;
esac
test "$(opam exec -- ocamlc -version)" = 5.3.0
test "$(opam exec -- dune --version)" = 3.21.1
test "$(opam exec -- ocamlformat --version)" = 0.28.1
