"""Lockstep version for the npm package, the GitHub release and the Chrome extension.

    python scripts/sync_version.py --set X.Y.Z   # write X.Y.Z everywhere
    python scripts/sync_version.py --check       # fail (exit 1) on any mismatch

Checked/written sources (paths relative to packages/):
  package.json, mcp-robotstudio/package.json, chrome-extension/package.json,
  chrome-extension/public/manifest.json, package-lock.json (root + both workspaces),
  the "0.0.0"-style fallbacks in mcp-robotstudio/src/cli.ts and src/mcp/server.ts,
  and the top "## X.Y.Z" heading of mcp-robotstudio/CHANGELOG.md.
--check also covers chrome-extension/dist/manifest.json and the manifest inside
chrome-extension/mcp-robotstudio-rws-monitor.zip when those build outputs exist.
Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "packages"
# SemVer core without leading zeros: valid for npm, git tags and the Chrome Web Store.
VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")

JSON_FILES = [
    "package.json",
    "mcp-robotstudio/package.json",
    "chrome-extension/package.json",
    "chrome-extension/public/manifest.json",
]
LOCK = "package-lock.json"
LOCK_WORKSPACES = ["mcp-robotstudio", "chrome-extension"]
TS_FALLBACKS = {
    "mcp-robotstudio/src/cli.ts": re.compile(r'(pkg\.version \?\? ")([^"]*)(")'),
    "mcp-robotstudio/src/mcp/server.ts": re.compile(r'(PACKAGE_VERSION = pkg\.version \?\? ")([^"]*)(")'),
}
CHANGELOG = "mcp-robotstudio/CHANGELOG.md"
CHANGELOG_RE = re.compile(r"^## (\d+\.\d+\.\d+)\b", re.M)
DIST_MANIFEST = "chrome-extension/dist/manifest.json"
ZIP = "chrome-extension/mcp-robotstudio-rws-monitor.zip"


def _load(rel: str) -> dict:
    return json.loads((PKG / rel).read_text(encoding="utf-8"))


def _dump(rel: str, data: dict) -> None:
    (PKG / rel).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def _with_version(data: dict, version: str) -> dict:
    """Set "version", keeping it right after "name" when the key is new."""
    if "version" in data:
        data["version"] = version
        return data
    out = {}
    for key, value in data.items():
        out[key] = value
        if key == "name":
            out["version"] = version
    out.setdefault("version", version)
    return out


def collect() -> dict[str, str | None]:
    """Return {source: version found} for every lockstep source."""
    found: dict[str, str | None] = {rel: _load(rel).get("version") for rel in JSON_FILES}
    lock = _load(LOCK)
    found[f"{LOCK} (root)"] = lock.get("version")
    found[f'{LOCK} packages[""]'] = lock["packages"][""].get("version")
    for ws in LOCK_WORKSPACES:
        found[f"{LOCK} packages[{ws}]"] = lock["packages"].get(ws, {}).get("version")
    for rel, rx in TS_FALLBACKS.items():
        m = rx.search((PKG / rel).read_text(encoding="utf-8"))
        found[f"{rel} (fallback)"] = m.group(2) if m else None
    m = CHANGELOG_RE.search((PKG / CHANGELOG).read_text(encoding="utf-8"))
    found[f"{CHANGELOG} (top heading)"] = m.group(1) if m else None
    if (PKG / DIST_MANIFEST).is_file():
        found[DIST_MANIFEST] = _load(DIST_MANIFEST).get("version")
    if (PKG / ZIP).is_file():
        with zipfile.ZipFile(PKG / ZIP) as zf:
            found[f"{ZIP}!manifest.json"] = json.loads(zf.read("manifest.json")).get("version")
    return found


def set_version(version: str) -> None:
    for rel in JSON_FILES:
        _dump(rel, _with_version(_load(rel), version))
    lock = _with_version(_load(LOCK), version)
    lock["packages"][""] = _with_version(lock["packages"][""], version)
    for ws in LOCK_WORKSPACES:
        lock["packages"][ws] = _with_version(lock["packages"][ws], version)
    _dump(LOCK, lock)
    for rel, rx in TS_FALLBACKS.items():
        path = PKG / rel
        text = path.read_text(encoding="utf-8")
        new, n = rx.subn(lambda m: m.group(1) + version + m.group(3), text, count=1)
        if n != 1:
            raise SystemExit(f"version fallback pattern not found in {rel}")
        path.write_text(new, encoding="utf-8", newline="")
    path = PKG / CHANGELOG
    text = path.read_text(encoding="utf-8")
    m = CHANGELOG_RE.search(text)
    if not m or m.group(1) != version:
        head, sep, rest = text.partition("\n\n")
        path.write_text(f"{head}{sep}## {version} - Unreleased\n\n{rest}", encoding="utf-8", newline="")


def check() -> int:
    found = collect()
    versions = {v for v in found.values()}
    if len(versions) == 1 and None not in versions and VERSION_RE.match(next(iter(versions))):
        print(f"VERSION SYNC OK ({next(iter(versions))}) across {len(found)} sources")
        return 0
    expected = _load("mcp-robotstudio/package.json").get("version")
    print(f"VERSION SYNC FAILED (expected {expected} from mcp-robotstudio/package.json):", file=sys.stderr)
    for src, ver in found.items():
        mark = "ok " if ver == expected else "BAD"
        print(f"  [{mark}] {src}: {ver}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--set", metavar="X.Y.Z")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.set is not None:
        if not VERSION_RE.match(args.set):
            print(f"invalid version {args.set!r}: expected X.Y.Z (digits only)", file=sys.stderr)
            return 2
        set_version(args.set)
        print(f"VERSION SET {args.set}; rebuild dist/ and the .zip, then run --check")
        return 0
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
