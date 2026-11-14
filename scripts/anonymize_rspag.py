"""Make an anonymized copy of a RobotStudio Pack&Go (.rspag = zip).

RobotStudio writes the author's Windows user name and absolute profile paths
into Metadata.xml, system.xml, BACKINFO/*, rw6system.xml, program.id, and
occasionally Station/*.rsstnx. Unlike naive byte/substring replacement, this
script:
  1. Never patches binary entries (key.id, *.rlf, *.png, Streams/*.zip).
  2. Never alters RAPID source identifiers in .mod/.prg/.sys files (only
     scrubs explicit C:\\Users\\<name>\\ paths if present).
  3. Applies contextual path and XML-author replacements, preserving each
     entry's encoding (UTF-8, UTF-8 BOM, UTF-16 LE/BE, ISO-8859-1) and ZIP
     compression metadata.
  4. Handles nested ZIP-based .rsstnx files properly without corrupting CRCs.
  5. Verifies ZIP integrity (testzip()) and scans text entries for leaks.

Usage:
    python scripts/anonymize_rspag.py <in.rspag> <out.rspag> ["<user folder name>" [<replacement>]]

ALWAYS validate the copy with RobotStudio > Archivo > Compartir > Unpack and Work
with only ONE RobVC process running (stop stale RobVC processes first) before sharing.
Standard library only; never modifies the input file.
"""

from __future__ import annotations

import argparse
import io
import re
import sys
import zipfile
from pathlib import Path

BINARY_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".rlf",
    ".dll",
    ".exe",
    ".bin",
    ".guid",
    ".sab.zip",
    ".gfx.zip",
    ".zip",
)
BINARY_FILENAMES = {"key.id"}
TEXT_EXTENSIONS = (
    ".xml",
    ".txt",
    ".cfg",
    ".rsuser",
    ".rsproj",
    ".rsstnx",
    ".id",
    ".mod",
    ".prg",
    ".sys",
    ".rsf",
)
RAPID_EXTENSIONS = (".mod", ".prg", ".sys")

PRESERVED_USER_DIRS = {
    "public",
    "default",
    "default user",
    "all users",
    "runner",
    "containeradministrator",
    "usuario",
}

USER_PATH_RE = re.compile(
    r"([A-Za-z]:(?:\\|/)+Users(?:\\|/)+)([^\\/\'\"<>|\r\n]+)",
    re.IGNORECASE,
)
AUTHOR_TAG_RE = re.compile(r"(<Author\b[^>]*>)([^<]+)(</Author>)", re.IGNORECASE)
AUTHOR_ATTR_DQ_RE = re.compile(
    r'(\b(?:Author|UserName|CreatedBy|Owner)\s*=\s*")([^"]+)(")',
    re.IGNORECASE,
)
AUTHOR_ATTR_SQ_RE = re.compile(
    r"(\b(?:Author|UserName|CreatedBy|Owner)\s*=\s*')([^']+)(')",
    re.IGNORECASE,
)
XML_TAG_TEXT_RE = re.compile(r"(>)([^<]+)(<)")


def compute_short_name(real: str) -> str:
    compact = real.replace(" ", "")
    if not compact:
        return ""
    return compact[:6].upper() + "~1"


def is_binary_entry(filename: str) -> bool:
    lower = filename.lower()
    basename = Path(lower).name
    if basename in BINARY_FILENAMES:
        return True
    return any(lower.endswith(ext) for ext in BINARY_EXTENSIONS)


def is_text_candidate(filename: str) -> bool:
    if is_binary_entry(filename):
        return False
    lower = filename.lower()
    return any(lower.endswith(ext) for ext in TEXT_EXTENSIONS)


def decode_text_entry(raw: bytes, filename: str) -> tuple[str, str] | None:
    if not is_text_candidate(filename):
        return None
    if raw.startswith(b"\xff\xfe"):
        return raw[2:].decode("utf-16-le"), "utf-16-le-bom"
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be"), "utf-16-be-bom"
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8"), "utf-8-sig"
    if b"\x00" in raw:
        return None
    lower = filename.lower()
    if lower.endswith(".xml") and re.search(
        rb'encoding\s*=\s*["\'](?:iso-8859-1|latin-1)["\']', raw[:160], re.IGNORECASE
    ):
        return raw.decode("latin-1"), "latin-1"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return None


def encode_text_entry(text: str, enc: str) -> bytes:
    if enc == "utf-16-le-bom":
        return b"\xff\xfe" + text.encode("utf-16-le")
    if enc == "utf-16-be-bom":
        return b"\xfe\xff" + text.encode("utf-16-be")
    if enc == "utf-8-sig":
        return b"\xef\xbb\xbf" + text.encode("utf-8")
    if enc == "latin-1":
        return text.encode("latin-1")
    return text.encode("utf-8")


def sanitize_user_paths(text: str, repl: str) -> str:
    preserved = PRESERVED_USER_DIRS | {repl.lower()}

    def _sub(match: re.Match[str]) -> str:
        prefix, user_seg = match.group(1), match.group(2)
        if user_seg.strip().lower() in preserved:
            return match.group(0)
        return f"{prefix}{repl}"

    return USER_PATH_RE.sub(_sub, text)


def _replace_tokens(text: str, tokens: list[str], repl: str) -> str:
    out = text
    for tok in tokens:
        if len(tok) < 2:
            continue
        pattern = re.compile(re.escape(tok), re.IGNORECASE)
        out = pattern.sub(repl, out)
    return out


def sanitize_text_entry(text: str, filename: str, real: str, repl: str) -> str:
    updated = sanitize_user_paths(text, repl)
    lower = filename.lower()

    # Never touch RAPID symbols/identifiers; only C:\Users\... paths above.
    if any(lower.endswith(ext) for ext in RAPID_EXTENSIONS):
        return updated

    preserved = PRESERVED_USER_DIRS | {repl.lower()}

    def _replace_author(match: re.Match[str]) -> str:
        open_tag, value, close_tag = match.group(1), match.group(2), match.group(3)
        if not value.strip() or value.strip().lower() in preserved:
            return match.group(0)
        return f"{open_tag}{repl}{close_tag}"

    updated = AUTHOR_TAG_RE.sub(_replace_author, updated)
    updated = AUTHOR_ATTR_DQ_RE.sub(_replace_author, updated)
    updated = AUTHOR_ATTR_SQ_RE.sub(_replace_author, updated)

    if real:
        short = compute_short_name(real)
        tokens = [t for t in (real, short) if t and t.lower() != repl.lower()]
        basename = Path(lower).name
        if basename == "metadata.xml":
            updated = XML_TAG_TEXT_RE.sub(
                lambda m: f"{m.group(1)}{_replace_tokens(m.group(2), tokens, repl)}{m.group(3)}",
                updated,
            )
        elif basename == "backinfo.txt":
            lines = updated.splitlines(keepends=True)
            updated = "".join(
                _replace_tokens(line, tokens, repl) if line.lstrip().startswith("#") else line
                for line in lines
            )

    return updated


def clone_zip_info(info: zipfile.ZipInfo) -> zipfile.ZipInfo:
    cloned = zipfile.ZipInfo(info.filename, date_time=info.date_time)
    cloned.compress_type = info.compress_type
    cloned.external_attr = info.external_attr
    cloned.create_system = info.create_system
    return cloned


def anonymize_zip_stream(
    in_stream: io.BufferedIOBase,
    out_stream: io.BufferedIOBase,
    real: str,
    repl: str,
    prefix: str = "",
) -> list[str]:
    changed: list[str] = []
    with zipfile.ZipFile(in_stream, "r") as zin, zipfile.ZipFile(out_stream, "w") as zout:
        for info in zin.infolist():
            entry_label = f"{prefix}{info.filename}"
            if info.is_dir():
                zout.writestr(clone_zip_info(info), b"")
                continue

            raw = zin.read(info.filename)
            data = raw

            if info.filename.lower().endswith(".rsstnx") and zipfile.is_zipfile(io.BytesIO(raw)):
                nested_in = io.BytesIO(raw)
                nested_out = io.BytesIO()
                nested_changed = anonymize_zip_stream(
                    nested_in, nested_out, real=real, repl=repl, prefix=f"{entry_label}::"
                )
                if nested_changed:
                    data = nested_out.getvalue()
                    changed.extend(nested_changed)
            else:
                decoded = decode_text_entry(raw, info.filename)
                if decoded is not None:
                    text, enc = decoded
                    new_text = sanitize_text_entry(text, info.filename, real=real, repl=repl)
                    if new_text != text:
                        data = encode_text_entry(new_text, enc)
                        changed.append(f"{entry_label} ({enc})")

            zout.writestr(clone_zip_info(info), data, compress_type=info.compress_type)
    return changed


def scan_archive_leaks(
    zip_source: str | Path | io.BytesIO,
    real: str,
    repl: str,
    prefix: str = "",
) -> list[str]:
    issues: list[str] = []
    preserved = PRESERVED_USER_DIRS | {repl.lower()}
    tokens = [t for t in (real, compute_short_name(real)) if real and len(t) >= 2]

    with zipfile.ZipFile(zip_source, "r") as zf:
        bad_entry = zf.testzip()
        if bad_entry is not None:
            issues.append(f"{prefix}{bad_entry}: CRC/ZIP integrity check failed")

        for info in zf.infolist():
            if info.is_dir():
                continue
            entry_label = f"{prefix}{info.filename}"
            raw = zf.read(info.filename)

            if info.filename.lower().endswith(".rsstnx") and zipfile.is_zipfile(io.BytesIO(raw)):
                issues.extend(
                    scan_archive_leaks(
                        io.BytesIO(raw), real=real, repl=repl, prefix=f"{entry_label}::"
                    )
                )
                continue

            decoded = decode_text_entry(raw, info.filename)
            if decoded is None:
                continue
            text, _ = decoded

            for match in USER_PATH_RE.finditer(text):
                if match.group(2).strip().lower() not in preserved:
                    issues.append(f"{entry_label}: un-anonymized path '{match.group(0)}'")

            lower = info.filename.lower()
            if any(lower.endswith(ext) for ext in RAPID_EXTENSIONS):
                continue

            for match in AUTHOR_TAG_RE.finditer(text):
                author = match.group(2).strip()
                if author and author.lower() not in preserved:
                    issues.append(f"{entry_label}: non-anonymous <Author>{author}</Author>")

            for attr_re in (AUTHOR_ATTR_DQ_RE, AUTHOR_ATTR_SQ_RE):
                for match in attr_re.finditer(text):
                    author = match.group(2).strip()
                    if author and author.lower() not in preserved:
                        issues.append(
                            f"{entry_label}: non-anonymous author attribute '{match.group(0)}'"
                        )

            if tokens:
                basename = Path(lower).name
                metadata_targets = {
                    "metadata.xml",
                    "system.xml",
                    "backinfo.txt",
                    "program.id",
                    "rw6system.xml",
                }
                if basename in metadata_targets or lower.endswith(".rsstnx"):
                    lowered = text.lower()
                    for tok in tokens:
                        if tok.lower() in lowered and tok.lower() != repl.lower():
                            issues.append(f"{entry_label}: contains token '{tok}'")
    return issues


def anonymize_rspag(src: Path, dst: Path, real: str = "", repl: str = "usuario") -> list[str]:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(src, "rb") as fin, open(dst, "wb") as fout:
        changed = anonymize_zip_stream(fin, fout, real=real, repl=repl)
    issues = scan_archive_leaks(dst, real=real, repl=repl)
    if issues:
        raise RuntimeError(
            "Anonymization check failed for "
            f"{dst}:\n  - " + "\n  - ".join(issues)
        )
    return changed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Safely anonymize a RobotStudio Pack&Go (.rspag) archive."
    )
    parser.add_argument("input_rspag", type=Path, help="Input .rspag path (read-only)")
    parser.add_argument("output_rspag", type=Path, help="Output anonymized .rspag path")
    parser.add_argument(
        "user_folder",
        nargs="?",
        default="",
        help="Optional Windows user folder/author name to verify and scrub from metadata",
    )
    parser.add_argument(
        "replacement",
        nargs="?",
        default="usuario",
        help="Replacement placeholder (default: usuario)",
    )
    args = parser.parse_args(argv)

    try:
        changed = anonymize_rspag(
            args.input_rspag, args.output_rspag, real=args.user_folder, repl=args.replacement
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print("changed entries:")
    if changed:
        for item in changed:
            print("  ", item)
    else:
        print("   (none)")
    print("remaining occurrences: NONE (ZIP integrity verified)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
