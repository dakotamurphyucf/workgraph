"""Pure optional UI bundle consistency checks; no runtime PASS is inferred."""
from dataclasses import dataclass
import json
import posixpath
import re

from verify import DIGEST, NATIVE_SOURCE_FILES, decode, encode, safe_name, sha, validate_notices

UI_SOURCE_FILES = frozenset({"packaging/ui_bundle.py", "packaging/ui_bundle.pyi",
                             "packaging/ui_smoke.py", "ui/frontend/package-lock.json"})
MANIFEST_KEYS = {"schema_version", "package_version", "input_sha256", "lock_sha256",
                 "generator_runtime", "required_toolchain", "runtime_dependencies", "assets"}
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
        ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
        ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".ico": "image/x-icon"}


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


def frontend_input_hash(source):
    fixed = {"ui/frontend/" + name for name in
             ("package.json", "package-lock.json", "index.html", "tsconfig.json", "vite.config.ts")}
    names = fixed | {name for name in source
                     if name.startswith(("ui/frontend/src/", "ui/frontend/public/", "ui/tools/"))
                     and not name.startswith("ui/tools/embedded/")}
    records = [{"path": name, "sha256": sha(source[name])}
               for name in sorted(names, key=lambda value: value.encode("utf-16-be"))]
    # Match frontend-inputs.mjs's JSON.stringify (UTF-8, no whitespace).
    return sha(json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode())


def runtime_dependencies(package, lock):
    pending = [(name, "") for name in package.get("dependencies", {})] + [("vite", "")]
    found = {}
    while pending:
        name, parent = pending.pop()
        current = parent
        while True:
            key = (current + "/" if current else "") + "node_modules/" + name
            entry = lock["packages"].get(key)
            if entry is not None:
                break
            if not current:
                raise ValueError("Missing locked UI runtime dependency: " + name)
            current = posixpath.dirname(current)
        identity = (name, entry["version"])
        if identity in found:
            continue
        found[identity] = {"name": name, "version": entry["version"], "license": entry["license"]}
        if name != "vite":
            pending.extend((dependency, key) for dependency in entry.get("dependencies", {}))
    return sorted(found.values(), key=lambda item: (item["name"], item["version"]))


def validate_assets(inputs, *, source, version):
    required = {"ui/frontend/" + name for name in
                ("package.json", "package-lock.json", "index.html", "tsconfig.json", "vite.config.ts")}
    if not (required | {"ui/tools/toolchain.json"}).issubset(source):
        raise ValueError("UI source package lacks required frontend/lock/toolchain inputs")
    manifest = decode(inputs.manifest)
    if not isinstance(manifest, dict) or set(manifest) != MANIFEST_KEYS \
            or type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1 \
            or manifest["package_version"] != version:
        raise ValueError("Invalid UI asset manifest/version")
    package = decode(source["ui/frontend/package.json"])
    lock = decode(source["ui/frontend/package-lock.json"])
    if package["version"] != version or lock["version"] != version \
            or lock["packages"][""]["version"] != version:
        raise ValueError("UI source/lock/package version mismatch")
    if manifest["lock_sha256"] != sha(source["ui/frontend/package-lock.json"]):
        raise ValueError("UI lock hash mismatch")
    if manifest["input_sha256"] != frontend_input_hash(source):
        raise ValueError("Stale UI frontend input hash; rebuild assets from packaged source")
    toolchain = decode(source["ui/tools/toolchain.json"])
    if manifest["required_toolchain"] != toolchain \
            or manifest["generator_runtime"] != {"node": toolchain["node"]}:
        raise ValueError("UI generator/toolchain mismatch")
    dependencies = manifest["runtime_dependencies"]
    if dependencies != runtime_dependencies(package, lock):
        raise ValueError("UI runtime dependency inventory disagrees with complete locked closure")
    rows = manifest["assets"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 128:
        raise ValueError("Invalid UI asset count")
    assets, paths = [], set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"path", "content_type", "sha256", "size_bytes"}:
            raise ValueError("Invalid UI asset row")
        path = row["path"]
        if not isinstance(path, str) or not path.startswith("/"):
            raise ValueError("Invalid UI asset path")
        safe_name(path[1:])
        suffix = "." + path.rsplit(".", 1)[-1]
        if path in paths or MIME.get(suffix) != row["content_type"]:
            raise ValueError("Duplicate or unsupported UI asset/content type")
        paths.add(path)
        if not isinstance(row["size_bytes"], str) or not re.fullmatch(r"0|[1-9][0-9]*", row["size_bytes"]):
            raise ValueError("Invalid UI asset size")
        size = int(row["size_bytes"])
        if size > 8 * 1024 * 1024 or not isinstance(row["sha256"], str) or not DIGEST.fullmatch(row["sha256"]):
            raise ValueError("UI asset exceeds bound or has invalid hash")
        assets.append(UiAsset(path, row["content_type"], row["sha256"], size))
    if sum(item.size_bytes for item in assets) > 16 * 1024 * 1024 \
            or not {"/index.html", "/frontend-notices.txt"}.issubset(paths):
        raise ValueError("UI total asset bound/bootstrap/notices missing")
    notice = next(item for item in assets if item.path == "/frontend-notices.txt")
    if sha(inputs.notices) != notice.sha256 or len(inputs.notices) != notice.size_bytes:
        raise ValueError("UI frontend notices hash/size mismatch")
    if not inputs.binary:
        raise ValueError("Empty UI executable")
    return UiManifest(version, manifest["input_sha256"], manifest["lock_sha256"], tuple(assets), inputs.manifest)


def ui_files(inputs, *, source, version, source_identity, core_binary, inspection):
    manifest = validate_assets(inputs, source=source, version=version)
    record = {"schema": 1, "status": "inspection-only", "source_identity": source_identity,
              "core_sha256": sha(core_binary), "ui_sha256": sha(inputs.binary),
              "asset_manifest_sha256": sha(inputs.manifest), "frontend_input_sha256": manifest.input_sha256,
              "frontend_lock_sha256": manifest.lock_sha256, "inspection": inspection,
              "runtime_qualification": "Recorded separately after installed-runtime checks"}
    return {"bin/workgraph-ui": (inputs.binary, 0o755),
            "ui-package/asset-manifest.json": (inputs.manifest, 0o644),
            "ui-package/frontend-notices.txt": (inputs.notices, 0o644),
            "ui-package/QUALIFICATION.json": (encode(record), 0o644)}


def verify_ui_pair(source, native):
    if source.manifest["kind"] != "source" or native.manifest["kind"] != "ui-native":
        raise ValueError("Expected source and UI-native archives")
    if not (NATIVE_SOURCE_FILES | UI_SOURCE_FILES).issubset(source.files):
        raise ValueError("UI source package lacks required offline tools/lock")
    for field in ("version", "source_identity"):
        if source.manifest[field] != native.manifest[field]:
            raise ValueError("Source/UI mismatch: " + field)
    expected = {name for name in source.files if name in NATIVE_SOURCE_FILES | UI_SOURCE_FILES
                or name.startswith(("docs/", "skills/"))}
    additions = {"bin/workgraph", "bin/workgraph-ui", "QUALIFICATION.json", "ui-package/QUALIFICATION.json",
                 "ui-package/asset-manifest.json", "ui-package/frontend-notices.txt"}
    actual = {name for name in native.files if not name.startswith("THIRD_PARTY_NOTICES/")}
    if actual != expected | additions:
        raise ValueError("UI package source file inventory is incomplete or unexpected")
    for name in expected:
        if source.files[name] != native.files[name]:
            raise ValueError("ui-package/source content mismatch: " + name)
    validate_notices(native.files)
    inputs = UiInputs(native.files["bin/workgraph-ui"], native.files["ui-package/asset-manifest.json"],
                      native.files["ui-package/frontend-notices.txt"])
    record = decode(native.files["ui-package/QUALIFICATION.json"])
    if not isinstance(record, dict) or not isinstance(record.get("inspection"), dict):
        raise ValueError("Invalid UI inspection record")
    derived = ui_files(inputs, source=source.files, version=source.manifest["version"],
                       source_identity=source.manifest["source_identity"],
                       core_binary=native.files["bin/workgraph"], inspection=record["inspection"])
    if derived["ui-package/QUALIFICATION.json"][0] != native.files["ui-package/QUALIFICATION.json"]:
        raise ValueError("UI inspection record disagrees with source/executables/assets")
    core = decode(native.files["QUALIFICATION.json"])
    if core.get("schema") != 1 or core.get("status") != "inspection-only" \
            or core.get("platform") != native.manifest["platform"] \
            or core.get("source_identity") != native.manifest["source_identity"] \
            or core.get("executable_sha256") != sha(native.files["bin/workgraph"]):
        raise ValueError("Paired core inspection disagrees with source/executable")
    return {"status": "passed", "kind": "ui-native", "files": len(native.files),
            "source_identity": source.manifest["source_identity"],
            "core_sha256": record["core_sha256"], "ui_sha256": record["ui_sha256"],
            "asset_manifest_sha256": record["asset_manifest_sha256"]}
