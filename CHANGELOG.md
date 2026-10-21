# Changelog

## 0.1.1 — 2026-10-21

**Fixed**

- **Live checks could answer from an old block.** The response cache stored the request for the
  newest block (`"latest"`) like any other, so after the first check every later check re-used that
  block and its verdict, and the sequencer-staleness check measured 0 s. Requests about the moving
  head are no longer cached. Requests pinned to a block number are cached as before.
- **Throttling now gives `SOURCE_UNAVAILABLE`.** When the endpoints kept refusing, `check()` threw
  an exception instead of returning a verdict. It now returns `SOURCE_UNAVAILABLE`, which always
  blocks. It still never fills in a value.
- The comment on `RpcEndpointOpts.archive` was wrong. Every call has always used the archive pool,
  and still does. `RPC_LATEST` is marked unused.

**Added**

- `STOCK_CHECK_RPC_URLS`, or `rpcUrls` in `check()` options, to use your own endpoints in place of
  the public defaults. Each URL is validated: `https://` only, except `http://localhost` and
  `http://127.0.0.1`; no empty entries; chain ID must be 4663. An invalid setting is an error, never
  a fall back to the defaults. Custom URLs are recorded only as `custom-1`, `custom-2`, ... in cache
  records, logs and errors.
- `STOCK_CHECK_RPS` as the variable form of `reqPerSec` (default 2.5).
- `RpcConfigError` and `RpcUnavailableError` are exported.
- 37 new test assertions (86 in total), all offline.

**Unchanged:** the rules, thresholds, policy, the replay code in `replay/f4ebac0/`, `evidence/` and
the four release data files.

## 0.1.0 — 2026-10-20

First release: the library, the stdio MCP server, the public report and the evidence anchors.
