# Does a naive agent get a safe price? A 30-day replay of 35 Robinhood Stock Tokens

**Result: STOP.** By the rules fixed before the test window was opened, the hazard this check exists
to catch was too rare to justify a paid service. This library is the part worth keeping.

- **Window:** 2026-09-15 → 2026-10-14 (UTC), every 5 minutes
- **Universe:** 35 tokens with a Chainlink feed on Robinhood Chain (chain id 4663)
- **Samples:** 302,400 (35 × 8,640)
- **Calibration window (separate):** 2026-08-16 → 2026-09-14, used to set thresholds and never
  re-read for the decision
- **Evidence:** `evaluation.csv`, SHA-256 `343a5b5aafc535072a0bec4e338d500e78a8c9e5dc38801c6f6430c5cb758e10`

---

## 1. Plain-English summary

The question was: if a naive agent accepted a Stock Token price without checking anything, how often
would it be acting on a price that was unsafe or materially wrong?

**By the pre-registered rules: rarely enough to stop.**

- The price was **unsafe for a reason other than the market being closed** on **0.017%** of samples
  (51 of 302,400). The stop threshold was 2%.
- The price was **materially wrong** — unsafe, and more than 3% away from what the feed said next —
  on **0.000%** of samples. The stop threshold was 0.5%.

Both conditions for stopping were met, so the pre-registered answer is STOP.

**That 0.000% is a floor, and the reason matters.** "What the feed said next" means the *first* feed
update after the sample. At a market reopen that first update is a **smoothed average** by design, so
it understates how far the price had actually moved. Measured against later updates the same figure
rises to 0.19% (2nd), 0.38% (3rd), 0.75% (5th) and 1.31% (6th). The decision above uses the first
update, as pre-registered. The rest is a **post-hoc sensitivity check, clearly labelled, and not a
decision input**.

**What drove the gap between the calibration month (1.71%) and this one (0.00%) was one event.** The
largest reopen gap in this month was +2.50% (INTC, over a 51.8-hour weekend). The calibration month
contained a 5.02% gap (SNDK). The materially-wrong share is not a smooth rate — it is "did a weekend
produce a gap over 3%", and each such event contributes hundreds of rows at once.

**The prices themselves were fine.** The feed was never stale during an open session, never paused,
never sequencer-stalled, and no multiplier change was pending at any sample.

---

## 2. Method

At each 5-minute sample, for each token, read on-chain state **at the last block at or before the
sample time** — never after it:

- the feed's `latestRoundData()` (answer, `updatedAt`);
- `oraclePaused()`, `tokenPaused()`, `paused()`, `uiMultiplier()`, `newUIMultiplier()`,
  `effectiveAt()`;
- block production, from block numbers and timestamps.

Session labels come from the library's own `src/sessions.ts`, which is the same code the released
library uses. A failed read is recorded as **null and counted**, never as a default value, and any
verdict depending on it becomes `SOURCE_UNAVAILABLE`.

The replay used archive `eth_call` and Multicall3 at ~2 requests/second; the full window took about
22 hours. Structural invariants were asserted at the end: 8,640 rows per token, 8,640 distinct sample
times, zero duplicate pairs — all passed. `errorsSwallowed: 0`.

**Point-in-time rule.** Every measurement uses only data at or before the sample's block. This was
learned the hard way: an earlier calibration run selected *today's* busiest pool for every token and
applied it to blocks up to 37 days before that pool existed, producing 81,257 failed pool reads that
looked like data.

### Thresholds and how they were set

| Threshold | Value | Source |
|---|---|---|
| `SEQUENCER_STALE_SEC` | 60 s (provisional) | no stall observed; conservative bound |
| `FEED_HEARTBEAT_SEC` | 86,400 s | Chainlink listing, all feeds |
| `FEED_HEARTBEAT_GRACE_SEC` | 600 s | `FEED_STALE_OPEN` fires at heartbeat + 600 s |
| `FEED_DEVIATION_BPS` | 50 bps | Chainlink listing |
| `MULTIPLIER_MATERIAL_BPS` | 50 bps | same scale as feed deviation |
| Materially wrong | > 300 bps from the next feed update | fixed before the window |

### Preregistration

`evidence/preregistration.json` was committed **before** the evaluation run started:

- preregistration commit `f4ebac0c…`, 2026-10-18T03:36:26Z
- run started 2026-10-18T03:37:29Z — **63 seconds later**
- the run's `meta.json` records `codeCommit: f4ebac0c…`

No threshold, definition or line of measurement code changed after the window was first read.

### Definitions

A sample is **unsafe** if any of `SEQUENCER_STALE`, `ORACLE_PAUSED`, `MULTIPLIER_PENDING`,
`FEED_STALE_OPEN`, `MARKET_CLOSED` or `FEED_AWAITING_REOPEN_UPDATE` applies.

A sample is **materially wrong** if it is unsafe **and** the served price is more than 300 bps from
the feed value at the next update after that sample.

**Coverage.** A sample with no next update cannot be judged, so it is excluded from the denominator
rather than counted as "not wrong" (R1). Coverage is printed with every share. `REFERENCE_UNAVAILABLE`
and `SOURCE_UNAVAILABLE` never count as unsafe (R2) — those are our gaps, not hazards to a caller.

---

## 3. Results

### The decision

| Condition | Measured | Threshold | Result |
|---|---:|---:|---|
| Materially wrong (next-feed only) | **0.000%** | < 0.5% | met |
| Unsafe excluding `MARKET_CLOSED` | **0.017%** (51 rows) | < 2% | met |

**Both met → STOP.**

`ref_feed_next` exists for 298,546 of 302,400 rows (98.73%). The 35 samples at the very end of the
window have no later update inside it; they are excluded, not counted as safe.

### Unsafe, by code

| Code | Rows | Notes |
|---|---:|---|
| `MARKET_CLOSED` | 79,975 | all CLOSED_WEEKEND; expected |
| `POOL_DEVIATION` | 45,185 | secondary, see §5 |
| `SOURCE_UNAVAILABLE` | 3,010 | our read failures; reported, never unsafe |
| `FEED_AWAITING_REOPEN_UPDATE` | **51** | all OVERNIGHT; the only non-closure unsafe rows |
| `SEQUENCER_STALE`, `ORACLE_PAUSED`, `FEED_STALE_OPEN`, `MULTIPLIER_PENDING`, `TOKEN_PAUSED`, `REGISTRY_PAUSED`, `POOL_THIN`, `REFERENCE_UNAVAILABLE` | **0** | never fired |

**`ORACLE_PAUSED` never fires.** The rule exists and is implemented, but this replay provides no
evidence about it. It should not be assumed to work in the field because it is in the list.

### Post-hoc sensitivity check — NOT a decision input

Same definition, but the deviation measured against the *k*-th distinct feed update after the sample
instead of the first. **This is not preregistered.** Later updates also include genuine price moves
after the reopen, so they overstate the frozen price's error in the other direction.

| Reference update | Rows > 300 bps | % of all rows |
|---|---:|---:|
| #1 (preregistered) | 0 | 0.000% |
| #2 | 562 | 0.186% |
| #3 | 1,137 | 0.376% |
| #4 | 1,124 | 0.372% |
| #5 | 2,260 | 0.747% |
| #6 | 3,970 | 1.313% |

The honest reading: the frozen-price error at a reopen is somewhere between 0.0% and roughly 1.3%
of samples depending on how long after the reopen you measure, and the pre-registered definition sits
at the low end because it uses the most heavily smoothed update.

---

## 4. Findings worth sharing

### The calendar traps

Two separate calendar bugs, both of which changed real answers:

1. **Friday 16:00–20:00 ET was being labelled "closed weekend".** Robinhood's 24 Hour Market runs to
   Friday 20:00 ET, so that window is **post-market, open**. A naive weekend rule closes it and
   reports `MARKET_CLOSED` on a live session.
2. **Holiday evenings reopen.** A full-day closure ends at 20:00 ET, and the overnight session then
   trades toward the next day. Treating the whole holiday as closed gets that evening wrong.

This was invisible until the analysis stopped re-implementing the calendar and called the module that
both the replay and the service use. The re-implementation used Python's `weekday()` (Monday=0) where
the module uses Sunday=0, which relabelled 31% of rows — and it agreed with nothing in particular,
which is exactly why the real bug had survived.

### "Deepest pool" picked pools that do not trade

Pool selection ranked by depth. Six of 35 selected pools executed **zero swaps** in a 24-hour count.
An earlier version of that finding said eight; two of those pool addresses had not been deployed when
the count ran, and a log query against a non-existent contract **succeeds and returns nothing** —
indistinguishable from a real zero. The corrected number is six.

### Pools appeared during the test window, and selection looked ahead

New pools kept being created during the period — CRWV's first pool appeared inside the evaluation
window. Worse, the selection used a token's pool as of *today* against sample blocks from weeks
earlier: **81,257 of 302,400 calibration samples** referenced a pool that did not exist at that block.
Every one of those reads failed. The fix is not "exclude missing pools" but "at block B, only pools
created at or before B are candidates".

### About five minutes of on-chain notice before a multiplier change

A staged `uiMultiplier` becomes visible on-chain roughly 5–10 minutes before it takes effect. That is
enough notice to warn a caller, and it sets how often a live checker must re-read these values. It is
not enough to be a 24-hour warning, so a 24-hour rule would never fire.

### Two feeds Chainlink's page does not list

Chainlink's published Robinhood listing has 33 equity feeds. Two more Stock Tokens (SGOV, USAR) have
working feed contracts on-chain that the page omits. They are included, marked as not listed, with
parameters **assumed** to match the listing's uniform values.

### A rule that could never have fired

The original stale-price rule was "heartbeat + 10%". Every feed publishes a 24-hour heartbeat, so the
bound came out at 26.4 hours — and no intraday equity feed goes 26 hours without publishing. The
product's central check would have been inert. It is now a heartbeat backstop plus a reopen rule.

---

## 5. Secondary, not part of the decision: the pool reference

The pool reference was under repair when the decision was made, so it was excluded from the go/no-go.
It is reported here for completeness, not as evidence about the feed.

| Measure | Value |
|---|---:|
| Rows marked `POOL_DEVIATION` | 45,185 (14.94%) |
| Materially wrong by pool only | 11,765 (3.891%) |
| Pool coverage among unsafe rows | 95.0% |
| Failed pool sub-calls | 12,802 |

**The disagreement is the finding.** On the same 11,765 rows where the pool was more than 3% away
from the feed, the feed's own next update agreed with the served price to within 2.50% at worst and
was within 3% on every closed-market row. A reference that disagrees with the traded price is the
reference that is wrong.

That is why the pool check is off by default in the released library.

---

## 6. Rules the replay cannot test

These inputs are live-only. They are **not** validated by this replay, and the result above must not
be read as implying they were:

| Input | Rule |
|---|---|
| Robinhood corporate-action status | `CORP_ACTION_IN_PROGRESS` |
| Robinhood trading-halt flag | `TRADING_HALT` |
| Robinhood per-asset trading capabilities | `SESSION_NOT_TRADABLE`, `CAPABILITIES_UNKNOWN` |
| Robinhood current multiplier vs on-chain | `MULTIPLIER_MISMATCH` |
| Robinhood mid price vs feed | `FEED_DIVERGES_FROM_MARKET` |
| Robinhood sequencer websocket | `SEQUENCER_STALE` (live signal; the replay infers from block production) |
| Venue blocklist | `VENUE_BLOCKED` (registry address still unverified) |

Also untested by observation: **`ORACLE_PAUSED` did not fire once**, so that rule has no evidence
behind it.

---

## 7. Limitations

- **One month, one market.** 302,400 samples sounds like a lot, but the materially-wrong share is
  driven by a handful of reopen events. A single quiet month cannot separate "safe" from "lucky".
- **The reference is smoothed at reopens.** The preregistered figure is a floor.
- **35 tokens, not 195.** Only these have a Chainlink feed; the rest return `NO_FEED`.
- **No pool check in the default library.** See §5.
- **The frozen-price question is not the only hazard.** Trades can fail for reasons this replay
  cannot see: halts, account restrictions, venue rules.
- **The calendar is data.** It covers 2026–2027 and the library refuses to answer outside that range,
  but it still needs updating.

---

## 8. Reproducing this

1. `evidence/preregistration.json` — the frozen rulebook, committed 63 seconds before the run started.
2. `evidence/meta.json` — universe, window, code commit, thresholds, CSV SHA-256, invariants.
3. `evaluation.csv` and `calibration.csv` — the raw evidence (release assets; too large for the repo).
4. `scripts/verify-evidence.py` — checks the downloaded files against the recorded hashes.

The replay needs archive access to chain 4663 and about a day of wall-clock time per 30-day window.
The library and its 49 tests need no network at all.
