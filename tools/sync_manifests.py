#!/usr/bin/env python3
# =============================================================================
# sync_manifests.py
# Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
# GPL-3.0-or-later - see LICENSE
# =============================================================================
# CANONICAL copy kept byte-for-byte in HYDRA-UMC-DOCS, ARMOR-DOCS and URTC-DOCS (tools/). The family is taken from the folder this file sits in.
"""Keeps the manifests of a family (``*.project.json``) in step with what can be checked about each repository.

Only FACTS that can be computed are handled here. Judgements (maturity, ``evidence`` such as "bench" or "field", anything that says a
thing was tried on real hardware) are never written by this tool: a green hardware light needs a human record in the manifest.

Facts per repository (read from ``origin/main`` with ``git show``, so a dirty clone does not matter):

    native version      the version in the files the product ships with == the version of the manifest
    components          (URTC) every component version == the header it is read from
    changelog           the newest released heading == the version of the manifest; number of entries under [Unreleased]
    tests               the repository has test files
    simulation          a workflow of the repository runs a simulator / replay / fake bench
    release (online)    the newest release of GitHub is not newer than the manifest, and the tag of the manifest version exists once released
    ci (online)         the last completed run of main

    python tools/sync_manifests.py --check                 # offline: exit 1 when a manifest contradicts what is computed
    python tools/sync_manifests.py --check --online        # also asks GitHub (gh), within --max-calls, with a cache
    python tools/sync_manifests.py --report out.json       # every fact of every repository, for reading
    python tools/sync_manifests.py --apply                 # write the derivable fields (see below) and data/manifest_facts.json

--apply writes: the ``version`` of a manifest when the shipped files are AHEAD of it (never lowers it), the ``native_version`` mirror of
a manifest that keeps one, and ``data/manifest_facts.json`` of the docs repository (no dates, so it only changes when a fact changes).
It never writes ``maturity``, ``evidence`` or ``hardware_bound``.

Findings are HARD (contradict the computed state; --check fails) or NOTE (information: release pending, unreleased entries, human
record missing). A repository may list findings it accepts for now in ``data/manifest_waivers.json`` as {"REPO": ["CODE", ...]}.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent
FAMILIES = {"HYDRA-UMC-DOCS": ("HYDRA-UMC", "hydra-umc.project.json"), "ARMOR-DOCS": ("ARMOR", "armor.project.json"), "URTC-DOCS": ("URTC", "urtc.project.json")}
PREFIX, MANIFEST = FAMILIES.get(DOCS.name, ("HYDRA-UMC", "hydra-umc.project.json"))
DOCS_NAME = DOCS.name
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:\.\d+)?$")
SIM_WORDS = re.compile(r"(?i)simulat|sitl|replay|fake[_-]|virtual[_-]?(?:board|bus|rack)|emulat|chain_sim|loopback[_-]?(?:rack|bus)|bench[_-]?sim")
TEST_FILE = re.compile(r"(^|/)(test_[^/]*\.(py|js|ts|rs|cpp|c|kt)|[^/]*_test\.(py|go|rs|c|cpp)|[^/]*\.(test|spec)\.(js|ts|tsx|mjs)|[^/]*Tests?\.(kt|java|swift|cs)|tests?/[^/]+\.[a-z]+|__tests__/[^/]+)$")
SIM_PATH = re.compile(r"(?i)(simulat|sitl|replay|fake_|_fake|fake[A-Z]|virtual_|emulat|chain_sim|mock_)")
HARD = "HARD"
NOTE = "NOTE"


def git(repo: Path, *args: str) -> str | None:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    return result.stdout.decode("utf-8", errors="replace") if result.returncode == 0 else None


class Repo:
    def __init__(self, path: Path, ref: str) -> None:
        self.path, self.name = path, path.name
        self.ref = ref
        if ref == "WORKTREE":
            skip = {".git", "node_modules", "target", "build", "dist", ".venv", "__pycache__", ".gradle"}
            self.files = []
            for current, dirs, names in os.walk(path):
                dirs[:] = [d for d in dirs if d not in skip]
                self.files += [(Path(current) / n).relative_to(path).as_posix() for n in names]
        else:
            if git(path, "rev-parse", "--verify", "-q", ref) is None:
                self.ref = "HEAD"
            self.files = [line for line in (git(path, "ls-tree", "-r", "--name-only", self.ref) or "").splitlines() if line]
        self.fileset = set(self.files)

    def read(self, rel: str) -> str | None:
        if rel not in self.fileset:
            return None
        if self.ref == "WORKTREE":
            return (self.path / rel).read_text(encoding="utf-8", errors="replace")
        return git(self.path, "show", f"{self.ref}:{rel}")


def odometer(version: str) -> tuple[int, ...]:
    """Four components, so that 0.4.5 and 0.4.5.0 are the same version."""
    numbers = [int(part) for part in version.split(".")]
    return tuple(numbers + [0] * (4 - len(numbers)))


def same(left: str, right: str, three: bool = False) -> bool:
    """Equal versions; with three=True only the first three components count (pubspec.yaml and package.json hold three)."""
    if three and SEMVER.match(left) and SEMVER.match(right):
        return odometer(left)[:3] == odometer(right)[:3]
    return SEMVER.match(left) is not None and SEMVER.match(right) is not None and odometer(left) == odometer(right)


def pattern_version(text: str, pattern: object) -> str | None:
    if isinstance(pattern, str):
        found = re.search(pattern, text, re.M)
        return ".".join(group for group in found.groups() if group is not None) if found else None
    if isinstance(pattern, dict):
        parts = []
        for key in ("major", "minor", "patch", "build"):
            if key in pattern:
                found = re.search(pattern[key], text, re.M)
                if not found:
                    return None
                parts.append(found.group(1))
        return ".".join(parts)
    return None


def native_candidates(repo: Repo, manifest: dict) -> list[tuple[str, str]]:
    """(file, version) of every shipped file that carries the version of the product."""
    native, found = manifest.get("native_version"), []
    if isinstance(native, dict):
        text = repo.read(native.get("file", ""))
        version = pattern_version(text, native.get("pattern")) if text is not None else None
        found.append((native.get("file", "?"), version or "UNREADABLE"))
        return found
    # ARMOR keeps the version string in the manifest itself; the shipped files are looked up.
    package = repo.read("package.json")
    if package:
        try:
            value = json.loads(package).get("version")
            if value:
                found.append(("package.json", str(value)))
        except ValueError:
            pass
    for rel, regex in (("pyproject.toml", r'(?m)^version\s*=\s*"([^"]+)"'), ("app/build.gradle.kts", r'versionName\s*=\s*"([^"]+)"')):
        text = repo.read(rel)
        if text:
            match = re.search(regex, text)
            if match:
                found.append((rel, match.group(1)))
    for rel in repo.files:
        if rel.count("/") <= 2 and rel.endswith("/__init__.py") and rel.startswith("src/"):
            match = re.search(r'(?m)^__version__\s*=\s*"([^"]+)"', repo.read(rel) or "")
            if match:
                found.append((rel, match.group(1)))
    return found


def component_findings(repo: Repo, manifest: dict) -> list[tuple[str, str, str]]:
    out = []
    for component in manifest.get("components", []) or []:
        source = component.get("source", {})
        text = repo.read(source.get("file", ""))
        if text is None:
            out.append((HARD, "COMPONENT_SOURCE_MISSING", f"{component.get('name')}: {source.get('file')} not found"))
            continue
        prefix, parts = source.get("prefix", ""), []
        for key in ("MAJOR", "MINOR", "PATCH", "BUILD"):
            match = re.search(rf"#define\s+{re.escape(prefix)}_{key}\s+(\d+)", text)
            if match:
                parts.append(match.group(1))
        version = ".".join(parts)
        if version and not same(version, str(component.get("version"))):
            out.append((HARD, "COMPONENT_VERSION", f"{component.get('name')}: header says {version}, manifest {component.get('version')}"))
    return out


def changelog_facts(repo: Repo) -> dict:
    text = repo.read("CHANGELOG.md")
    if text is None:
        return {"present": False}
    released, unreleased, in_unreleased = None, 0, False
    for line in text.splitlines():
        heading = re.match(r"^#{1,3}\s*\[?([^\]\s]+)\]?", line)
        if line.startswith("#") and heading and not line.startswith("####"):
            word = heading.group(1)
            if word.lower() == "unreleased":
                in_unreleased = True
                continue
            in_unreleased = False
            if released is None and SEMVER.match(word):
                released = word
        elif in_unreleased and re.match(r"^\s*[-*]\s+\S", line):
            unreleased += 1
    return {"present": True, "head": released, "unreleased": unreleased}


def simulation_facts(repo: Repo) -> dict:
    hits = []
    for rel in repo.files:
        if rel.startswith(".github/workflows/") and rel.endswith((".yml", ".yaml")):
            for line in (repo.read(rel) or "").splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and SIM_WORDS.search(stripped):
                    hits.append(f"{Path(rel).name}: {stripped[:80]}")
                    break
    has_ci = any(rel.startswith(".github/workflows/") for rel in repo.files)
    files = [rel for rel in repo.files if SIM_PATH.search(rel) and "node_modules/" not in rel]
    return {"ci_simulation": bool(hits) or (has_ci and bool(files)), "evidence_lines": hits[:3] or files[:3]}


class Gh:
    """GitHub facts through `gh`, cached and limited: the quota of the API is shared with everything else."""

    def __init__(self, owner: str, max_calls: int, cache: Path, ttl: int) -> None:
        self.owner, self.max_calls, self.calls, self.cache_path, self.ttl = owner, max_calls, 0, cache, ttl
        try:
            self.cache = json.loads(cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.cache = {}

    def ask(self, key: str, endpoint: str, query: str) -> str:
        entry = self.cache.get(key)
        if entry and time.time() - entry["at"] < self.ttl:
            return entry["value"]
        if self.calls >= self.max_calls:
            return "budget"
        self.calls += 1
        result = subprocess.run(["gh", "api", endpoint, "--jq", query], capture_output=True, text=True, timeout=60)
        value = result.stdout.strip() if result.returncode == 0 else ("none" if "404" in result.stderr else "error")
        if value != "error":
            self.cache[key] = {"at": time.time(), "value": value}
        return value or "none"

    def save(self) -> None:
        try:
            self.cache_path.write_text(json.dumps(self.cache), encoding="utf-8")
        except OSError:
            pass

    def release(self, repo: str) -> str:
        return self.ask(f"rel:{repo}", f"repos/{self.owner}/{repo}/releases/latest", ".tag_name")

    def ci(self, repo: str) -> str:
        return self.ask(f"ci:{repo}", f"repos/{self.owner}/{repo}/actions/runs?branch=main&status=completed&per_page=1", ".workflow_runs[0].conclusion // \"none\"")


def inspect(repo: Repo, gh: Gh | None) -> dict:
    raw = repo.read(MANIFEST)
    if raw is None:
        return {"name": repo.name, "findings": [(HARD, "NO_MANIFEST", f"{MANIFEST} not found")]}
    manifest = json.loads(raw)
    version, findings = str(manifest.get("version", "")), []
    candidates = native_candidates(repo, manifest)
    for rel, value in candidates:
        if not same(value, version, three=rel.endswith(("pubspec.yaml", "package.json"))):
            findings.append((HARD, "NATIVE_VERSION", f"{rel} says {value}, manifest says {version}"))
    if not candidates:
        findings.append((NOTE, "NATIVE_UNKNOWN", "no shipped file with the version was found"))
    if isinstance(manifest.get("native_version"), str) and manifest["native_version"] != version:
        findings.append((HARD, "NATIVE_MIRROR", f"native_version {manifest['native_version']} differs from version {version}"))
    findings.extend(component_findings(repo, manifest))
    log = changelog_facts(repo)
    if log.get("present") and log.get("head") and not same(log["head"], version):
        findings.append((HARD, "CHANGELOG_HEAD", f"the newest released heading is {log['head']}, manifest says {version}"))
    if log.get("unreleased"):
        findings.append((NOTE, "UNRELEASED", f"{log['unreleased']} entries under [Unreleased]"))
    tests = any(TEST_FILE.search(rel) for rel in repo.files)
    sim = simulation_facts(repo)
    evidence, hardware_bound = manifest.get("evidence", "none"), manifest.get("hardware_bound", True)
    if evidence in ("host-test", "simulator", "bench", "field") and not tests:
        findings.append((HARD, "EVIDENCE_NO_TESTS", f"evidence is {evidence} but the repository has no test files"))
    if evidence == "simulator" and not sim["ci_simulation"]:
        findings.append((HARD, "SIMULATOR_NO_CI_JOB", "evidence is simulator but no workflow runs a simulator, replay or fake bench"))
    if evidence in ("bench", "field") and not manifest.get("evidence_record"):
        findings.append((NOTE, "HUMAN_RECORD_MISSING", f"evidence is {evidence}: a person has to keep the record of that test in 'evidence_record'"))
    if evidence == "none" and sim["ci_simulation"] and hardware_bound is not False:
        findings.append((NOTE, "SIMULATION_NOT_CLAIMED", "a workflow runs a simulation but evidence is none: a person may raise it to simulator"))
    facts = {"manifest_version": version, "native": dict(candidates), "maturity": manifest.get("maturity"), "evidence": evidence, "hardware_bound": hardware_bound,
             "changelog_head": log.get("head"), "unreleased_entries": log.get("unreleased", 0), "tests_present": tests, "ci_simulation": sim["ci_simulation"]}
    if gh is not None:
        latest, state = gh.release(repo.name), gh.ci(repo.name)
        facts["latest_release"], facts["ci_main"] = latest, state
        number = latest.lstrip("v")
        if SEMVER.match(number) and SEMVER.match(version):
            if odometer(number) > odometer(version):
                findings.append((HARD, "RELEASE_AHEAD", f"the newest release {latest} is newer than the manifest {version}"))
            elif number != version:
                findings.append((NOTE, "RELEASE_PENDING", f"manifest {version} is not released yet (latest {latest})"))
        if state not in ("success", "none", "budget", "error"):
            findings.append((NOTE, "CI_MAIN", f"the last completed run of main is {state}"))
    return {"name": repo.name, "manifest": manifest, "facts": facts, "findings": findings}


def family_repos(workspace: Path, only: list[str]) -> list[Path]:
    out = []
    for path in sorted(workspace.iterdir()):
        if path.is_dir() and (path.name == PREFIX or path.name.startswith(PREFIX + "-")) and (path / ".git").exists():
            if not only or path.name in only or path.name.removeprefix(PREFIX + "-") in only:
                out.append(path)
    return out


def apply_changes(results: list[dict], workspace: Path) -> list[str]:
    """Write the derivable fields. Returns what was written."""
    done = []
    for item in results:
        manifest, facts = item.get("manifest"), item.get("facts")
        if not manifest or not facts:
            continue
        repo_dir = workspace / item["name"]
        path = repo_dir / MANIFEST
        if not path.is_file():
            continue
        newest = [v for v in facts["native"].values() if SEMVER.match(v)]
        changed = False
        if newest:
            top = max(newest, key=odometer)
            if odometer(top) > odometer(manifest["version"]):
                manifest["version"] = top
                changed = True
        if isinstance(manifest.get("native_version"), str) and manifest["native_version"] != manifest["version"]:
            manifest["native_version"] = manifest["version"]
            changed = True
        if changed:
            path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            done.append(f"{item['name']}: version -> {manifest['version']}")
    return done


def waivers(base: Path | None = None) -> dict:
    path = (base or DOCS) / "data" / "manifest_waivers.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def run_in_ci(root: Path) -> list[str]:
    """The contradictions of ONE repository, from its working tree and offline: what ci_validate calls (the file is vendored next to it)."""
    global MANIFEST
    names = [n for n in ("hydra-umc.project.json", "armor.project.json", "urtc.project.json") if (root / n).is_file()]
    if not names:
        return []
    MANIFEST = names[0]
    item = inspect(Repo(root, "WORKTREE"), None)
    listed = waivers(root)
    skip = set(listed.get(root.name, [])) | set(listed.get("*", []))
    return [f"manifest facts: {code}: {text}" for level, code, text in item["findings"] if level == HARD and code not in skip]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--workspace", default=str(DOCS.parent), help="folder holding the clones of the family")
    parser.add_argument("--ref", default="origin/main")
    parser.add_argument("--repo", action="append", default=[])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--apply", action="store_true", help="write data/manifest_facts.json of the docs repository")
    parser.add_argument("--apply-manifests", action="store_true", help="also write the derivable fields into the manifests of the clones (local use)")
    parser.add_argument("--self", dest="self_only", action="store_true", help="only the repository this docs repository is, from its working tree (for ci_validate)")
    parser.add_argument("--report")
    parser.add_argument("--online", action="store_true")
    parser.add_argument("--owner", default="JuanenRac")
    parser.add_argument("--max-calls", type=int, default=150, help="most GitHub API calls of one run (the quota is shared)")
    parser.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "sync_manifests_cache.json"))
    parser.add_argument("--cache-ttl", type=int, default=21600)
    args = parser.parse_args()
    workspace = Path(args.workspace)
    gh = Gh(args.owner, args.max_calls, Path(args.cache), args.cache_ttl) if args.online else None
    if args.self_only:
        results = [inspect(Repo(DOCS, "WORKTREE"), None)]
    else:
        results = [inspect(Repo(path, args.ref), gh) for path in family_repos(workspace, args.repo)]
    if gh:
        gh.save()
    waived, hard, notes = waivers(), 0, 0
    for item in results:
        item["findings"] = [f for f in item["findings"] if f[1] not in waived.get(item["name"], [])]
        for level, code, text in item["findings"]:
            if level == HARD:
                hard += 1
                print(f"MANIFEST_FACTS=FAIL {item['name']} {code}: {text}", file=sys.stderr)
            else:
                notes += 1
                if not args.check:
                    print(f"note {item['name']} {code}: {text}")
    if args.report:
        slim = [{"name": r["name"], "facts": r.get("facts"), "findings": r["findings"]} for r in results]
        Path(args.report).write_text(json.dumps(slim, indent=1, ensure_ascii=False), encoding="utf-8")
    if args.apply_manifests:
        for line in apply_changes(results, workspace):
            print("wrote", line)
    if args.apply:
        facts_path = DOCS / "data" / "manifest_facts.json"
        stable = {r["name"]: {k: v for k, v in r["facts"].items() if k not in ("ci_main",)} for r in results if r.get("facts")}
        facts_path.parent.mkdir(exist_ok=True)
        facts_path.write_text(json.dumps({"repos": stable}, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"MANIFEST_FACTS={'FAIL' if hard else 'PASS'} repositories={len(results)} hard={hard} notes={notes}" + (f" api_calls={gh.calls}" if gh else ""))
    return 1 if (args.check and hard) else 0


if __name__ == "__main__":
    raise SystemExit(main())
