#!/bin/sh
# Foreground supervisor entrypoint. Edit these variables or set them in your shell.
set -eu
: "${WORKGRAPH_EXE:=workgraph}"
: "${WORKGRAPH_RUNTIME:=${XDG_RUNTIME_DIR:-$HOME/.cache}/workgraph}"
: "${WORKGRAPH_REGISTRY:=${XDG_DATA_HOME:-$HOME/.local/share}/workgraph/registry}"
umask 077
mkdir -p "$WORKGRAPH_RUNTIME" "$(dirname -- "$WORKGRAPH_REGISTRY")"
exec "$WORKGRAPH_EXE" serve "$WORKGRAPH_REGISTRY" "$WORKGRAPH_RUNTIME/workgraph.sock"
