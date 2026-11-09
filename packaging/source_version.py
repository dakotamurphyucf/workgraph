#!/usr/bin/env python3
"""Read the single release version and reject stale generated package metadata."""
from pathlib import Path
import re
import sys


def source_version(root: Path) -> str:
    matches = re.findall(r"^\(version ([0-9]+(?:\.[0-9]+)+)\)$", (root / "dune-project").read_text(), re.M)
    if len(matches) != 1:
        raise ValueError("Expected one dune-project release version")
    version = matches[0]
    if (root / "lib/version.ml").read_text().strip() != f'let value = "{version}"':
        raise ValueError("CLI and package versions disagree")
    for name in ("workgraph.opam", "workgraph-ui.opam"):
        if (root / name).exists() and re.findall(r'^version: "([^"]+)"$', (root / name).read_text(), re.M) != [version]:
            raise ValueError("Generated package version disagrees: " + name)
    return version


if __name__ == "__main__":
    print(source_version(Path(sys.argv[1]) if len(sys.argv) == 2 else Path(__file__).resolve().parents[1]))
