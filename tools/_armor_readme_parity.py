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

import re
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
