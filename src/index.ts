/**
 * stock-token-check — is this Stock Token price safe to use right now?
 *
 * Public entry point. Reads the chain at the newest block, applies the rules that survived the
 * replay, and returns a verdict with the reasons and the raw inputs behind them.
 *
 * What this is NOT: investment advice, a recommendation, or a way to buy anything. It reports data
 * conditions. See README.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  loadCalendar, makeHolidaySet, makeEarlyCloseMap, sessionAt, feedMode,
  type Calendar, type SessionName,
} from "./sessions.ts";
import { calendarCovers, coverageYears, coverageLabel } from "./sessions-guard.ts";
import {
  loadFeedMap, readSnapshot, readFailureCounts, readFailureTotal, type SnapshotInput,
} from "./snapshot.ts";
import { evaluate } from "./rules.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import {
  configureCache, configureEndpoints, getBlock, resolveReqPerSec, resolveRpcUrls, RpcConfigError,
} from "./rpc.ts";
import type { Purpose, Verdict } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

export interface FeedEntry {
  symbol: string;
  token: string;
  feed: string;
  /** True when the feed appears in Chainlink's published Robinhood listing. */
  chainlinkListed: boolean;
  /** Where the address came from. */
  source: string;
}

export interface CheckOptions {
  /** Override any policy field. The defaults are the values frozen for the replay. */
  policy?: Partial<Policy>;
  /** Where to keep the RPC response cache. Defaults to a temp directory. */
  cacheDir?: string;
  /**
   * Requests per second, shared across the endpoint pool. Precedence: this option, then
   * STOCK_CHECK_RPS, then 2.5. Do not raise it against the public defaults.
   */
  reqPerSec?: number;
  /**
   * Your own RPC URLs, used instead of the public defaults for every call and rotated in order.
   * Precedence: this option, then STOCK_CHECK_RPC_URLS (comma-separated), then the public defaults.
   * Each must be https:// (http:// only for localhost or 127.0.0.1) and must serve chain 4663.
   * A URL is never written to the cache, logs or errors; it appears as `custom-1`, `custom-2`, ...
   */
  rpcUrls?: string[];
}

export const VERSION = "0.1.1";

export interface CheckResult {
  verdict: Verdict;
  /** Everything read at the block, so a caller can see the inputs rather than trust the verdict. */
  inputs: {
    blockNumber: number;
    blockTime: number;
    blockTimeIso: string;
    session: SessionName;
    feedMode: "live" | "ema_overnight" | "frozen_closed";
    feedAnswer: string | null;
    feedUpdatedAt: number | null;
    feedAgeSec: number | null;
    oraclePaused: boolean | null;
    tokenPaused: boolean | null;
    registryPaused: boolean | null;
    uiMultiplier: string | null;
    newUIMultiplier: string | null;
    effectiveAt: number | null;
    calendarCovered: boolean;
    calendarCoverage: string;
  };
  meta: {
    library: "stock-token-check";
    version: string;
    policyId: string;
    poolCheckEnabled: boolean;
    readFailures: Record<string, number>;
    readFailureTotal: number;
  };
}

let FEEDS: Record<string, FeedEntry> | null = null;
let CAL: Calendar | null = null;
let HOLIDAYS: Set<string> | null = null;
let EARLY: Map<string, string> | null = null;
let WARNED_POOLS = false;

/** Load the token/feed map shipped with the package. Safe to call repeatedly. */
export function loadFeeds(path = join(ROOT, "data/feed-map.json")): Record<string, FeedEntry> {
  if (FEEDS) return FEEDS;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, {
    feed: string; token: string; chainlinkListed?: boolean; source?: string;
  }>;
  const out: Record<string, FeedEntry> = {};
  for (const [symbol, v] of Object.entries(raw)) {
    if (!v?.feed || !v?.token) throw new Error(`feed map entry ${symbol} is missing feed or token`);
    out[symbol] = {
      symbol,
      token: v.token,
      feed: v.feed,
      chainlinkListed: v.chainlinkListed !== false,
      source: v.source ?? "Chainlink price feeds, Robinhood network",
    };
  }
  FEEDS = out;
  loadFeedMap(Object.fromEntries(Object.entries(out).map(([s, v]) => [s, { feed: v.feed, token: v.token }])));
  return out;
}

function calendar(path = join(ROOT, "calendar/nyse-holidays.json")): Calendar {
  if (CAL) return CAL;
  CAL = loadCalendar(path);
  HOLIDAYS = makeHolidaySet(CAL);
  EARLY = makeEarlyCloseMap(CAL);
  return CAL;
}

/** Symbols the library knows about. */
export function tokens(): FeedEntry[] {
  return Object.values(loadFeeds()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Resolve an address or symbol to a symbol. Throws for an unknown token. */
export function resolve(tokenOrSymbol: string): FeedEntry {
  const feeds = loadFeeds();
  const q = tokenOrSymbol.trim();
  const bySymbol = feeds[q.toUpperCase()];
  if (bySymbol) return bySymbol;
  const lower = q.toLowerCase();
  for (const f of Object.values(feeds)) if (f.token.toLowerCase() === lower) return f;
  throw new Error(
    `${tokenOrSymbol} is not one of the ${Object.keys(feeds).length} tokens with a price feed. ` +
    `A token with no feed is NO_FEED, not SOURCE_UNAVAILABLE — call tokens() for the list.`);
}

function verdictUnavailable(symbol: string, token: string, purpose: Purpose, policy: Policy,
                            detail: string): Verdict {
  return {
    token, symbol, purpose, safe: false,
    reasons: [{ code: "SOURCE_UNAVAILABLE", severity: "block", detail }],
    blockingCodes: ["SOURCE_UNAVAILABLE"], warningCodes: [], policyId: policy.policyId,
  };
}

/**
 * Check one token.
 *
 * @param tokenOrSymbol contract address (0x…) or ticker, case-insensitive
 * @param purpose "trade" (execute a swap now) or "price" (use as a valuation)
 */
export async function check(
  tokenOrSymbol: string,
  purpose: Purpose = "trade",
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const policy: Policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const feeds = loadFeeds();
  const cal = calendar();
  // An invalid setting throws here (RpcConfigError): it is never a verdict, and never a silent
  // fall back to the public defaults.
  configureCache(opts.cacheDir ?? join(tmpdir(), "stock-token-check-cache"), resolveReqPerSec(opts.reqPerSec));
  configureEndpoints(resolveRpcUrls(opts.rpcUrls));

  if (policy.POOL_CHECK_ENABLED && !WARNED_POOLS) {
    WARNED_POOLS = true;
    // The pool check did not survive the replay. On by request, but noisy by nature.
    console.warn(
      "[stock-token-check] pool check is ON (experimental). The pool reference looked ahead in " +
      "the replay, several 'deepest' pools do not trade, and it disagreed with the feed on 3.9% " +
      "of samples where the feed's next update said the feed was right. Treat POOL_* codes as " +
      "noise until the reference is repaired.");
  }

  let entry: FeedEntry;
  try {
    entry = resolve(tokenOrSymbol);
  } catch (e) {
    return emptyUnavailable(String((e as Error).message), tokenOrSymbol, purpose, policy);
  }

  // A read that fails (endpoints refusing, rate limits, timeouts, network) is SOURCE_UNAVAILABLE:
  // no answer, never a filled-in value. Only a configuration error propagates, because a wrong
  // setting (for example a URL on another chain) must never produce a verdict at all.
  let block: Awaited<ReturnType<typeof getBlock>>;
  try {
    block = await getBlock("latest");
  } catch (e) {
    if (e instanceof RpcConfigError) throw e;
    const v = verdictUnavailable(entry.symbol, entry.token, purpose, policy,
      `could not read the chain head: ${(e as Error).message}`);
    return { verdict: v, inputs: emptyInputs(), meta: metaOf(policy) };
  }
  if (!block) {
    const v = verdictUnavailable(entry.symbol, entry.token, purpose, policy,
      "could not read the chain head");
    return { verdict: v, inputs: emptyInputs(), meta: metaOf(policy) };
  }

  const covered = calendarCovers(cal, block.timestamp * 1000);
  if (!covered) {
    // Never answer from a calendar that does not know about this year's holidays.
    const v = verdictUnavailable(entry.symbol, entry.token, purpose, policy,
      `market calendar covers ${coverageLabel(cal)}; block timestamp ` +
      `${new Date(block.timestamp * 1000).toISOString()} is outside that. ` +
      `Update calendar/nyse-holidays.json before trusting this answer.`);
    return {
      verdict: v,
      inputs: { ...emptyInputs(), blockNumber: block.number, blockTime: block.timestamp,
                blockTimeIso: new Date(block.timestamp * 1000).toISOString(),
                calendarCovered: false, calendarCoverage: coverageLabel(cal) },
      meta: metaOf(policy),
    };
  }

  const info = sessionAt(block.timestamp * 1000, HOLIDAYS!, EARLY!);
  const input: SnapshotInput = {
    token: entry.token,
    symbol: entry.symbol,
    blockTag: "0x" + block.number.toString(16),
    blockNumber: block.number,
    blockTime: block.timestamp,
    session: info.session,
    purpose,
    latestBlockTime: block.timestamp,
    observedInterBlockGapSec: null,
    // A one-shot call has no prior sample, so it cannot know when the market reopened. The replay
    // tracks this across samples; a single check reports what the chain says now.
    reopening: { lastReopenAt: null, hasUpdatedSinceReopen: null },
    corpActionInProgress: false,
    referenceMode: policy.POOL_CHECK_ENABLED ? "twap" : "none",
    twapSeconds: policy.POOL_TWAP_SEC,
    extraTwapWindows: [],
  };

  let snapshot: Awaited<ReturnType<typeof readSnapshot>>["snapshot"];
  try {
    ({ snapshot } = await readSnapshot(input));
  } catch (e) {
    if (e instanceof RpcConfigError) throw e;
    const v = verdictUnavailable(entry.symbol, entry.token, purpose, policy,
      `could not read the chain at block ${block.number}: ${(e as Error).message}`);
    return {
      verdict: v,
      inputs: { ...emptyInputs(), blockNumber: block.number, blockTime: block.timestamp,
                blockTimeIso: new Date(block.timestamp * 1000).toISOString(),
                session: info.session, feedMode: feedMode(info.session),
                calendarCoverage: coverageLabel(cal) },
      meta: metaOf(policy),
    };
  }
  const verdict = evaluate(snapshot, policy);
  const feedAge = snapshot.feed.updatedAt !== null ? block.timestamp - snapshot.feed.updatedAt : null;

  return {
    verdict,
    inputs: {
      blockNumber: block.number,
      blockTime: block.timestamp,
      blockTimeIso: new Date(block.timestamp * 1000).toISOString(),
      session: info.session,
      feedMode: feedMode(info.session),
      feedAnswer: snapshot.feed.answer !== null ? snapshot.feed.answer.toString() : null,
      feedUpdatedAt: snapshot.feed.updatedAt,
      feedAgeSec: feedAge,
      oraclePaused: snapshot.tokenState.oraclePaused,
      tokenPaused: snapshot.tokenState.tokenPaused,
      registryPaused: snapshot.tokenState.paused,
      uiMultiplier: snapshot.tokenState.uiMultiplier?.toString() ?? null,
      newUIMultiplier: snapshot.tokenState.newUIMultiplier?.toString() ?? null,
      effectiveAt: snapshot.tokenState.effectiveAt,
      calendarCovered: true,
      calendarCoverage: coverageLabel(cal),
    },
    meta: metaOf(policy),
  };
}

function metaOf(policy: Policy): CheckResult["meta"] {
  return {
    library: "stock-token-check",
    version: VERSION,
    policyId: policy.policyId,
    poolCheckEnabled: policy.POOL_CHECK_ENABLED,
    readFailures: readFailureCounts(),
    readFailureTotal: readFailureTotal(),
  };
}

function emptyInputs(): CheckResult["inputs"] {
  return {
    blockNumber: 0, blockTime: 0, blockTimeIso: "", session: "CLOSED_WEEKEND",
    feedMode: "frozen_closed", feedAnswer: null, feedUpdatedAt: null, feedAgeSec: null,
    oraclePaused: null, tokenPaused: null, registryPaused: null, uiMultiplier: null,
    newUIMultiplier: null, effectiveAt: null, calendarCovered: true, calendarCoverage: "",
  };
}

function emptyUnavailable(detail: string, tokenOrSymbol: string, purpose: Purpose,
                          policy: Policy): CheckResult {
  return {
    verdict: {
      token: tokenOrSymbol, symbol: tokenOrSymbol, purpose, safe: false,
      reasons: [{ code: "NO_FEED" as never, severity: "block", detail }],
      blockingCodes: ["NO_FEED" as never], warningCodes: [], policyId: policy.policyId,
    },
    inputs: emptyInputs(),
    meta: metaOf(policy),
  };
}

export { coverageYears, coverageLabel, calendarCovers } from "./sessions-guard.ts";
export { DEFAULT_POLICY } from "./policy.ts";
export { RpcConfigError, RpcUnavailableError } from "./rpc.ts";
export type { Policy } from "./policy.ts";
export type { Verdict, Purpose, ReasonCode, Reason } from "./types.ts";
