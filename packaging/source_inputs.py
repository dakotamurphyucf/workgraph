"""Explicit authored source boundary shared by source and optional UI packages.

No Git metadata or ignore configuration is consulted. Generated/private trees are
excluded even in an untracked checkout; links in admitted source are rejected.
"""
import os
from pathlib import Path

FIXED = ("README.md", "AGENTS.md", "engineering-standards.md", "LICENSE",
         ".gitignore", ".gitattributes", ".dockerignore", ".ocamlformat", "dune",
         "dune-project", "dev", "workgraph.opam")
UI_FIXED = ("dev-ui", "workgraph-ui.opam", "workgraph-ui.opam.template")
TREES = ("bin", "lib", "test", "skills", "bench", "docs", "tools", "packaging", ".github")
UI_TREES = ("ui/companion", "ui/test-support", "ui/tools", "ui/tests",
            "ui/frontend/src", "ui/frontend/public", "ui/frontend/tests")
UI_FRONTEND = ("README.md", "package.json", "package-lock.json", "index.html",
               "tsconfig.json", "vite.config.ts", "vitest.config.ts", "playwright.config.ts",
               "eslint.config.js", "prettier.config.js")
EMBEDDED_AUTHORED = frozenset({"ui/tools/embedded/dune", "ui/tools/embedded/workgraph_ui_assets.mli"})
EXCLUDED_DIRECTORIES = frozenset({"node_modules", "_build", "dist", "scratch", ".git",
                                  "_opam", ".opam", ".local", ".cache",
                                  "__pycache__", "playwright-report", "test-results"})


def executable(name):
    return name in {"dev", "dev-ui", "bin/workgraph", "bin/workgraph-ui"} or name.endswith(".sh")


def collect(root: Path):
    names = list(FIXED)
    # The source package always contains the optional UI when this checkout has
    # it. Tiny core-only fixture/legacy source trees remain independently usable.
    has_ui = any((root / name).exists() for name in ("dev-ui", "workgraph-ui.opam", "ui"))
    trees = TREES
    if has_ui:
        names.extend(UI_FIXED)
        names.extend("ui/frontend/" + name for name in UI_FRONTEND)
        trees += UI_TREES
    for directory in trees:
        base = root / directory
        if base.is_symlink():
            raise ValueError("Source links are not permitted: " + directory)
        if not base.exists():
            continue
        for current, directories, files in os.walk(base, followlinks=False):
            directories[:] = sorted(name for name in directories
                                    if name not in EXCLUDED_DIRECTORIES and not name.startswith("_build"))
            for name in directories + sorted(files):
                path = Path(current) / name
                relative = path.relative_to(root).as_posix()
                if directory == "ui/tools" and relative.startswith("ui/tools/embedded/") \
                        and relative not in EMBEDDED_AUTHORED:
                    continue
                if name in {".DS_Store", ".env"} or name.startswith(("._", ".env.")) \
                        or name.endswith((".corrected", ".pyc")):
                    continue
                if path.is_symlink() or not (path.is_file() or path.is_dir()):
                    raise ValueError("Source links and special files are not permitted: " + relative)
                if path.is_file():
                    names.append(relative)
    result = {}
    for name in sorted(set(names)):
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Missing or nonregular source file: " + name)
        result[name] = (path.read_bytes(), 0o755 if executable(name) else 0o644)
    return result
