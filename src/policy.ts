/**
 * policy.ts — thresholds, loaded from policy/default-v1.json.
 *
 * Thresholds that must be MEASURED are null here and are filled from
 * replay/preregistration.json, which is calibrated on the calibration window only and
 * frozen before the evaluation window runs (design note 1).
 */

import { readFileSync } from "node:fs";

export interface Policy {
  policyId: string;

  /** Bound on L2 block age. Inferred from block production; no Chainlink feed exists. */
  SEQUENCER_STALE_SEC: number;

  /** Per-symbol feed heartbeat, from Chainlink's listing. */
  FEED_HEARTBEAT_SEC: Record<string, number>;
  /**
   * Grace added to the heartbeat before FEED_STALE_OPEN fires. Derived from the observed
   * overshoot distribution (design note 3), not guessed.
   */
  FEED_HEARTBEAT_GRACE_SEC: number;

  /** Per-symbol Chainlink deviation threshold, in bps, pulled from the listing. */
  FEED_DEVIATION_BPS: Record<string, number>;
  /**
   * Per-symbol divergence threshold for FEED_DIVERGES_FROM_MARKET, in bps.
   * max(deviation x 2, measured baseline p99 + margin) once the ruler is measured.
   */
  FEED_DIVERGENCE_BPS: Record<string, number>;

  MULTIPLIER_MATERIAL_BPS: number;
  MULTIPLIER_BLOCK_WINDOW_SEC: number;
  MULTIPLIER_WARN_WINDOW_SEC: number;

  /**
   * v0.1 ships with the pool check OFF. The pool reference did not survive the replay: pool
   * selection looked ahead, several "deepest" pools do not trade, and the reference disagreed
   * with the feed on 3.9% of samples where the feed's own next update said the feed was right.
   * Turn this on only if you understand that, and expect noise. See README "What is not checked".
   */
  POOL_CHECK_ENABLED: boolean;

  POOL_DEVIATION_BLOCK_BPS: number;
  POOL_DEVIATION_WARN_BPS: number;
  POOL_DEVIATION_OVERNIGHT_TRADE_BPS: number | null;
  POOL_TWAP_SEC: number;
  POOL_MIN_LIQUIDITY_USD: number;

  API_MAX_AGE_SEC: number;
  ATTESTATION_TTL_SEC: number;
}

export const DEFAULT_POLICY: Policy = {
  policyId: "default-v1",
  SEQUENCER_STALE_SEC: 60, // provisional until measured
  FEED_HEARTBEAT_SEC: { default: 86_400 }, // Chainlink lists 86400s for all 33
  FEED_HEARTBEAT_GRACE_SEC: 600, // provisional until measured
  FEED_DEVIATION_BPS: { default: 50 }, // Chainlink lists 0.5% for all 33
  FEED_DIVERGENCE_BPS: { default: 100 },
  MULTIPLIER_MATERIAL_BPS: 50, // design note 4, same scale as the deviation threshold
  MULTIPLIER_BLOCK_WINDOW_SEC: 3_600,
  MULTIPLIER_WARN_WINDOW_SEC: 86_400,
  POOL_CHECK_ENABLED: false,
  POOL_DEVIATION_BLOCK_BPS: 300,
  POOL_DEVIATION_WARN_BPS: 100,
  POOL_DEVIATION_OVERNIGHT_TRADE_BPS: null, // measured
  POOL_TWAP_SEC: 1_800,
  POOL_MIN_LIQUIDITY_USD: 50_000,
  API_MAX_AGE_SEC: 60,
  ATTESTATION_TTL_SEC: 60,
};

/** Merge a frozen preregistration over the defaults. Preregistration always wins. */
export function loadPolicy(preregPath?: string): Policy {
  if (!preregPath) return { ...DEFAULT_POLICY };
  const prereg = JSON.parse(readFileSync(preregPath, "utf8"));
  const th = prereg.thresholds ?? {};
  const p: Policy = { ...DEFAULT_POLICY };

  const num = (v: unknown): number | null =>
    typeof v === "object" && v !== null && "value" in (v as object)
      ? ((v as { value: number | null }).value)
      : (typeof v === "number" ? v : null);

  const seq = num(th.SEQUENCER_STALE_SEC); if (seq !== null) p.SEQUENCER_STALE_SEC = seq;
  const mg = num(th.MULTIPLIER_MATERIAL_BPS); if (mg !== null) p.MULTIPLIER_MATERIAL_BPS = mg;
  const db = num(th.POOL_DEVIATION_BLOCK_BPS); if (db !== null) p.POOL_DEVIATION_BLOCK_BPS = db;
  const dw = num(th.POOL_DEVIATION_WARN_BPS); if (dw !== null) p.POOL_DEVIATION_WARN_BPS = dw;
  const on = num(th.POOL_DEVIATION_OVERNIGHT_TRADE_BPS); if (on !== null) p.POOL_DEVIATION_OVERNIGHT_TRADE_BPS = on;
  const tw = num(th.POOL_TWAP_SEC); if (tw !== null) p.POOL_TWAP_SEC = tw;
  const ml = num(th.POOL_MIN_LIQUIDITY_USD); if (ml !== null) p.POOL_MIN_LIQUIDITY_USD = ml;
  const hg = num(th.FEED_HEARTBEAT_GRACE_SEC); if (hg !== null) p.FEED_HEARTBEAT_GRACE_SEC = hg;

  const perFeed = th.FEED_DIVERGENCE_BPS?.perFeed as Record<string, number> | undefined;
  if (perFeed) p.FEED_DIVERGENCE_BPS = { ...p.FEED_DIVERGENCE_BPS, ...perFeed };
  const devPerFeed = th.FEED_DEVIATION_BPS?.perFeed as Record<string, number> | undefined;
  if (devPerFeed) p.FEED_DEVIATION_BPS = { ...p.FEED_DEVIATION_BPS, ...devPerFeed };

  return p;
}
