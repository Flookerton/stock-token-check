#!/usr/bin/env python3
"""verify-evidence.py — confirm downloaded evidence files are byte-identical to what was published.

Two ways to run it, both supported:

  1. Release-asset directory — put this script, EVIDENCE-MANIFEST.md and the release assets
     (calibration.csv, evaluation.csv, preregistration.json, meta.json) in one directory:

         python verify-evidence.py

  2. Repository checkout — run it straight from the repo; it finds the manifest in evidence/:

         python scripts/verify-evidence.py

It reads the hashes from EVIDENCE-MANIFEST.md, recomputes them, and exits non-zero on any mismatch.
A missing file is a failure, not a skip: an unverified artifact is not evidence.

Standard library only.
"""
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Where a file may live: beside this script (flat download dir), the repo root,
# the repo's evidence/ directory, or the replay output directory.
SEARCH_BASES = (
    HERE,
    ROOT,
    os.path.join(ROOT, "evidence"),
    os.path.join(ROOT, "replay", "out"),
)


def locate(name: str):
    """Return the first existing path for `name`, or None."""
    for base in SEARCH_BASES:
        candidate = os.path.join(base, name)
        if os.path.exists(candidate):
            return candidate
    return None


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    manifest = locate("EVIDENCE-MANIFEST.md")
    if manifest is None:
        print("FAIL: no EVIDENCE-MANIFEST.md found. Looked in:")
        for base in SEARCH_BASES:
            print(f"  {base}")
        return 2

    text = open(manifest, encoding="utf-8").read()
    # | `name` | size | `hash` |
    rows = re.findall(r"\|\s*`([^`]+)`\s*\|[^|]*\|\s*`([0-9a-f]{64})`\s*\|", text)
    if not rows:
        print("FAIL: no hashes found in the manifest")
        return 2

    bad = 0
    print(f"verifying {len(rows)} file(s) against {manifest}\n")
    for name, expected in rows:
        path = locate(name)
        if path is None:
            print(f"  MISSING  {name}")
            bad += 1
            continue
        actual = sha256(path)
        if actual == expected:
            print(f"  OK       {name}  {actual[:16]}...")
        else:
            print(f"  MISMATCH {name}")
            print(f"           expected {expected}")
            print(f"           actual   {actual}")
            bad += 1

    print()
    if bad:
        print(f"FAILED: {bad} of {len(rows)} file(s) did not verify.")
        return 1
    print(f"PASS: all {len(rows)} file(s) match the published hashes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
