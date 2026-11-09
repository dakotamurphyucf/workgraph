"""Installed UI qualification driver; never opens a browser or user daemon.

Checks both installed executable versions, readiness asset-manifest hash, every
served asset byte/type (bootstrap capability normalized), launch-bound API and
attachment to an owned fresh paired daemon. Uses a minimal environment and owns
all process/root cleanup even on partial startup failure. Evidence directory is
fresh and retains logs/results; no browser capability or mutable state is packaged.
"""
from pathlib import Path
from typing import BinaryIO
def read_ready(stream: BinaryIO, destination: Path, *, timeout_seconds: float = 15) -> bytes: ...
def qualify(installation: Path, evidence: Path, *, core: Path | None = None,
            companion: Path | None = None) -> dict: ...
