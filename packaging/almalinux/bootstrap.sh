#!/usr/bin/env bash
set -euo pipefail

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
opam install --yes --deps-only --with-test ./workgraph.opam dune.3.21.1
test "$(opam exec -- ocamlc -version)" = 5.3.0
test "$(opam exec -- dune --version)" = 3.21.1
test "$(opam exec -- ocamlformat --version)" = 0.28.1
