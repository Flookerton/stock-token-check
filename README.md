# stock-token-check

**Is this Stock Token's price safe to use right now?**

A small TypeScript library and a local agent tool that report whether a Robinhood Stock Token's
Chainlink price feed is currently in a condition a careful caller should not rely on: the market is
closed, the oracle or token is paused, the feed has stopped updating, a multiplier change is pending,
or a read failed.

It **reports data conditions**. It is **not investment advice**, it does not recommend anything, and
it does not help anyone buy, sell or transfer Stock Tokens.

```ts
import { check } from "stock-token-check";

const r = await check("AAPL", "trade");
// r.verdict.safe            -> false
// r.verdict.blockingCodes   -> ["MARKET_CLOSED"]
// r.verdict.reasons          -> [{ code, severity, detail }, ...]
// r.inputs                   -> the raw values read at the block
```

Or as a local agent tool (MCP over stdio):

```jsonc
// client config
{
  "mcpServers": {
    "stock-token-check": {
      "command": "npx",
      "args": ["tsx", "/path/to/stock-token-check/mcp/server.ts"]
    }
  }
}
```

The server exposes one tool, `check(token, purpose)`. It runs on your machine, over stdio, against
public RPC endpoints. There is no hosted service, no payment, and no signing.

---

## What it checks

| Code | Meaning |
|---|---|
| `MARKET_CLOSED` | US equity market closed (weekend/holiday). Blocks a trade, warns for a valuation. |
| `SEQUENCER_STALE` | L2 block production has stalled. Inferred from blocks, because no Chainlink sequencer feed exists on this chain. |
| `ORACLE_PAUSED` | `oraclePaused()` is true — the feed is frozen at its last good value. |
| `TOKEN_PAUSED` / `REGISTRY_PAUSED` | Transfers are halted for this token, or issuer-wide. |
| `MULTIPLIER_PENDING` / `MULTIPLIER_PENDING_SOON` | A staged `uiMultiplier` change is close enough to matter. |
| `FEED_STALE_OPEN` | Open session, and the feed is older than `heartbeat + 600 s`. A backstop, not a general age rule. |
| `FEED_AWAITING_REOPEN_UPDATE` | The market reopened but the feed is still showing the pre-closure price. |
| `FEED_INVALID` | The feed answer is zero or negative, or the round is incomplete. |
| `NO_FEED` | This token has no price feed at all. Distinct from a broken feed. |
| `SOURCE_UNAVAILABLE` | A read failed, or the calendar does not cover the date. Always blocking; never a default value. |

Every verdict also carries `inputs` — the block, the feed answer and age, the pause flags, the
multiplier values — so a caller can see what the answer was based on instead of trusting the label.

## What it does **not** check

**The pool check is OFF in v0.1 and is not part of the default answer.**

There is an `experimental` path (`POOL_CHECK_ENABLED: true` in the policy) that compares the feed
against a Uniswap pool price. It is off by default, and it warns when you turn it on, because the
pool reference did not survive our own 30-day replay:

- pool selection looked ahead — it used a pool that did not exist yet on **81,257 of 302,400**
  calibration samples;
- several of the "deepest" pools execute no trades, so a price from them means little;
- judged against the pool, 3.9% of samples were "materially wrong"; judged against the feed's own
  next update, **none** were. On those same samples the pool was the outlier.

Treat `POOL_DEVIATION` as noise until that reference is repaired. The library's default answer does
not depend on it.

**Also not checked, and this matters:** trading halts, per-account or per-address restrictions,
whether a venue will accept *your* trade, corporate-action status, and anything off-chain. The
replay could not test these either; they are named in the public report under "Rules the replay
cannot test".

## How the library differs from the replay code

`replay/f4ebac0/` is the **exact** code that produced `evaluation.csv` (commit `f4ebac0`), copied
with `git archive`, unmodified. It is there so the result can be rebuilt and hashed rather than
taken on trust. The library in `src/` is derived from it, and the differences are small and
deliberate:

**Two changes that affect behaviour**

1. **The pool check is gated off.** `policy.ts` gains `POOL_CHECK_ENABLED` (default `false`) and
   `rules.ts` wraps the pool block in it. The replay always evaluated the pool rules; the library does
   not, unless you turn them on. With it off, the pool reads are not merely ignored — they are not
   made (`referenceMode: "none"` skips them in `snapshot.ts`).
2. **Two files are new.** `src/index.ts` is the public entry point (`check()`, token resolution,
   calendar guard, latest-block read) and `src/sessions-guard.ts` refuses dates outside the calendar's
   coverage. The replay had neither: it drove `src/` directly and its window was inside coverage.

**Documentation-only changes, verified by diff**

`blocks.ts`, `rpc.ts`, `sessions.ts`, `snapshot.ts`, `types.ts`, and the comment lines in `rules.ts`
and `policy.ts` differ only in wording — internal review shorthand was replaced with neutral
language. `chain.ts` and `pools.ts` are byte-identical. No threshold, comparison, selector or branch
was changed.

**What the library adds outside `src/`**

`mcp/server.ts` (the stdio tool), `test/run-tests.ts` (49 assertions), and the calendar-coverage
guard. The replay folder has no equivalent: it had no test suite at all.

**What the replay has that the library does not**

`replay/f4ebac0/replay/run.ts` — the sampler. It walks 8,640 five-minute steps, pins a historical
block per sample, batches 35 tokens into one multicall, and appends a row per token. The library
answers one token at the current head, because a caller asking "is this safe right now" is not
running a 30-day study.

## Installation and use

```bash
git clone <this repo>
cd stock-token-check
npm install
npm test          # 49 assertions, no network
npm run mcp       # start the MCP server on stdio
```

Node 18+. The library is TypeScript source (`.ts`) and is meant to be run through `tsx` or bundled;
it is not pre-compiled in v0.1.

### Calendar coverage guard

The market calendar (`calendar/nyse-holidays.json`) covers **2026 and 2027**. If the library is
asked about a block timestamp outside that range, it returns `SOURCE_UNAVAILABLE` with a detail
naming the covered years — it will not answer from a calendar that does not know that year's
holidays. This is deliberate: a stale calendar is otherwise invisible, and a missed holiday looks
exactly like a normal trading session.

Update the file and the guard follows automatically. `coverageYears()` reports what is covered.

## Data provenance

- **Token and feed addresses:** `data/feed-map.json` — 35 tokens, each with its feed, token address,
  decimals, deviation and heartbeat, plus the source for that row. Fetched 2026-10-15.
- **33 of the 35** appear in Chainlink's published Robinhood listing. **SGOV and USAR do not.**
  Their feed contracts exist on-chain and were verified directly; their deviation and heartbeat are
  **assumed** to match the listing's uniform 0.5% / 86,400 s, and are marked as assumed in the map.
- **Market calendar:** NYSE holidays and early closes, 2026–2027, from NYSE's published schedule
  with a secondary cross-check. See `calendar/nyse-holidays.json` for sources and fetch time.

## Status, maintenance and limitations

- **Version 0.1.0.** The rules here are the ones that survived a 30-day historical replay. The
  headline result of that replay was **STOP** — see [`report/report.md`](report/report.md). That is
  a result about *these rules against these feeds in that month*, and it is the reason this is
  published as a free library rather than a service.
- **Maintained by** [@Flookerton](https://github.com/Flookerton) on GitHub. Issues and pull requests
  are the right channel. There is no SLA and no support commitment.
- **Token list date:** 2026-10-15. **Calendar coverage:** 2026–2027, fetched 2026-10-15. Both are
  data files and both will go stale; the calendar has a guard, the token list does not (a token
  added after that date will be reported as `NO_FEED`).
- **Volatility, not safety.** A `safe: true` verdict means no *data condition* was detected. It says
  nothing about whether the asset is a good idea, and nothing about price direction.

## Naming

Robinhood and Chainlink are named only as data sources: Robinhood issues the Stock Tokens and
operates the chain; Chainlink publishes the price feeds. This project is not affiliated with,
endorsed by, or sponsored by either, and uses no logos or marks beyond the names.

## License

Apache-2.0. See [LICENSE](LICENSE).
