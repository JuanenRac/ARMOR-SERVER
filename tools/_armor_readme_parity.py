# =============================================================================
# A.R.M.O.R. - tools/_armor_readme_parity.py
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D)
# GPL-3.0-or-later - see LICENSE
# =============================================================================
# CANONICAL. Vendored byte-for-byte into every other A.R.M.O.R. repository's
# own tools/_armor_readme_parity.py by ARMOR-DOCS/tools/sync_ci_tools.py.
# Edit the rule here, then re-run that script to update every repo that
# vendors it.
"""Checks that every translated README has the same section structure and
external links as the English original - not the same words (translation is
never re-derived here), just the same shape, so a translation cannot
silently fall behind a structural change to the English original."""

from __future__ import annotations

import fnmatch
import re
import subprocess
from pathlib import Path
from typing import Sequence

DEFAULT_LANGUAGE_FILES: tuple[str, ...] = (
    "README.md",
    "README_spa.md",
    "README_fra.md",
    "README_ita.md",
    "README_deu.md",
    "README_zho.md",
    "README_jpn.md",
    "README_por.md",
)

_HEADING_RE = re.compile(r"(?m)^##\s+(?:\d+\.\s+)?(\S+)")
_LINK_RE = re.compile(r"[]][(](https?://[^)\s]+)[)]")


def readme_section_signature(path: Path) -> list[str]:
    """The ordered list of `## ` heading tokens in `path`. A file with no
    `## ` headings at all returns an empty list - a real, honest "nothing to
    compare", not an error."""
    text = path.read_text(encoding="utf-8")
    return _HEADING_RE.findall(text)


def readme_link_set(path: Path) -> set[str]:
    """The external (http/https) link targets in `path`."""
    return set(_LINK_RE.findall(path.read_text(encoding="utf-8")))


def check_readme_section_parity(
    root: Path, language_files: Sequence[str] = DEFAULT_LANGUAGE_FILES
) -> list[str]:
    """Compares `README.md`'s own heading signature (and its set of external
    links) against every other language file in `language_files` that
    actually exists under `root`. Returns ready-to-report mismatch
    descriptions (empty if every present translation's structure matches
    the English original exactly). A missing translation file is not itself
    a parity violation here - the caller's own required-documents check
    covers that separately."""
    english_path = root / language_files[0]
    if not english_path.is_file():
        return [f"{language_files[0]} is missing - cannot check section parity"]
    english_signature = readme_section_signature(english_path)
    english_links = readme_link_set(english_path)

    problems: list[str] = []
    for language_file in language_files[1:]:
        path = root / language_file
        if not path.is_file():
            continue
        signature = readme_section_signature(path)
        if signature != english_signature:
            problems.append(
                f"{language_file} section structure does not match {language_files[0]}: "
                f"expected {english_signature}, got {signature}"
            )
        links = readme_link_set(path)
        if links != english_links:
            missing = sorted(english_links - links)
            extra = sorted(links - english_links)
            problems.append(
                f"{language_file} links do not match {language_files[0]}: missing {missing}, extra {extra}"
            )
    return problems


# The first level of the repository is described by the file tree of the README, so an entry that is
# versioned but missing from it is a README that went stale. The entries that every repository has and
# the files of tooling and configuration that need no sentence of their own are not asked for.
_TREE_EXEMPT = re.compile(
    r"^(README(_[a-z]{3})?\.md|LICENSE(\.md)?|CHANGELOG\.md|CODE_OF_CONDUCT\.md|CONTRIBUTING\.md|SECURITY\.md|SUPPORT\.md"
    r"|THIRD_PARTY_NOTICES\.md|armor\.project\.json|images|\..*|build.*|run.*|dev.*|bump.*|.*project\.json"
    r"|pyproject\.toml|.*\.toml|.*\.lock|package(-lock)?\.json|Dockerfile.*|docker-compose.*|eslint.*|tsconfig.*|vite.*"
    r"|requirements.*|gradle.*|gradlew.*|settings\.gradle.*|local\.properties)$"
)
_TREE_FENCE = re.compile(r"```[a-z]*\n(.*?)```", re.S)
_TREE_LINE = re.compile(r"^[├└]── ([^\s,]+(?:, [^\s,]+)*)")


def readme_tree_entries(path: Path) -> set[str] | None:
    """The first-level names that the file tree of `path` lists (patterns such as `sdkconfig.board.*` included), or None when there is no tree.
    The tree is the code block with the most tree rows."""
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    best = ""
    best_rows = 0
    for fence in _TREE_FENCE.finditer(text):
        rows = len(re.findall(r"^[├└]── ", fence.group(1), re.M))
        if rows > best_rows:
            best, best_rows = fence.group(1), rows
    if not best_rows:
        return None
    names: set[str] = set()
    for line in best.split("\n"):
        found = _TREE_LINE.match(line)
        if found:
            names.update(part.rstrip("/").split("/")[0] for part in found.group(1).split(", "))
    return names


def tracked_first_level(root: Path) -> dict[str, bool] | None:
    """The first-level entries of the repository that Git versions (name -> is a folder), or None when Git cannot tell."""
    try:
        result = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    entries: dict[str, bool] = {}
    for item in result.stdout.decode("utf-8", "replace").split("\0"):
        if item:
            parts = item.split("/")
            entries[parts[0]] = entries.get(parts[0], False) or len(parts) > 1
    return entries or None


def check_readme_tree(
    root: Path,
    language_files: Sequence[str] = DEFAULT_LANGUAGE_FILES,
    tracked: dict[str, bool] | None = None,
) -> list[str]:
    """Reports, for every README that has a file tree, the versioned first-level entries that the tree leaves out."""
    entries = tracked if tracked is not None else tracked_first_level(root)
    if entries is None:
        return []
    problems: list[str] = []
    for language_file in language_files:
        path = root / language_file
        if not path.is_file():
            continue
        listed = readme_tree_entries(path)
        if listed is None:
            continue
        missing = sorted(
            name for name in entries
            if not _TREE_EXEMPT.match(name) and not any(fnmatch.fnmatchcase(name, pattern) for pattern in listed)
        )
        if missing:
            problems.append(f"{language_file} file tree does not list: {', '.join(missing)}")
    return problems
