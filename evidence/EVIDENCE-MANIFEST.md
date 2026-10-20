# Evidence manifest

The two raw CSVs are too large for the repository, so they are published as release assets and
anchored here by SHA-256. Everything else — code, rules, report, thresholds — is in the repo.

Download the release assets next to `scripts/verify-evidence.py` and run it; it recomputes these
hashes and exits non-zero on any mismatch.

| file | size | SHA-256 |
|---|---:|---|
| `calibration.csv` | 109.8 MB | `72063102439e5f23ef25af128a1713b96954910e07cf77c5cdc56e58067b06db` |
| `evaluation.csv` | 113.4 MB | `343a5b5aafc535072a0bec4e338d500e78a8c9e5dc38801c6f6430c5cb758e10` |
| `preregistration.json` | 11,715 B | `50e4adde53e019c9e39c2e4a3d63c9232ca6134940e530dcf7e2ef7a12657fc3` |
| `meta.json` | 2,938 B | `5a0ea059425e4734ec2bb79d9caa2c815012fa906ee62f7fa9815f86f843cf36` |

## What each file is

- `calibration.csv` — 2026-08-16..2026-09-14, 302,400 rows, 35 tokens. Used ONLY to set thresholds.
  Never re-read for the decision.
- `evaluation.csv` — 2026-09-15..2026-10-14, 302,400 rows, 35 tokens. The decision data.
- `preregistration.json` — the frozen rulebook: universe, window, thresholds, definitions, the
  rules the replay cannot test. Committed before the evaluation run started.
- `meta.json` — written by the evaluation run: universe, method, block range, RPC providers, code
  commit, thresholds, CSV SHA-256, structural invariants, read-failure counts.

## Structural invariants asserted on evaluation.csv

8,640 rows per token, 8,640 distinct sample times, 0 duplicate (token, sample-time) pairs, all 35
tokens present, `errorsSwallowed: 0`. A hash proves a file is unchanged; these prove it is
well-formed.
