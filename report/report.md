# Does a naive agent get a safe price? A 30-day replay of 35 Robinhood Stock Tokens

**Result: STOP.** By the rules fixed before the test window was opened, the hazard this check exists
to catch was too rare to justify a paid service. This library is the part worth keeping.

- **Window:** 2026-09-15 to 2026-10-14 (UTC), every 5 minutes
- **Universe:** 35 tokens with a Chainlink feed on Robinhood Chain (chain id 4663)
- **Samples:** 302,400 (35 × 8,640)
- **Calibration window (separate):** 2026-08-16 to 2026-09-14, used to set thresholds
- **Evidence:** `evaluation.csv`, SHA-256 `343a5b5aafc535072a0bec4e338d500e78a8c9e5dc38801c6f6430c5cb758e10`

---

## 1. Plain-English summary

The question was: if a naive agent accepted a Stock Token price without checking anything, how often
would it be acting on a price that was unsafe or materially wrong?

**By the pre-registered rules: rarely enough to stop.**

- The price was **unsafe for a reason other than the market being closed** on **0.017%** of samples
  (51 of 302,400). The stop threshold was 2%.
- The price was **materially wrong**, meaning unsafe and more than 3% away from what the feed said
  next, on **0.000%** of samples. The stop threshold was 0.5%.

Both conditions for stopping were met, so the pre-registered answer is STOP.

**That 0.000% is a floor, and the reason matters.** "What the feed said next" means the *first*
feed update after the sample. At a market reopen that first update is a **smoothed average** by
design, so it understates how far the price had actually moved. Measured against later updates the
same figure rises to 0.19% (2nd), 0.38% (3rd), 0.75% (5th) and 1.31% (6th). The decision above uses
the first update, as pre-registered. The rest is a **post-hoc sensitivity check, clearly labelled,
and not a decision input**. Later updates also include genuine moves after the reopen, so they
overstate the error as well as correcting the smoothing.

**What drove the gap between the calibration month (1.71%) and this one (0.00%) was one event.** The
largest reopen gap in this month was +2.50% (INTC, over a 51.8-hour weekend). The calibration month
contained a 5.02% gap (SNDK). The materially-wrong share is not a smooth rate. It is "did a weekend
produce a gap over 3%", and each such event contributes hundreds of rows at once.

**Apart from weekend closures, no rule fired:**

- the feed was never older than its heartbeat during an open session;
- it was never paused;
- the sequencer never stalled;
- no multiplier change was pending at any sample.

The reopen gaps sit beside that: the largest was +2.50%, and none reached 3% in this month.

---

## 2. Method

At each 5-minute sample, for each token, read on-chain state **at the last block at or before the
sample time**, never after it:

- the feed's `latestRoundData()` (answer, `updatedAt`);
- `oraclePaused()`, `tokenPaused()`, `paused()`, `uiMultiplier()`, `newUIMultiplier()`,
  `effectiveAt()`;
- block production, from block numbers and timestamps.

Session labels come from the library's own `src/sessions.ts`. A failed read is recorded as **null and
counted**, never as a default value, and any verdict depending on it becomes `SOURCE_UNAVAILABLE`.

**Point in time: exactly what it means here.** Every *verdict input* uses only data at or before the
sample's block. The *label* used to judge "materially wrong" uses the feed's next update **by
design**, because that is the ground truth for whether the served price was right. The label looks
forward; the rules never do.

The replay used archive `eth_call` and Multicall3 at about 2 requests/second; the full window took
about 22 hours. Structural invariants were asserted at the end: 8,640 rows per token, 8,640 distinct
sample times, zero duplicate pairs, all passed. `errorsSwallowed: 0`.

### A definition change made before the window was read

The original design judged "materially wrong" against a trading pool. The calibration month showed
that reference was unreliable, so before the evaluation window was read the rule was changed to use
the feed's next update instead.

### Thresholds and how they were set

| Threshold | Value | Source |
|---|---|---|
| `SEQUENCER_STALE_SEC` | 60 s (provisional) | no stall observed; conservative bound |
| `FEED_HEARTBEAT_SEC` | 86,400 s | Chainlink listing (33 feeds); assumed for SGOV and USAR |
| `FEED_HEARTBEAT_GRACE_SEC` | 600 s | `FEED_STALE_OPEN` fires at heartbeat + 600 s |
| `FEED_DEVIATION_BPS` | 50 bps | Chainlink listing (33 feeds); assumed for SGOV and USAR |
| `MULTIPLIER_MATERIAL_BPS` | 50 bps | same scale as feed deviation |
| Materially wrong | > 300 bps from the next feed update | fixed before the window |

### Preregistration

`evidence/preregistration.json` was committed **before** the evaluation run started:

- preregistration commit `f4ebac0c...`, 2026-10-18T03:36:26Z
- run started 2026-10-18T03:37:29Z, **63 seconds later**
- the run's `meta.json` records `codeCommit: f4ebac0c...`

No threshold, definition or line of the code that produced the decision changed after the window was
first read. The sensitivity check in §3 was written afterwards and is labelled as such.

*On wording:* `preregistration.json` is published byte-identical to the frozen file, and it refers to
the project's reviewer as the "orchestrator". That is the review role the decisions came from, not a
service, a system, or a person's name.

### Definitions

A sample is **unsafe** if any of `SEQUENCER_STALE`, `ORACLE_PAUSED`, `MULTIPLIER_PENDING`,
`FEED_STALE_OPEN`, `MARKET_CLOSED` or `FEED_AWAITING_REOPEN_UPDATE` applies.

A sample is **materially wrong** if it is unsafe **and** the served price is more than 300 bps from
the feed value at the next update after that sample.

**Coverage.** A sample with no next update cannot be judged, so it is excluded from the denominator
rather than counted as "not wrong" (R1). Coverage is printed with every share. `REFERENCE_UNAVAILABLE`
and `SOURCE_UNAVAILABLE` never count as unsafe (R2): those are our gaps, not hazards to a caller.

---

## 3. Results

### The decision

| Condition | Measured | Threshold | Result |
|---|---:|---:|---|
| Materially wrong (next-feed only) | **0.000%** | < 0.5% | met |
| Unsafe excluding `MARKET_CLOSED` | **0.017%** (51 rows) | < 2% | met |

**Both met: STOP.**

### Coverage, and the label tail

302,400 rows total. The first pass found a next update for 298,546 of them, leaving 3,854
unlabelled. That 3,854 breaks down exactly as follows:

| Rows | Why unlabelled | Can a tail fix it? |
|---:|---|---|
| 3,010 | no feed read at all (`SOURCE_UNAVAILABLE`), 86 sample times × 35 tokens | **No.** There is no `updatedAt` to search from. |
| 844 | a valid `updatedAt`, but no later update inside the window | **Yes.** This is the tail case. |

**The preregistered label tail was not applied in the first pass. That is a departure from the
preregistration, and it has now been corrected.** The tail allows feed reads for up to 96 hours after
2026-10-14, used only to label the last samples. Applying it, by binary-searching the tail for the
first round whose `updatedAt` exceeds the window's last update, labelled **all 844** rows.

**Effect on the result: none.**

| | rows with `ref_feed_next` | share of all rows | materially wrong |
|---|---:|---:|---:|
| first pass, no tail | 298,546 | 98.73% | 0.000% |
| **with the tail applied** | **299,390** | **99.00%** | **0.000%** |

The remaining 3,010 rows are `SOURCE_UNAVAILABLE`, which never counts as unsafe (R2). The 844 rows
are all open-session samples (POST_MARKET 481, REGULAR 202, OVERNIGHT 95, PRE_MARKET 66), because the
window ends at 19:59 ET on a Wednesday; none of them is unsafe either. So neither share moves, and the
decision is unchanged.

Within the unsafe rows, the denominator is 80,026 and `ref_feed_next` covers **100.0%** of them after
the tail. That is why the headline coverage reads 100% while overall coverage reads 99.00%.

### Codes that fired

| Code | Rows | Counts as unsafe? | Notes |
|---|---:|:--:|---|
| `MARKET_CLOSED` | 79,975 | yes | all CLOSED_WEEKEND; expected |
| `POOL_DEVIATION` | 45,185 | **no** | secondary, see §5; belongs to "materially wrong" |
| `SOURCE_UNAVAILABLE` | 3,010 | **no** | our read failures, reported under R2 |
| `FEED_AWAITING_REOPEN_UPDATE` | **51** | **yes** | all OVERNIGHT; the only non-closure unsafe rows |
| `SEQUENCER_STALE` | 0 | yes | never fired |
| `ORACLE_PAUSED` | 0 | yes | never fired |
| `FEED_STALE_OPEN` | 0 | yes | never fired |
| `MULTIPLIER_PENDING` | 0 | yes | never fired |
| `TOKEN_PAUSED`, `REGISTRY_PAUSED` | 0 | yes | never fired |
| `POOL_THIN`, `REFERENCE_UNAVAILABLE` | 0 | no | never fired |

**`ORACLE_PAUSED` never fires.** The rule exists and is implemented, but this replay provides no
evidence about it. It should not be assumed to work in the field because it is in the list.

### Post-hoc sensitivity check, NOT a decision input

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

The honest reading: the frozen-price error at a reopen is somewhere between 0.0% and roughly 1.3% of
samples depending on how long after the reopen you measure, and the pre-registered definition sits at
the low end because it uses the most heavily smoothed update.

---

## 4. Findings worth sharing

### The calendar traps

Two separate calendar bugs, both of which changed real answers:

1. **Friday 16:00 to 20:00 ET was being labelled "closed weekend".** Robinhood's 24 Hour Market runs
   to Friday 20:00 ET, so that window is **post-market, open**. A naive weekend rule closes it and
   reports `MARKET_CLOSED` on a live session.
2. **Holiday evenings reopen.** A full-day closure ends at 20:00 ET, and the overnight session then
   trades toward the next day. Treating the whole holiday as closed gets that evening wrong.

Both were found only when the analysis stopped re-implementing the calendar and called the library
instead.

### "Deepest pool" picked pools that do not trade

Pool selection ranked by depth. Six of 35 selected pools executed **zero swaps** in a 24-hour count.
An earlier version of that finding said eight; two of those pool addresses had not been deployed when
the count ran, and a log query against a non-existent contract **succeeds and returns nothing**,
indistinguishable from a real zero. The corrected number is six.

### Pools appeared during the test window, and selection looked ahead

New pools kept being created during the period; CRWV's first pool appeared inside the evaluation
window. Worse, the selection used a token's pool as of *today* against sample blocks from weeks
earlier: **81,257 of 302,400 calibration samples** referenced a pool that did not exist at that block.
Every one of those reads failed. The fix is not "exclude missing pools" but "at block B, only pools
created at or before B are candidates".

### About five minutes of on-chain notice before a multiplier change

A staged `uiMultiplier` becomes visible on-chain roughly 5 to 10 minutes before it takes effect. That
is enough notice to warn a caller, and it sets how often a live checker must re-read these values. It
is not enough to be a 24-hour warning, so a 24-hour rule would never fire.

### Two feeds Chainlink's page does not list

Chainlink's published Robinhood listing has 33 equity feeds. Two more Stock Tokens (SGOV, USAR) have
working feed contracts on-chain that the page omits. They are included, marked as not listed, with
parameters **assumed** to match the listing's uniform values.

### A rule that could never have fired, and what replaced it

The original stale-price rule was "heartbeat + 10%". Every feed publishes a 24-hour heartbeat, so the
bound came out at 26.4 hours, and no intraday equity feed goes 26 hours without publishing. The
product's central check would have been inert.

The replacement backstop, `FEED_STALE_OPEN` at heartbeat + 600 s, **also never fired**, in either
month. It fires at the heartbeat bound, and the feeds never reached it during an open session.

That means **no rule catches the case that actually happens**: feeds sometimes go silent through an
open session and then jump when they update. In the calibration month, **five** open-session silences
ended in jumps over 3%. For example, CRWV fell 7.3% after roughly eight hours of silence spanning
overnight, and AMD rose 5.7% across a post-market silence.

An age limit that would catch those silences is worse than the problem: a 60-minute limit flags
**52.64%** of open-session samples, and even a 480-minute limit flags **10.05%**. So no age rule is
used. Catching this class needs a second, independent price source, for example Robinhood's own
prices, which is a live-service input and not something this replay can test.

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

**The two references disagree, and that is all this establishes.** On the 11,765 rows where the pool
was more than 3% away from the feed, the feed's next update agreed with the served price to within
2.50% at worst. That does not settle which reference is right:

- the feed is not a traded price, so "agrees with the feed" is not "agrees with the market";
- the feed's next update is itself smoothed at reopens, which is this report's own caveat;
- the pool reference has known defects. Only the existence filter was applied; there was no activity
  or liquidity qualification, so a selectable pool may never have traded.

The pool reference is therefore treated as **unverified** and kept out of the decision. It is not
called wrong, and it is not called right.

---

## 6. Rules the replay cannot test

These inputs are live-only. They are **not** validated by this replay, and the result above must not
be read as implying they were. They are also **not implemented in the v0.1 library**; they are what a
live service would need.

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
- **The result depends on which month was tested.** On the calibration month, the same final
  definitions give **1.71%**, which would have read **GO**. The STOP depends on which month was
  tested.
- **The reference is smoothed at reopens.** The preregistered figure is a floor.
- **35 tokens, not 195.** Only these have a Chainlink feed; the rest return `NO_FEED`.
- **No pool check in the default library.** See §5.
- **The frozen-price question is not the only hazard.** Trades can fail for reasons this replay
  cannot see: halts, account restrictions, venue rules.
- **Feeds that go silent mid-session are not caught by any rule.** Five calibration silences ended in
  jumps over 3%, and the only rules that would catch them flag 10% to 53% of open-session samples. A
  second price source is needed, and this replay cannot test one.
- **The calendar is data.** It covers 2026 to 2027 and the library refuses to answer outside that
  range, but it still needs updating.
- **A failed multiplier read could have passed silently.** The released library's test suite caught
  this class of error, so it is worth stating what it meant for this run. It was **not** present in
  the code that produced `evaluation.csv`: `src/rules.ts` at `f4ebac0` already treated a null
  `uiMultiplier`, `newUIMultiplier` or `effectiveAt` as `SOURCE_UNAVAILABLE` (added earlier, in
  `b84074b`). In the CSV, **3,010 rows, 86 sample times × 35 tokens, have all three reads blank and
  are coded `SOURCE_UNAVAILABLE`.** Had the check been missing, those rows would have carried *no code
  at all* instead of a false "nothing staged". Either way they are not unsafe, so **no share changes**:
  materially wrong stays 0.000% and unsafe excluding `MARKET_CLOSED` stays 0.017%. The difference would
  have been visibility, not the result: 3,010 rows quietly passing as if they had been checked.

---

## 8. Reproducing this

1. **`replay/f4ebac0/`** is the exact code that produced `evaluation.csv`, copied from commit
   `f4ebac0` with `git archive`. `replay/f4ebac0/REPLAY-README.md` gives the command to rebuild the
   CSV and the SHA-256 to compare against.
2. `evidence/preregistration.json` is the frozen rulebook, committed 63 seconds before the run.
3. `evidence/meta.json` records universe, window, code commit, thresholds, CSV SHA-256 and invariants.
4. `evaluation.csv` and `calibration.csv` are the raw evidence (release assets; too large for the
   repository).
5. `scripts/verify-evidence.py` checks the downloaded files against the recorded hashes.

The replay needs archive access to chain 4663 and about a day of wall-clock time per 30-day window.
The library and its 49 tests need no network at all.
