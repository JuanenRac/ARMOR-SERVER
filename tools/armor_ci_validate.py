#!/usr/bin/env python3
# =============================================================================
# A.R.M.O.R. - tools/armor_ci_validate.py
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D)
# GPL-3.0-or-later - see LICENSE
# =============================================================================
# CANONICAL. Vendored byte-for-byte into every other A.R.M.O.R. repository's
# own tools/armor_ci_validate.py by ARMOR-DOCS/tools/sync_ci_tools.py, next
# to a vendored copy of _armor_readme_parity.py and of armor_project_tool.py
# itself. Edit the rule here, then re-run that script to update every repo
# that vendors it.
"""Dependency-free CI baseline for one A.R.M.O.R. repository: the manifest
is well-formed and matches this checkout, the version is not stale anywhere
it is restated (CHANGELOG.md's own heading, README prose), the seven
translated READMEs have the same structure as the English original, and
every local Markdown link resolves. Never runs a build - that is
`armor_project_tool.py build-test`'s job, run as a separate CI step so a
manifest problem is reported without waiting on a slow build first.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _armor_readme_parity import check_readme_section_parity  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "armor.project.json"
REQUIRED_DOCUMENTS = (
    "README.md",
    "README_spa.md",
    "README_fra.md",
    "README_ita.md",
    "README_deu.md",
    "README_zho.md",
    "README_jpn.md",
    "CHANGELOG.md",
    "LICENSE",
)
REQUIRED_MANIFEST_KEYS = (
    "schema_version", "ecosystem", "name", "version", "role", "stack", "technologies",
    "deployment_target", "maturity", "family", "parent", "build", "notes", "native_version",
)
VALID_MATURITY = {"scaffolding", "functional", "established", "production"}
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
VERSION_HEADING = re.compile(r"(?im)^#{1,3}\s*\[?(\d+\.\d+\.\d+)(?:\]|\s|$)")

# A version-shaped token sitting next to one of these "current version"
# label words (any of the seven languages), or right after this project's
# own name, must agree with the manifest - a README's own free prose is
# never re-derived from the manifest automatically and can silently go
# stale otherwise. Lines describing the odometer scheme itself (an arrow
# between two versions, e.g. "0.0.9 -> 0.1.0") are exempt.
VERSION_PROSE_LABELS = (
    "Real today", "Real hoy", "Réel aujourd'hui", "Reale oggi", "Heute real",
    "目前真实的部分", "現時点で実在するもの",
    "Version:", "Versión:", "Version :", "Versione:", "版本：", "バージョン：",
    "Current version", "Versión actual", "Version actuelle",
    "Versione attuale", "Aktuelle Version", "当前版本", "現在のバージョン",
    "Status:", "Estado:", "État :", "Stato:", "状态：", "ステータス",
)
VERSION_PROSE_LABEL_PATTERN = re.compile(
    "|".join(f"(?<![A-Za-zÀ-ɏ])(?:{re.escape(label)})" for label in VERSION_PROSE_LABELS)
)
VERSION_PROSE_TOKEN = re.compile(r"\bv?(\d+\.\d+\.\d+)\b")

LOCAL_MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+[\"'][^)]*)?\)")
MARKDOWN_EXCLUDED_DIRECTORIES = {
    ".git", ".venv", "venv", "node_modules", "build", "dist", "target",
    "__pycache__", ".gradle",
}


def fail(message: str) -> None:
    print(f"CI_VALIDATION=FAIL {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_readme_version_prose(manifest: dict) -> None:
    real_version = manifest["version"]
    name_pattern = re.compile(re.escape(manifest["name"]) + r"\s+v(\d+\.\d+\.\d+)")
    offenders: list[str] = []
    for document_name in REQUIRED_DOCUMENTS:
        if not document_name.startswith("README"):
            continue
        path = ROOT / document_name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), start=1):
            if "->" in line or "→" in line:
                continue
            if VERSION_PROSE_LABEL_PATTERN.search(line) is None and name_pattern.search(line) is None:
                continue
            for match in VERSION_PROSE_TOKEN.finditer(line):
                found = match.group(1)
                if found != real_version:
                    offenders.append(f"{document_name}:{line_number}: states {found}, manifest says {real_version}")
    if offenders:
        preview = "; ".join(offenders[:10])
        suffix = "" if len(offenders) <= 10 else f" (+{len(offenders) - 10} more)"
        fail(f"README states a stale current-version number: {preview}{suffix}")


def validate_local_markdown_links() -> None:
    broken: list[str] = []
    for markdown_path in ROOT.rglob("*.md"):
        if any(part in MARKDOWN_EXCLUDED_DIRECTORIES for part in markdown_path.parts):
            continue
        text = markdown_path.read_text(encoding="utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), start=1):
            for match in LOCAL_MARKDOWN_LINK.finditer(line):
                reference = match.group(1).strip().strip("<>")
                target = reference.split("#", maxsplit=1)[0].split("?", maxsplit=1)[0]
                if not target or re.match(r"(?i)^(https?:|mailto:|tel:|data:)", target):
                    continue
                if target.startswith("/"):
                    continue
                destination = (markdown_path.parent / target).resolve()
                if not destination.exists():
                    relative = markdown_path.relative_to(ROOT)
                    broken.append(f"{relative}:{line_number} -> {reference}")
    if broken:
        preview = "; ".join(broken[:10])
        suffix = "" if len(broken) <= 10 else f" (+{len(broken) - 10} more)"
        fail(f"broken local Markdown link(s): {preview}{suffix}")


def main() -> int:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read manifest: {exc}")

    missing = [key for key in REQUIRED_MANIFEST_KEYS if key not in manifest]
    if missing:
        fail(f"manifest missing required keys: {', '.join(missing)}")
    if manifest["ecosystem"] != "A.R.M.O.R.":
        fail("manifest ecosystem must be A.R.M.O.R.")
    if manifest["name"] != ROOT.name:
        fail(f"manifest name {manifest['name']!r} must match repository directory {ROOT.name!r}")
    if not isinstance(manifest["version"], str) or not SEMVER.fullmatch(manifest["version"]):
        fail("manifest version must be MAJOR.MINOR.PATCH")
    if manifest["maturity"] not in VALID_MATURITY:
        fail(f"unsupported maturity: {manifest['maturity']!r}")
    if not isinstance(manifest["technologies"], list) or not manifest["technologies"]:
        fail("manifest technologies must be a non-empty list")
    if not isinstance(manifest["native_version"], str) or not SEMVER.fullmatch(manifest["native_version"]):
        fail("manifest native_version must be MAJOR.MINOR.PATCH")
    if manifest["native_version"] != manifest["version"]:
        fail(f"native_version {manifest['native_version']} differs from version {manifest['version']}")

    missing_documents = [name for name in REQUIRED_DOCUMENTS if not (ROOT / name).is_file()]
    if missing_documents:
        fail(f"required documentation missing: {', '.join(missing_documents)}")

    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8", errors="replace")
    heading = VERSION_HEADING.search(changelog)
    if heading is None or heading.group(1) != manifest["version"]:
        found = heading.group(1) if heading else "<none>"
        fail(f"latest changelog version {found} differs from manifest {manifest['version']}")

    validate_readme_version_prose(manifest)

    # A Python project's pyproject.toml `version` and its package
    # `__init__.py`'s `__version__` mirror are a separate copy of the same
    # number - found while auditing the ecosystem, several had silently
    # drifted behind the manifest (armor_project_tool.py's `bump()` now
    # keeps them in sync going forward; this check catches a future regression
    # or a manual edit that skips it).
    pyproject_path = ROOT / "pyproject.toml"
    if pyproject_path.is_file():
        pyproject_version = re.search(r'(?m)^version\s*=\s*"([^"]+)"', pyproject_path.read_text(encoding="utf-8", errors="replace"))
        if pyproject_version is None:
            fail("pyproject.toml is missing its own [project].version")
        if pyproject_version.group(1) != manifest["version"]:
            fail(f"pyproject.toml version {pyproject_version.group(1)} differs from manifest {manifest['version']}")
    for init_file in (ROOT / "src").glob("*/__init__.py"):
        text = init_file.read_text(encoding="utf-8", errors="replace")
        init_version = re.search(r'(?m)^__version__\s*=\s*"([^"]+)"', text)
        if init_version is not None and init_version.group(1) != manifest["version"]:
            fail(f"{init_file.relative_to(ROOT)} __version__ {init_version.group(1)} differs from manifest {manifest['version']}")

    gitignore = ROOT / ".gitignore"
    env_file = ROOT / ".env"
    if env_file.is_file():
        if not gitignore.is_file() or not re.search(r"(?m)^\.env\s*$", gitignore.read_text(encoding="utf-8", errors="replace")):
            fail(".env exists locally and must be excluded by .gitignore")

    validate_local_markdown_links()

    for readme_problem in check_readme_section_parity(ROOT):
        fail(readme_problem)

    print(f"CI_VALIDATION=PASS project={manifest['name']} version={manifest['version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
