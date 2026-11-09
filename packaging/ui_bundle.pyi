"""Optional UI archive data contract. Inspection and runtime qualification are distinct."""
from dataclasses import dataclass
from typing import Mapping, Protocol, TypeAlias

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
ArchiveFiles: TypeAlias = Mapping[str, tuple[bytes, int]]

class BundleView(Protocol):
    root: str
    manifest: dict[str, JsonValue]
    files: dict[str, bytes]
    modes: dict[str, int]

@dataclass(frozen=True)
class UiAsset:
    path: str
    content_type: str
    sha256: str
    size_bytes: int

@dataclass(frozen=True)
class UiManifest:
    package_version: str
    input_sha256: str
    lock_sha256: str
    assets: tuple[UiAsset, ...]
    raw: bytes

@dataclass(frozen=True)
class UiInputs:
    binary: bytes
    manifest: bytes
    notices: bytes

# Validate complete current generated manifest, exact source input/lock/version
# and notices bytes; no process or network I/O and no inferred runtime PASS.
def validate_assets(
    inputs: UiInputs, *, source: Mapping[str, bytes], version: str
) -> UiManifest: ...

# Produce immutable archive additions after validation; caller retains paired core,
# offline source files, complete native notices and deterministic archive ownership.
def ui_files(
    inputs: UiInputs, *, source: Mapping[str, bytes], version: str,
    source_identity: str, core_binary: bytes, inspection: dict[str, JsonValue]
) -> ArchiveFiles: ...

# Validate full UI-native archive/source agreement and all provenance/member hashes
# before extraction. Authenticates consistency only, not publisher or runtime safety.
def verify_ui_pair(source: BundleView, native: BundleView) -> dict[str, JsonValue]: ...
