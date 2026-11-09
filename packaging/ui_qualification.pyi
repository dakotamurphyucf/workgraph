"""Bounded installed-package lifecycle qualification, never an installer daemon.

Validates source/core/UI archives with existing verifiers, extracts only into a
fresh caller-owned evidence directory and short owned temporary roots. Services
receive a minimal environment without Node/opam/compiler overrides. Node and
Playwright belong only to the external graphical qualification driver.

The owned data root is outside installation. Verify first launch, exact UI
write/readback, stop/restart, same-version reinstall, and removal preserving all
stopped data and an independent core prefix. No cross-release migration, clean
machine, Gatekeeper, Linux/WSL or browser universality claim is inferred.

All processes are terminated and reaped on success/failure. Failed evidence is
retained; only owned temporary roots are removed. Cancellation is not a domain
success. No global package manager, shell profile or existing daemon is changed.
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

@dataclass(frozen=True)
class QualificationInputs:
    source_archive: Path
    core_archive: Path
    ui_archive: Path
    evidence: Path
    node: Path
    playwright_module: Path
    browser: Path

# Hash regular files by relative path; reject links and unexpected special files.
# An explicitly allowed owned Unix socket is recorded separately, never copied.
def data_inventory(root: Path, *, allow_owned_socket: bool = False) -> Mapping[str, str]: ...

# Assert root is a known owned installation, remove only that prefix, and prove
# the external stopped data and independent core installation are unchanged.
def remove_owned_installation(installation: Path, *, data: Path,
                              independent_core: Path) -> Mapping[str, object]: ...

def qualify(inputs: QualificationInputs) -> Mapping[str, object]: ...
