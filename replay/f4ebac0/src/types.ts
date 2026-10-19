/**
 * types.ts — the snapshot and verdict shapes shared by the replay and the live service.
 *
 * A verdict is a pure function of a Snapshot (spec G3). Keeping the types in one place is
 * what stops the replay and the service from drifting apart.
 */

import type { SessionName } from "./sessions.ts";

export type Purpose = "price" | "trade";

export type Severity = "block" | "warn";

/** Every code, in the fixed order used for the EIP-712 reasonsBitmap and /v1/meta. */
export const REASON_CODES = [
  "SOURCE_UNAVAILABLE",
  "TOKEN_NOT_CANONICAL",
  "NO_FEED",
  "ASSET_INACTIVE",
  "SEQUENCER_STALE",
  "FEED_INVALID",
  "ORACLE_PAUSED",
  "TOKEN_PAUSED",
  "REGISTRY_PAUSED",
  "VENUE_BLOCKED",
  "MULTIPLIER_MISMATCH",
  "MULTIPLIER_PENDING_SOON",
  "MULTIPLIER_PENDING",
  "CORP_ACTION_IN_PROGRESS",
  "TRADING_HALT",
  "FEED_STALE_OPEN",
  "FEED_DIVERGES_FROM_MARKET",
  "MARKET_CLOSED",
  "SESSION_NOT_TRADABLE",
  "CAPABILITIES_UNKNOWN",
  "POOL_DEVIATION",
  "POOL_DEVIATION_MINOR",
  "POOL_THIN",
  "REFERENCE_UNAVAILABLE",
  "FEED_AWAITING_REOPEN_UPDATE",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  severity: Severity;
  detail: string;
}

/** Everything read at one pinned block for one token. */
export interface Snapshot {
  token: string;
  symbol: string;
  uid: string | null;

  blockNumber: number;
  blockTime: number;

  purpose: Purpose;
  session: SessionName;
  feedMode: "live" | "ema_overnight" | "frozen_closed";

  feed: {
    answer: bigint | null;
    decimals: number;
    updatedAt: number | null;
    roundId: bigint | null;
  };

  tokenState: {
    oraclePaused: boolean | null;
    tokenPaused: boolean | null;
    paused: boolean | null;   // token OR registry-wide
    uiMultiplier: bigint | null;
    newUIMultiplier: bigint | null;
    effectiveAt: number | null;
  };

  /** Null when no usable reference exists for this token at this block. */
  reference: PoolReference | null;

  /**
   * Reopening state (orchestrator item 3). The heartbeat rule must not run until the feed
   * has published once since the market last reopened — over a weekend the feed holds its
   * last price with no heartbeat, so a Sunday-evening sample would otherwise trip
   * `age > heartbeat` as a false alarm, possibly for hours.
   */
  reopening: {
    /** Most recent session transition from closed to open, or null if not applicable. */
    lastReopenAt: number | null;
    /** True once a feed update has landed at or after `lastReopenAt`. */
    hasUpdatedSinceReopen: boolean | null;
  };

  sequencer: {
    /**
     * Age of the newest block. In the LIVE service this is "now - head.timestamp".
     * In the REPLAY there is no head: we pin to a historical block, so the equivalent
     * observable is the longest gap in block production inside the sampling interval.
     * `measurement` says which one produced the number, so the report never presents a
     * zoomed gap as if it were a head age.
     */
    latestBlockAgeSec: number;
    measurement: "head_age" | "zoomed_gap";
    /** Measured blocks/second over the interval ending at this sample. */
    blockRatePerSec: number | null;
    /** Longest inter-block gap found inside that interval, when a zoom was triggered. */
    longestInterBlockGapSec: number | null;
  };

  corpActionInProgress: boolean;
}

/** The pool side of a snapshot, priced in USD and expressed like-for-like with the feed. */
export interface PoolReference {
  venue: string;
  address: string;
  quote: string;
  fee: number;
  liquidity: bigint;

  /** Raw 30-minute TWAP in quote-asset units per token. */
  twapInQuote: number | null;
  /** Quote→USD conversion used (1 for a USD stablecoin). */
  quoteUsd: number;

  /**
   * 30-minute TWAP in USD per token — directly comparable to the feed answer.
   *
   * NO multiplier adjustment. Both Chainlink and Robinhood document that the feed reports
   * the price of ONE TOKEN (underlying x multiplier), which is the same unit the pool
   * trades in, so raw USD against raw USD is already like for like. Dividing the pool by
   * uiMultiplier only adds the multiplier's own basis points as a constant bias
   * (orchestrator B1, reversing the earlier instruction).
   */
  twapUsd: number | null;

  /** Deviations at several TWAP windows ending at the same block (orchestrator A3). */
  deviationBpsByWindow: Record<string, number | null>;
  deviationBps: number | null;

  /** Why there is no usable reference, when there is none. */
  unavailableReason?: string;
}

export interface Verdict {
  token: string;
  symbol: string;
  purpose: Purpose;
  safe: boolean;
  reasons: Reason[];
  blockingCodes: ReasonCode[];
  warningCodes: ReasonCode[];
  policyId: string;
}
