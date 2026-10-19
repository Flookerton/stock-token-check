/**
 * snapshot.ts — all reads for many tokens at one pinned block, batched into as few
 * multicalls as possible. Shared by the replay and the live service (spec §7).
 *
 * Design notes that matter:
 *
 *  - BATCHING ACROSS TOKENS (orchestrator B5). Cost must scale with sample TIMES, not
 *    tokens. Building one multicall per token would make a 33-token run 33x the calls, so
 *    every token's sub-calls go into one shared list which is then split into a few large
 *    multicalls at the same block. Adding tokens is then nearly free.
 *
 *  - ONE observe() PER POOL, MANY WINDOWS (orchestrator A3). observe([w1, w2, ..., 0])
 *    returns the cumulative tick at each secondsAgo, so every extra TWAP window is free.
 *
 *  - RAW USD ONLY (orchestrator B1). No uiMultiplier adjustment: both Chainlink and
 *    Robinhood document that the feed reports the price of ONE TOKEN, the same unit the
 *    pool trades in, so pool USD against feed USD is already like for like.
 */

import { encodeFunctionData, decodeFunctionResult, type Hex } from "viem";
import {
  STOCK_ABI, AGGREGATOR_ABI, V3_POOL_ABI, ERC20_ABI, ETH_USD_FEED, WETH, USDG,
} from "./chain.ts";
import { multicall3, type SubCall, type RpcEndpointOpts } from "./rpc.ts";
import { discoverPools, type PoolCandidate } from "./pools.ts";
import { feedMode, type SessionName } from "./sessions.ts";
import type { PoolReference, Purpose, Snapshot } from "./types.ts";

export type ReferenceMode = "none" | "twap";

export interface PoolCacheEntry {
  candidates: PoolCandidate[];
}

const poolCache = new Map<string, PoolCacheEntry>();
export function clearPoolCache(): void { poolCache.clear(); }

function enc(abi: readonly unknown[], fn: string, args: unknown[] = []): Hex {
  return encodeFunctionData({ abi, functionName: fn, args } as never) as Hex;
}

export async function getCandidates(
  token: string,
  discoveryBlock: string,
  opts: RpcEndpointOpts,
): Promise<PoolCacheEntry> {
  const key = token.toLowerCase();
  const hit = poolCache.get(key);
  if (hit) return hit;
  // WETH first: that is where the liquidity actually is on this chain. USDG is the only
  // stablecoin deployed here (there is no USDC on 4663).
  const candidates = await discoverPools(token, discoveryBlock, [WETH, USDG], opts);
  const entry: PoolCacheEntry = { candidates };
  poolCache.set(key, entry);
  return entry;
}

export interface SnapshotInput {
  token: string;
  symbol: string;
  blockTag: string;
  blockNumber: number;
  blockTime: number;
  session: SessionName;
  purpose: Purpose;
  latestBlockTime: number;
  observedInterBlockGapSec?: number | null;
  reopening: { lastReopenAt: number | null; hasUpdatedSinceReopen: boolean | null };
  /** Replay: always false — /corporate-actions reports present-tense status only. */
  corpActionInProgress: boolean;
  referenceMode: ReferenceMode;
  twapSeconds: number;
  extraTwapWindows?: number[];
}

export interface SnapshotExtras {
  feedUsd: number | null;
  referenceTwapInQuote: number | null;
  referenceQuoteUsd: number | null;
  referenceVenue: string | null;
  referenceAddress: string | null;
  deviationByWindow: Record<string, number | null>;
  poolSpotUsd: number | null;
  poolSpotInQuote: number | null;
}

export function twapWindows(input: Pick<SnapshotInput, "twapSeconds" | "extraTwapWindows">): number[] {
  const set = new Set<number>([input.twapSeconds, ...(input.extraTwapWindows ?? [])]);
  return [...set].filter((w) => w > 0).sort((a, b) => b - a);
}

export function observeSecondsAgos(input: Pick<SnapshotInput, "twapSeconds" | "extraTwapWindows">): number[] {
  return [...twapWindows(input), 0];
}

export const FEED_BY_SYMBOL: Record<string, string> = {};
export const TOKEN_BY_SYMBOL: Record<string, string> = {};

export function loadFeedMap(map: Record<string, { feed: string; token: string }>): void {
  for (const [sym, v] of Object.entries(map)) {
    FEED_BY_SYMBOL[sym] = v.feed;
    TOKEN_BY_SYMBOL[sym] = v.token;
  }
}

/** Field offsets within one token slice of a multicall result. */
const F = {
  feed: 0, oraclePaused: 1, tokenPaused: 2, paused: 3, uiMultiplier: 4,
  newUIMultiplier: 5, effectiveAt: 6, uid: 7, ethUsd: 8,
  poolSlot0: 9, poolLiquidity: 10, poolObserve: 11, poolQuoteDecimals: 12,
} as const;

export interface BatchOptions {
  opts?: RpcEndpointOpts;
  /** Cap on sub-calls per multicall; larger sets are split across several calls. */
  maxCallsPerMulticall?: number;
}

export interface SnapshotResult {
  snapshot: Snapshot;
  extras: SnapshotExtras;
}

/** Read many tokens at their pinned blocks, sharing multicalls across tokens. */
export async function readSnapshotBatch(
  inputs: SnapshotInput[],
  bo: BatchOptions = {},
): Promise<SnapshotResult[]> {
  const opts = bo.opts ?? {};
  const maxPerCall = bo.maxCallsPerMulticall ?? 180;

  const byBlock = new Map<string, SnapshotInput[]>();
  for (const i of inputs) {
    const arr = byBlock.get(i.blockTag) ?? [];
    arr.push(i);
    byBlock.set(i.blockTag, arr);
  }

  const done = new Map<string, SnapshotResult>();

  for (const [blockTag, group] of byBlock) {
    const cands = new Map<string, PoolCandidate | null>();
    if (group.some((g) => g.referenceMode === "twap")) {
      for (const g of group) {
        if (cands.has(g.token)) continue;
        const entry = await getCandidates(g.token, "latest", opts);
        cands.set(g.token, entry.candidates[0] ?? null);
      }
    }

    const all: SubCall[] = [];
    const layout = new Map<string, number>();
    for (const g of group) {
      layout.set(g.token, all.length);
      const feed = FEED_BY_SYMBOL[g.symbol] ?? "";
      const cand = cands.get(g.token) ?? null;

      all.push({ target: feed, callData: enc(AGGREGATOR_ABI, "latestRoundData"), allowFailure: true });
      all.push({ target: g.token, callData: enc(STOCK_ABI, "oraclePaused"), allowFailure: true });
      all.push({ target: g.token, callData: enc(STOCK_ABI, "tokenPaused"), allowFailure: true });
      all.push({ target: g.token, callData: enc(STOCK_ABI, "paused"), allowFailure: true });
      all.push({ target: g.token, callData: enc(STOCK_ABI, "uiMultiplier"), allowFailure: true });
      all.push({ target: g.token, callData: enc(STOCK_ABI, "newUIMultiplier"), allowFailure: true });
      all.push({ target: g.token, callData: enc(STOCK_ABI, "effectiveAt"), allowFailure: true });
      all.push({ target: g.token, callData: enc(STOCK_ABI, "uid"), allowFailure: true });
      all.push({ target: ETH_USD_FEED, callData: enc(AGGREGATOR_ABI, "latestRoundData"), allowFailure: true });

      if (cand) {
        all.push({ target: cand.address, callData: enc(V3_POOL_ABI, "slot0"), allowFailure: true });
        all.push({ target: cand.address, callData: enc(V3_POOL_ABI, "liquidity"), allowFailure: true });
        all.push({ target: cand.address, callData: enc(V3_POOL_ABI, "observe", [observeSecondsAgos(g)]), allowFailure: true });
        all.push({ target: cand.quote, callData: enc(ERC20_ABI, "decimals"), allowFailure: true });
      } else {
        for (let k = 0; k < 4; k++) all.push({ target: g.token, callData: "0x" as Hex, allowFailure: true });
      }
    }

    const results: { success: boolean; returnData: Hex }[] = new Array(all.length);
    for (let start = 0; start < all.length; start += maxPerCall) {
      const got = await multicall3(all.slice(start, start + maxPerCall), blockTag, opts);
      for (let i = 0; i < got.length; i++) results[start + i] = got[i];
    }

    for (const g of group) {
      done.set(g.token, decodeOne(g, cands.get(g.token) ?? null, results, layout.get(g.token)!));
    }
  }

  return inputs.map((i) => done.get(i.token)!);
}

/**
 * Failed sub-calls, by call name. A failed read used to be indistinguishable from a field that
 * does not apply, which is how "the read failed" could become "no change pending" (working
 * rule 2). Every failure is counted here and surfaced through the run summary, and callers must
 * treat a null as unavailable rather than as a value.
 */
const readFailures = new Map<string, number>();

/** Record a failed sub-call. */
export function noteReadFailure(name: string): void {
  readFailures.set(name, (readFailures.get(name) ?? 0) + 1);
}

/** Failed sub-calls by name, for the run summary and meta.json. */
export function readFailureCounts(): Record<string, number> {
  return Object.fromEntries([...readFailures.entries()].sort());
}

/** Total failed sub-calls. */
export function readFailureTotal(): number {
  return [...readFailures.values()].reduce((a, b) => a + b, 0);
}

function decodeOne(
  input: SnapshotInput,
  cand: PoolCandidate | null,
  res: { success: boolean; returnData: Hex }[],
  base: number,
): SnapshotResult {
  const d = <T,>(field: number, abi: readonly unknown[], fn: string, name?: string): T | null => {
    const label = name ?? fn;
    const r = res[base + field];
    if (!r || !r.success || !r.returnData || r.returnData.length < 3) {
      noteReadFailure(label);
      return null;
    }
    try {
      return decodeFunctionResult({ abi, functionName: fn, data: r.returnData } as never) as T;
    } catch {
      // A decode failure is a failure too: the call returned bytes we could not interpret.
      noteReadFailure(label + " (decode)");
      return null;
    }
  };

  const rd = d<readonly [bigint, bigint, bigint, bigint, bigint]>(F.feed, AGGREGATOR_ABI, "latestRoundData", "feed.latestRoundData");
  const eth = d<readonly [bigint, bigint, bigint, bigint, bigint]>(F.ethUsd, AGGREGATOR_ABI, "latestRoundData", "ethUsd.latestRoundData");
  const feedAnswer = rd ? rd[1] : null;
  const feedUpdatedAt = rd ? Number(rd[3]) : null;
  const feedUsd = feedAnswer !== null ? Number(feedAnswer) / 1e8 : null;
  const ethUsd = eth ? Number(eth[1]) / 1e8 : null;

  let extras: SnapshotExtras = {
    feedUsd, referenceTwapInQuote: null, referenceQuoteUsd: null,
    referenceVenue: null, referenceAddress: null, deviationByWindow: {},
    poolSpotUsd: null, poolSpotInQuote: null,
  };
  let reference: PoolReference | null = null;

  // USDG-quoted pools are already in USD, so they do not need the ETH feed. Gating on ethUsd
  // removed a perfectly good USDG pool reference whenever the ETH/USD read failed.
  //
  // The decimals read happens BEFORE the gate. It scales the whole pool price, so if it could not
  // be read the reference is unavailable rather than guessed -- and the decoder has already
  // counted the failure. TypeScript enforces this: quoteDecimals is number | null and cannot
  // flow into the price maths without this check.
  const quoteDecimals = cand
    ? d<number>(F.poolQuoteDecimals, ERC20_ABI, "decimals", "pool.quoteDecimals")
    : null;
  const quoteIsUsdg = cand ? cand.quote.toLowerCase() === USDG.toLowerCase() : false;
  if (cand && quoteDecimals !== null && (quoteIsUsdg || ethUsd !== null)) {
    const slot0 = d<readonly [bigint, number, number, number, number, number, boolean]>(F.poolSlot0, V3_POOL_ABI, "slot0", "pool.slot0");
    const liquidity = d<bigint>(F.poolLiquidity, V3_POOL_ABI, "liquidity", "pool.liquidity");
    const obs = d<readonly [readonly bigint[], readonly bigint[]]>(F.poolObserve, V3_POOL_ABI, "observe", "pool.observe");
    const tokenDecimals = 18; // Stock Tokens are 18-decimal ERC-20s
    // The gate guarantees the conversion exists: USDG-quoted pools convert at 1, and any other
    // quote was only entered when ethUsd was readable. Make that explicit rather than casting,
    // so a future edit that breaks the gate fails loudly instead of pricing at zero.
    if (!quoteIsUsdg && ethUsd === null) {
      throw new Error("unreachable: pool branch entered without a unit conversion");
    }
    const inQuote: number = quoteIsUsdg ? 1 : (ethUsd as number);

    const dec0 = cand.tokenIsToken0 ? tokenDecimals : quoteDecimals;
    const dec1 = cand.tokenIsToken0 ? quoteDecimals : tokenDecimals;
    const decScale = Math.pow(10, dec0 - dec1);
    const inQuoteUnits = (t1PerT0: number): number => (cand.tokenIsToken0 ? t1PerT0 : 1 / t1PerT0);
    const dev = (a: number | null, b: number | null): number | null =>
      a !== null && b !== null && b !== 0 ? ((a / b) - 1) * 10_000 : null;

    const windows = twapWindows(input);
    const deviationByWindow: Record<string, number | null> = {};
    let primaryTwapUsd: number | null = null;
    let primaryTwapInQuote: number | null = null;
    let poolSpotUsd: number | null = null;
    let poolSpotInQuote: number | null = null;

    if (slot0) {
      const q = Number(slot0[0]) / 2 ** 96;
      poolSpotInQuote = inQuoteUnits(q * q * decScale);
      poolSpotUsd = poolSpotInQuote * inQuote;
    }

    if (obs) {
      const agos = observeSecondsAgos(input);
      const cum = obs[0];
      const cumNow = Number(cum[agos.length - 1]);
      for (const w of windows) {
        const idx = agos.indexOf(w);
        if (idx < 0) { deviationByWindow[String(w)] = null; continue; }
        const avgTick = (cumNow - Number(cum[idx])) / w;
        const twapInQuote = inQuoteUnits(Math.pow(1.0001, avgTick) * decScale);
        const twapUsd = twapInQuote * inQuote;
        deviationByWindow[String(w)] = dev(feedUsd, twapUsd);
        if (w === input.twapSeconds) { primaryTwapUsd = twapUsd; primaryTwapInQuote = twapInQuote; }
      }
    } else {
      for (const w of windows) deviationByWindow[String(w)] = null;
    }

    extras = {
      feedUsd, referenceTwapInQuote: primaryTwapInQuote, referenceQuoteUsd: inQuote,
      referenceVenue: cand.venue, referenceAddress: cand.address,
      deviationByWindow, poolSpotUsd, poolSpotInQuote,
    };

    reference = {
      venue: cand.venue, address: cand.address, quote: cand.quote, fee: cand.fee,
      liquidity: liquidity ?? 0n,
      twapInQuote: primaryTwapInQuote, quoteUsd: inQuote, twapUsd: primaryTwapUsd,
      deviationBpsByWindow: deviationByWindow,
      deviationBps: deviationByWindow[String(input.twapSeconds)] ?? null,
    };
  }

  const effectiveAtRaw = d<bigint>(F.effectiveAt, STOCK_ABI, "effectiveAt");

  const snapshot: Snapshot = {
    token: input.token,
    symbol: input.symbol,
    uid: d<Hex>(F.uid, STOCK_ABI, "uid") ?? null,
    blockNumber: input.blockNumber,
    blockTime: input.blockTime,
    purpose: input.purpose,
    session: input.session,
    feedMode: feedMode(input.session),
    feed: { answer: feedAnswer, decimals: 8, updatedAt: feedUpdatedAt, roundId: rd ? rd[0] : null },
    tokenState: {
      oraclePaused: d<boolean>(F.oraclePaused, STOCK_ABI, "oraclePaused"),
      tokenPaused: d<boolean>(F.tokenPaused, STOCK_ABI, "tokenPaused"),
      paused: d<boolean>(F.paused, STOCK_ABI, "paused"),
      uiMultiplier: d<bigint>(F.uiMultiplier, STOCK_ABI, "uiMultiplier"),
      newUIMultiplier: d<bigint>(F.newUIMultiplier, STOCK_ABI, "newUIMultiplier"),
      effectiveAt: effectiveAtRaw !== null ? Number(effectiveAtRaw) : null,
    },
    reference,
    reopening: input.reopening,
    sequencer: {
      latestBlockAgeSec:
        input.observedInterBlockGapSec !== undefined && input.observedInterBlockGapSec !== null
          ? input.observedInterBlockGapSec
          : Math.max(0, input.latestBlockTime - input.blockTime),
      measurement:
        input.observedInterBlockGapSec !== undefined && input.observedInterBlockGapSec !== null
          ? "zoomed_gap"
          : "head_age",
      blockRatePerSec: null,
      longestInterBlockGapSec: input.observedInterBlockGapSec ?? null,
    },
    corpActionInProgress: input.corpActionInProgress,
  };

  return { snapshot, extras };
}

/** Read a single token. Convenience wrapper around the batch path. */
export async function readSnapshot(
  input: SnapshotInput,
  bo: BatchOptions = {},
): Promise<SnapshotResult> {
  const [r] = await readSnapshotBatch([input], bo);
  return r;
}
