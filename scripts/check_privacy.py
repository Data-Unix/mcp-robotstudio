"""Privacy, anonymization, and public-export hygiene gate for MCP-ROBOTSTUDIO.

Checks:
1. Zero occurrences of private student handles or controller instance IDs in
   publicly distributable areas (packages/, referencias/, README.md).
2. Zero un-anonymized Windows user profile paths (C:\\Users\\<real_name>) in
   repository files.
3. Optional local `.privacy-blocklist.txt` check (git-ignored file in repo root)
   against repository files and .rspag deliverables.
4. Structural and privacy integrity of all `practicas/*/entregables/*.rspag`
   deliverables (ZIP testzip(), nested .rsstnx, <Author>usuario</Author>, no user paths).
5. `--self-test`: builds a synthetic .rspag fixture mixing UTF-8, UTF-8-SIG,
   UTF-16 BOM, binary key.id, RAPID identifiers matching the username, and a
   nested ZIP .rsstnx with binary geometry streams, runs `anonymize_rspag.py`,
   and proves bit-for-bit preservation of binary/RAPID entries alongside full
   anonymization of metadata and paths.
"""

from __future__ import annotations

import argparse
import io
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from anonymize_rspag import PRESERVED_USER_DIRS, anonymize_rspag, scan_archive_leaks  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent

FORBIDDEN_PUBLIC_TOKENS = (
    "WIFI-ONL1N3",
    "wifiensuperior",
    "353877553",
    "1AF94AA0-5FF5-4544-BC67-C3259224F409",
)

NEUTRAL_USER_SEGMENTS = PRESERVED_USER_DIRS | {
    "<user>",
    "<usuario>",
    "<perfil>",
    "<real>",
    "<name>",
    "<nombre>",
    "...",
    "\u2026",
}


def _is_neutral_user_segment(seg: str) -> bool:
    lowered = seg.lower()
    if lowered in NEUTRAL_USER_SEGMENTS:
        return True
    # Windows forbids '<' and '>' in folder names, so <placeholder> is never a real profile path.
    return bool(re.fullmatch(r"<[a-z0-9_-]+>", lowered))

WIN_USER_PATH_RE = re.compile(
    r"[A-Za-z]:(?:\\|/)+Users(?:\\|/)+(<[^>]+>|\.\.\.|\u2026|[^\r\n\\/'\"<>|`)]+)(?=(?:\\|/|$|[\s'\"`<>|)]))",
    re.IGNORECASE,
)

SKIP_WALK_DIRS = {
    ".git",
    "node_modules",
    "build",
    "dist",
    "originales_NO_SUBIR",
    "__pycache__",
}

BINARY_CHECK_EXTS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".ico",
    ".rspag",
    ".zip",
    ".pdf",
    ".docx",
    ".xlsx",
    ".exe",
    ".dll",
    ".pdb",
    ".o",
    ".obj",
    ".a",
    ".lib",
    ".wasm",
)


def _is_binary_path(path: Path) -> bool:
    return path.name.lower().endswith(BINARY_CHECK_EXTS)


def _read_text_safe(path: Path) -> str | None:
    if not path.is_file() or _is_binary_path(path):
        return None
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        try:
            return raw.decode("utf-16")
        except UnicodeDecodeError:
            return None
    if b"\x00" in raw:
        return None
    return raw.decode("utf-8", errors="replace")


def iter_candidate_files(root: Path, *, include_dist: bool = False) -> list[Path]:
    git_dir = root / ".git"
    if git_dir.exists():
        try:
            out = subprocess.check_output(
                ["git", "ls-files", "-z"], cwd=root, stderr=subprocess.DEVNULL
            )
            paths: list[Path] = []
            for raw_rel in out.split(b"\x00"):
                if not raw_rel:
                    continue
                p = root / raw_rel.decode("utf-8", errors="replace")
                if p.is_file():
                    paths.append(p)
            return paths
        except (OSError, subprocess.SubprocessError):
            pass

    skip = set(SKIP_WALK_DIRS)
    if include_dist:
        skip.discard("dist")
    collected: list[Path] = []
    for cur_dir, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        base = Path(cur_dir)
        for name in filenames:
            p = base / name
            if p.is_file():
                collected.append(p)
    return collected


def check_public_targets(root: Path) -> list[str]:
    issues: list[str] = []
    targets: list[Path] = []
    for rel in ("packages", "referencias"):
        candidate = root / rel
        if candidate.is_dir():
            for cur_dir, dirnames, filenames in os.walk(candidate):
                dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules"}]
                base = Path(cur_dir)
                for name in filenames:
                    targets.append(base / name)
    readme = root / "README.md"
    if readme.is_file():
        targets.append(readme)

    for path in sorted(targets):
        text = _read_text_safe(path)
        if text is None:
            continue
        lowered = text.lower()
        rel_path = path.relative_to(root).as_posix()
        for token in FORBIDDEN_PUBLIC_TOKENS:
            if token.lower() in lowered:
                issues.append(f"{rel_path}: forbidden public reference '{token}'")
    return issues


def load_local_blocklist(root: Path) -> list[str]:
    blocklist_path = root / ".privacy-blocklist.txt"
    if not blocklist_path.is_file():
        return []
    terms: list[str] = []
    for line in blocklist_path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        terms.append(stripped)
    return terms


def check_user_paths_and_blocklist(root: Path, blocklist: list[str]) -> list[str]:
    issues: list[str] = []
    for path in iter_candidate_files(root):
        rel_path = path.relative_to(root).as_posix()
        if rel_path == ".privacy-blocklist.txt":
            continue
        text = _read_text_safe(path)
        if text is None:
            continue

        for match in WIN_USER_PATH_RE.finditer(text):
            seg = match.group(1).strip().rstrip("\\/")
            if not _is_neutral_user_segment(seg):
                issues.append(f"{rel_path}: un-anonymized Windows user path '{match.group(0)}'")

        if blocklist:
            lowered = text.lower()
            for term in blocklist:
                if term.lower() in lowered:
                    issues.append(f"{rel_path}: matches local privacy blocklist entry")
    return issues


def check_rspag_deliverables(root: Path, blocklist: list[str]) -> list[str]:
    issues: list[str] = []
    for rspag in sorted(root.glob("practicas/*/entregables/*.rspag")):
        if "originales_NO_SUBIR" in rspag.parts:
            continue
        rel_path = rspag.relative_to(root).as_posix()
        scan_issues = scan_archive_leaks(rspag, real="", repl="usuario")
        for issue in scan_issues:
            issues.append(f"{rel_path} -> {issue}")

        with zipfile.ZipFile(rspag, "r") as zf:
            names = {info.filename.lower(): info.filename for info in zf.infolist()}
            if "metadata.xml" in names:
                meta = zf.read(names["metadata.xml"]).decode("utf-8-sig", errors="replace")
                if not re.search(r"<Author>\s*usuario\s*</Author>", meta, re.IGNORECASE):
                    issues.append(f"{rel_path}: Metadata.xml does not contain <Author>usuario</Author>")

            if blocklist:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    raw = zf.read(info.filename)
                    text = raw.decode("utf-8-sig", errors="replace")
                    lowered = text.lower()
                    for term in blocklist:
                        if term.lower() in lowered:
                            issues.append(
                                f"{rel_path}::{info.filename}: matches local privacy blocklist entry"
                            )
    return issues


def run_self_test() -> list[str]:
    issues: list[str] = []
    real_user = "Alumno" + "Secreto"
    short_user = "ALUMNO" + "~1"

    with tempfile.TemporaryDirectory(prefix="mcp_robotstudio_privacy_") as tmp_dir:
        tmp = Path(tmp_dir)
        src_rspag = tmp / "synthetic_in.rspag"
        dst_rspag = tmp / "synthetic_out.rspag"

        metadata_xml = (
            '<?xml version="1.0" encoding="utf-8"?>\r\n'
            f"<MetaData><Author>{real_user}</Author><Comments>Estacion de {real_user}</Comments></MetaData>"
        ).encode("utf-8")

        system_xml_raw = (
            b"\xef\xbb\xbf"
            + (
                '<?xml version="1.0" encoding="utf-8"?>\r\n'
                '<SystemProperties><UsedMedia><Media path="C:\\'
                + "Users\\"
                + real_user
                + '\\AppData\\Local\\ABB\\RobotWare\\RobotWare_6.16.3007" /></UsedMedia></SystemProperties>'
            ).encode("utf-8")
        )

        backinfo_txt_raw = (
            "# Generated backup\r\n"
            "# Originally at: C:\\"
            + "Users\\"
            + short_user
            + "\\Documents\\RobotStudio\\Projects\\Demo\\backup\r\n"
            ">>SYSTEM_ID:\r\nVIRTUAL_USE\r\n"
        ).encode("utf-16")

        key_id_binary = b"\xfe\x50\x05\xe6\x00\xff" + real_user.encode("utf-8") + b"\x00\x01\x02\xab"

        rapid_mod_bytes = (
            "MODULE Module1\r\n"
            f"  PROC {real_user}_Routine()\r\n"
            '    TPWrite "OK";\r\n'
            "  ENDPROC\r\n"
            "ENDMODULE\r\n"
        ).encode("utf-8")

        geom_stream_bytes = b"PK\x03\x04\x00\xffRAW_GEOMETRY_" + real_user.encode("utf-8") + b"\xfe\x00"
        station_xml_bytes = (
            b"\xef\xbb\xbf"
            + (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<Station CreatedBy="' + real_user + '" Path="C:\\' + "Users\\" + real_user + '\\Desktop\\Demo.rsstn" />'
            ).encode("utf-8")
        )

        rsstnx_buf = io.BytesIO()
        with zipfile.ZipFile(rsstnx_buf, "w", compression=zipfile.ZIP_DEFLATED) as zstation:
            zstation.writestr("Station.xml", station_xml_bytes)
            zstation.writestr("Streams/geom.sab.zip", geom_stream_bytes, compress_type=zipfile.ZIP_STORED)
        nested_rsstnx_bytes = rsstnx_buf.getvalue()

        with zipfile.ZipFile(src_rspag, "w", compression=zipfile.ZIP_DEFLATED) as zin:
            zin.writestr("Metadata.xml", metadata_xml)
            zin.writestr("Controller Data/IRB120_3_58/system.xml", system_xml_raw)
            zin.writestr("Controller Data/IRB120_3_58/BACKINFO/backinfo.txt", backinfo_txt_raw)
            zin.writestr(
                "Controller Data/IRB120_3_58/BACKINFO/key.id",
                key_id_binary,
                compress_type=zipfile.ZIP_STORED,
            )
            zin.writestr("Controller Data/IRB120_3_58/RAPID/TASK1/PROGMOD/Module1.mod", rapid_mod_bytes)
            zin.writestr("Station/Estacion.rsstnx", nested_rsstnx_bytes)

        anonymize_rspag(src_rspag, dst_rspag, real=real_user, repl="usuario")

        with zipfile.ZipFile(dst_rspag, "r") as zout:
            if zout.testzip() is not None:
                issues.append("self-test: outer anonymized .rspag failed testzip()")

            if zout.read("Controller Data/IRB120_3_58/BACKINFO/key.id") != key_id_binary:
                issues.append("self-test: binary key.id was modified!")

            if zout.read("Controller Data/IRB120_3_58/RAPID/TASK1/PROGMOD/Module1.mod") != rapid_mod_bytes:
                issues.append("self-test: RAPID Module1.mod identifier was altered!")

            meta_out = zout.read("Metadata.xml").decode("utf-8")
            if "<Author>usuario</Author>" not in meta_out or real_user in meta_out:
                issues.append(f"self-test: Metadata.xml not anonymized properly: {meta_out!r}")

            sys_raw_out = zout.read("Controller Data/IRB120_3_58/system.xml")
            if not sys_raw_out.startswith(b"\xef\xbb\xbf"):
                issues.append("self-test: system.xml lost UTF-8 BOM")
            sys_out = sys_raw_out[3:].decode("utf-8")
            if "\\Users\\usuario\\AppData" not in sys_out or real_user in sys_out:
                issues.append(f"self-test: system.xml not anonymized properly: {sys_out!r}")

            backinfo_raw_out = zout.read("Controller Data/IRB120_3_58/BACKINFO/backinfo.txt")
            if not backinfo_raw_out.startswith(b"\xff\xfe"):
                issues.append("self-test: backinfo.txt lost UTF-16 LE BOM")
            backinfo_out = backinfo_raw_out.decode("utf-16")
            if "\\Users\\usuario\\Documents" not in backinfo_out or short_user in backinfo_out:
                issues.append(f"self-test: backinfo.txt not anonymized properly: {backinfo_out!r}")

            rsstnx_out_bytes = zout.read("Station/Estacion.rsstnx")
            if not zipfile.is_zipfile(io.BytesIO(rsstnx_out_bytes)):
                issues.append("self-test: nested Station/Estacion.rsstnx is no longer a valid ZIP")
            else:
                with zipfile.ZipFile(io.BytesIO(rsstnx_out_bytes), "r") as zst:
                    if zst.testzip() is not None:
                        issues.append("self-test: nested .rsstnx failed testzip()")
                    if zst.read("Streams/geom.sab.zip") != geom_stream_bytes:
                        issues.append("self-test: nested binary Streams/geom.sab.zip was altered!")
                    st_xml = zst.read("Station.xml").decode("utf-8-sig")
                    if (
                        'CreatedBy="usuario"' not in st_xml
                        or "\\Users\\usuario\\Desktop" not in st_xml
                        or real_user in st_xml
                    ):
                        issues.append(f"self-test: nested Station.xml not anonymized: {st_xml!r}")

    return issues


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify privacy hygiene and .rspag anonymizer safety."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=REPO_ROOT,
        help="Repository or exported directory root to audit (default: repo root)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run built-in synthetic .rspag anonymization regression tests",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()

    issues: list[str] = []
    blocklist = load_local_blocklist(root)

    issues.extend(check_public_targets(root))
    issues.extend(check_user_paths_and_blocklist(root, blocklist))
    issues.extend(check_rspag_deliverables(root, blocklist))
    if args.self_test:
        issues.extend(run_self_test())

    if issues:
        print("PRIVACY CHECK FAILED:", file=sys.stderr)
        for item in issues:
            print(f"  - {item}", file=sys.stderr)
        return 1

    checked_parts = ["public-handles", "windows-user-paths", "rspag-deliverables"]
    if blocklist:
        checked_parts.append(f"local-blocklist({len(blocklist)})")
    if args.self_test:
        checked_parts.append("self-test")
    print(f"PRIVACY CHECK OK ({', '.join(checked_parts)}) at {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
