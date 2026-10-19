# The exact replay code — commit `f4ebac0`

This directory is a **byte-identical snapshot** of the code that produced `evaluation.csv`. It is not
a cleaned-up version and not a re-implementation: `replay/run.ts` and `src/*.ts` here are the files
from commit `f4ebac0c30373f15731e9668386a5a3bf5e58a4e` of the private working repository, copied by
`git archive` rather than by hand.

The `replay/` and `src/` layout is preserved **inside this directory** because the runner imports
`../src/*.ts` and reads `replay/feed-map.json` relative to its working directory. Changing the layout
would mean editing the code, which is exactly what this folder exists to avoid.

## What this code is

| File | Role |
|---|---|
| `replay/run.ts` | The sampler. Walks the window at 5-minute steps, resolves the block at or before each sample, reads every token in one batched multicall, applies the rules, appends a CSV row per token per sample. |
| `src/snapshot.ts`, `src/rpc.ts`, `src/blocks.ts` | Archive `eth_call` + Multicall3 readers, the block estimator, the response cache. |
| `src/rules.ts` | The rule set that produced the codes in the CSV. |
| `src/sessions.ts` | The market calendar (session labels). |
| `src/policy.ts`, `src/types.ts` | Thresholds and the `Snapshot` / `Verdict` types. |
| `src/pools.ts` | The pool reference. **Used by the replay**, and the cause of the `POOL_*` codes. |
| `calendar/nyse-holidays.json` | NYSE closures and early closes, 2026–2027. |
| `replay/feed-map.json` | The 35 tokens and their feed/token addresses as of the run. |

## Reproducing the CSV

Requirements: Node 18+, about 2 GB of free disk for the response cache, and network access to a public
archive RPC for chain 4663. No account or key is needed; the endpoints are in `src/chain.ts`.

```bash
cd replay/f4ebac0
npm install                 # tsx, typescript, viem

npx tsx replay/run.ts \
  --from 2026-09-15T00:00:00Z \
  --to   2026-10-14T23:59:59Z \
  --out  replay/out/evaluation.csv \
  --prereg ../../evidence/preregistration.json \
  --req 2
```

Then check the hash:

```bash
sha256sum replay/out/evaluation.csv
# 343a5b5aafc535072a0bec4e338d500e78a8c9e5dc38801c6f6430c5cb758e10
```

and the run's own record of it:

```bash
python -c "import json;d=json.load(open('replay/meta.json'));print(d['csv']['sha256'], d['codeCommit'])"
```

### What to expect

- **About 22 hours** on a cold cache at the run's polite 2 requests/second. The archive providers ban
  bursts, so the run backs off and retries rather than pushing harder.
- **A warm cache makes reruns fast and deterministic.** Every response is cached by
  `(method, params)` including the block tag, so a second run over the same window replays from disk
  and produces the same bytes. That is how the hash is reproducible at all.
- **The run refuses to start from a dirty working tree** (working rule 11 — evidence must be tied to
  a revision). The `.gitignore` here covers `replay/out/`, `replay/cache/`, `replay/meta.json` and
  `node_modules/`, so a run does not dirty the repository. If you edit anything, commit or stash first.
- **Do not delete or edit `replay/cache/` casually.** It is regenerable from the chain, but rebuilding
  it costs the full ~22 hours.

### Structural checks the run performs itself

At the end, `run.ts` asserts 8,640 rows per token, 8,640 distinct sample times, zero duplicate
(token, sample-time) pairs, all 35 tokens present, and `errorsSwallowed === 0`. It exits non-zero if
any of those fail — a malformed CSV cannot pass as a finished run.

## What produced the decision

- `replay/out/evaluation.csv` — the rows
- `replay/meta.json` — universe, window, block range, providers, code commit, thresholds, CSV hash,
  invariants
- `evidence/preregistration.json` — the thresholds and definitions, frozen before the run
- `report/report.md` — the scoring and the decision

The scoring scripts (`score-evaluation.py`, `evaluation-jumps.py`, `spot-check.py`) live in the
private working repository, not here: they read this CSV and do not affect how it was produced.
`report/report.md` states the definitions they implement.
