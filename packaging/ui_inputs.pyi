"""Fixed checksum-pinned optional build inputs. No package-manager mutation."""
from pathlib import Path
def fetch(kind: str, destination: Path) -> Path: ...
# Fresh owned directory only. Download is HTTPS/bounded, checksum checked before
# extraction. Reject traversal/special files and links escaping the one root.
# Retain upstream archive + source-member/license hashes for build provenance.
