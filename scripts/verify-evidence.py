#!/usr/bin/env python3
"""verify-evidence.py — confirm downloaded evidence files are byte-identical to what was published.

Put this script and the release assets in the same directory, then:

    python verify-evidence.py

It reads the hashes from EVIDENCE-MANIFEST.md, recomputes them, and exits non-zero on any mismatch.
A missing file is a failure, not a skip: an unverified artifact is not evidence.

Standard library only.
"""
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "EVIDENCE-MANIFEST.md")


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not os.path.exists(MANIFEST):
        print(f"FAIL: no manifest at {MANIFEST}")
        return 2

    text = open(MANIFEST, encoding="utf-8").read()
    # | `name` | size | `hash` |
    rows = re.findall(r"\|\s*`([^`]+)`\s*\|[^|]*\|\s*`([0-9a-f]{64})`\s*\|", text)
    if not rows:
        print("FAIL: no hashes found in the manifest")
        return 2

    bad = 0
    print(f"verifying {len(rows)} file(s) against {os.path.basename(MANIFEST)}\n")
    for name, expected in rows:
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
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
