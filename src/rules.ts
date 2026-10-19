/**
 * rules.ts — PURE function: Snapshot -> Verdict.
 *
 * No I/O, no clock, no randomness. Same snapshot in, byte-identical verdict out (spec G3,
 * and §7 requires this file be shared by the replay and the live service).
 *
 * Two design review changes are implemented here:
 *
 *  Item 3 — heartbeat grace and reopening. Over a weekend the feeds hold their last price
 *           with no heartbeat, so the first open sample can be well past a 24 h bound while
 *           the feed is behaving exactly as designed. The heartbeat check therefore runs
 *           ONLY after the feed's first update since the last reopening, and carries a grace
 *           derived from the observed overshoot distribution.
 *
 *  Item 4 — multiplier rules scaled by size. Dividend adjustments are a few basis points
 *           and occur for every dividend-paying token. Blocking trades for an hour before
 *           each one blocks trades over a change smaller than the bid-ask spread. Changes
 *           below MULTIPLIER_MATERIAL_BPS are downgraded.
 */

import type { Policy } from "./policy.ts";
import type { Purpose, Reason, ReasonCode, Severity, Snapshot, Verdict } from "./types.ts";

interface Draft { code: ReasonCode; severity: Severity; detail: string; }

const isOpenSession = (s: Snapshot["session"]): boolean =>
  s === "PRE_MARKET" || s === "REGULAR" || s === "POST_MARKET" || s === "OVERNIGHT";

/** Size of a staged multiplier change, in basis points of the current multiplier. */
export function multiplierChangeBps(
  current: bigint | null,
  pending: bigint | null,
): number | null {
  if (current === null || pending === null || current === 0n) return null;
  if (pending === current) return null;
  const delta = pending > current ? pending - current : current - pending;
  // Scale by 1e4, keeping integer arithmetic until the final division.
  return Number((delta * 10_000n) / current);
}

export function evaluate(snapshot: Snapshot, policy: Policy): Verdict {
  const d: Draft[] = [];
  const add = (code: ReasonCode, severity: Severity, detail: string) =>
    d.push({ code, severity, detail });

  const open = isOpenSession(snapshot.session);
  const symbol = snapshot.symbol;
  const heartbeat = policy.FEED_HEARTBEAT_SEC[symbol] ?? policy.FEED_HEARTBEAT_SEC.default ?? 86_400;

  // ---- availability --------------------------------------------------------
  const f = snapshot.feed;
  if (f.answer === null || f.updatedAt === null) {
    add("SOURCE_UNAVAILABLE", "block", "feed latestRoundData() could not be read");
  } else if (f.answer <= 0n) {
    add("FEED_INVALID", "block", `feed answer is ${f.answer}, which is not a valid price`);
  } else if (f.updatedAt === 0) {
    add("FEED_INVALID", "block", "feed updatedAt is 0 — round not complete");
  }

  const t = snapshot.tokenState;
  if (t.oraclePaused === null || t.tokenPaused === null || t.paused === null) {
    add("SOURCE_UNAVAILABLE", "block", "token state could not be read");
  }

  // The three multiplier reads are separate sub-calls, so they can fail independently of the
  // pause flags -- and did, silently, before this check existed. A failed read fell through as
  // "no change pending", which is the most dangerous default this rule set can have: MULTIPLIER_*
  // exists precisely so a caller is not handed a price that changes underneath them. A read that
  // fails is SOURCE_UNAVAILABLE, never "nothing staged".
  if (t.uiMultiplier === null || t.newUIMultiplier === null || t.effectiveAt === null) {
    add("SOURCE_UNAVAILABLE", "block", "multiplier state could not be read");
  }

  // ---- sequencer -----------------------------------------------------------
  // Inferred from L2 block production, because no Chainlink uptime feed exists on 4663.
  if (snapshot.sequencer.latestBlockAgeSec > policy.SEQUENCER_STALE_SEC) {
    add("SEQUENCER_STALE", "block",
      `latest L2 block is ${snapshot.sequencer.latestBlockAgeSec.toFixed(1)}s old ` +
      `(limit ${policy.SEQUENCER_STALE_SEC}s) — inferred from L2 block production`);
  }

  // ---- pause flags ---------------------------------------------------------
  if (t.oraclePaused === true) {
    add("ORACLE_PAUSED", "block", "oraclePaused() is true — feed is frozen at its last good value");
  }
  if (t.tokenPaused === true) {
    add("TOKEN_PAUSED", snapshot.purpose === "trade" ? "block" : "warn",
      "tokenPaused() is true — transfers are halted for this token");
  } else if (t.paused === true && t.tokenPaused === false) {
    add("REGISTRY_PAUSED", "block",
      "registry-wide pause is active (paused() true while tokenPaused() false) — issuer-level halt");
  }

  // ---- multiplier ----------------------------------------------------------
  if (t.uiMultiplier !== null && t.newUIMultiplier !== null && t.effectiveAt !== null) {
    const staged = t.newUIMultiplier !== t.uiMultiplier && t.effectiveAt > snapshot.blockTime;
    if (staged) {
      const secs = t.effectiveAt - snapshot.blockTime;
      const bps = multiplierChangeBps(t.uiMultiplier, t.newUIMultiplier) ?? 0;
      const material = bps >= policy.MULTIPLIER_MATERIAL_BPS;
      const size = `${bps} bps change (${material ? "material" : "below the " + policy.MULTIPLIER_MATERIAL_BPS + " bps materiality floor"})`;

      if (material) {
        if (secs <= policy.MULTIPLIER_BLOCK_WINDOW_SEC) {
          add("MULTIPLIER_PENDING_SOON", "block",
            `multiplier change effective in ${secs}s — ${size}`);
        } else if (secs <= policy.MULTIPLIER_WARN_WINDOW_SEC) {
          add("MULTIPLIER_PENDING", "warn", `multiplier change effective in ${secs}s — ${size}`);
        }
      } else {
        // Design review item 4: small changes warn for both purposes and never block,
        // and MULTIPLIER_PENDING_SOON does not fire at all.
        if (secs <= policy.MULTIPLIER_WARN_WINDOW_SEC) {
          add("MULTIPLIER_PENDING", "warn",
            `multiplier change effective in ${secs}s — ${size}`);
        }
      }
    }
  }

  // ---- corporate action ----------------------------------------------------
  if (snapshot.corpActionInProgress) {
    add("CORP_ACTION_IN_PROGRESS", snapshot.purpose === "trade" ? "block" : "warn",
      "/corporate-actions has an IN_PROGRESS row for this token");
  }

  // ---- fresh vs stale ------------------------------------------------------
  const hasUpdate = snapshot.reopening.hasUpdatedSinceReopen;
  const awaitingReopenUpdate = open && hasUpdate === false;

  if (open && awaitingReopenUpdate) {
    // Design note B4.4. The waiting state is capped, and its severity depends on whether
    // anything can confirm the price:
    //   - a usable reference that agrees        -> warn
    //   - no usable reference, purpose=trade    -> block
    //   - wait past heartbeat (+grace)          -> FEED_STALE_OPEN, i.e. it is now stale
    const waited = snapshot.reopening.lastReopenAt !== null
      ? snapshot.blockTime - snapshot.reopening.lastReopenAt
      : 0;
    const hbBound = heartbeat + policy.FEED_HEARTBEAT_GRACE_SEC;

    if (waited > hbBound) {
      add("FEED_STALE_OPEN", "block",
        `no feed update for ${waited}s since the market reopened — beyond the ${hbBound}s heartbeat+grace bound`);
    } else {
      const divThreshold = policy.FEED_DIVERGENCE_BPS[symbol] ?? policy.FEED_DIVERGENCE_BPS.default ?? 100;
      const referenceUsable =
        snapshot.reference !== null &&
        snapshot.reference.deviationBps !== null &&
        Math.abs(snapshot.reference.deviationBps) <= divThreshold;

      if (referenceUsable) {
        add("FEED_AWAITING_REOPEN_UPDATE", "warn",
          `no feed update yet, ${waited}s since the market reopened; a usable ` +
          `${snapshot.reference!.venue} reference agrees within ${divThreshold} bps, heartbeat check deferred`);
      } else if (snapshot.purpose === "trade") {
        add("FEED_AWAITING_REOPEN_UPDATE", "block",
          `no feed update yet, ${waited}s since the market reopened, and no usable pool reference ` +
          `to confirm the price (limit ${hbBound}s)`);
      } else {
        add("FEED_AWAITING_REOPEN_UPDATE", "warn",
          `no feed update yet, ${waited}s since the market reopened, and no usable pool reference ` +
          `(limit ${hbBound}s)`);
      }
    }
  } else if (open && f.updatedAt !== null) {
    const age = snapshot.blockTime - f.updatedAt;
    const bound = heartbeat + policy.FEED_HEARTBEAT_GRACE_SEC;
    if (age > bound) {
      add("FEED_STALE_OPEN", "block",
        `session is open and the feed is ${age}s old, beyond the ${bound}s heartbeat+grace bound`);
    }
  }

  if (!open) {
    add("MARKET_CLOSED", snapshot.purpose === "trade" ? "block" : "warn",
      `US equity market ${snapshot.session === "CLOSED_HOLIDAY" ? "closed (holiday)" : "closed (weekend)"}`);
  }

  // ---- reference divergence ------------------------------------------------
  // v0.1 ships with this OFF (policy.POOL_CHECK_ENABLED = false). When it is off we skip the
  // pool rules entirely — we do NOT emit REFERENCE_UNAVAILABLE for a check we chose not to run,
  // because that would report our own configuration as a data condition.
  if (policy.POOL_CHECK_ENABLED) {
  const ref = snapshot.reference;
  if (!ref || ref.deviationBps === null) {
    if (ref === null) {
      add("REFERENCE_UNAVAILABLE", "warn",
        "no pool above the liquidity floor — divergence check skipped");
      if (ref === null && open) add("POOL_THIN", "warn", "no usable pool reference for this token");
    }
  } else {
    const dev = ref.deviationBps;
    const abs = Math.abs(dev);
    const blockBps = (open && snapshot.session === "OVERNIGHT")
      ? (policy.POOL_DEVIATION_OVERNIGHT_TRADE_BPS ?? policy.POOL_DEVIATION_BLOCK_BPS)
      : policy.POOL_DEVIATION_BLOCK_BPS;

    // Overnight the feed publishes an EMA, so a valuation use tolerates more; a trade does not.
    const overnightPriceWarnOnly =
      snapshot.session === "OVERNIGHT" && snapshot.purpose === "price";

    if (abs > blockBps && !overnightPriceWarnOnly) {
      add("POOL_DEVIATION", "block",
        `${ref.venue} 30-min TWAP is ${(dev / 100).toFixed(2)}% ${dev > 0 ? "below" : "above"} feed ` +
        `(threshold ${(blockBps / 100).toFixed(2)}% for ${snapshot.session}${snapshot.session === "OVERNIGHT" ? `, ${snapshot.purpose}` : ""})`);
    } else if (abs > policy.POOL_DEVIATION_WARN_BPS) {
      add("POOL_DEVIATION_MINOR", "warn",
        `${ref.venue} TWAP differs from feed by ${(dev / 100).toFixed(2)}%`);
    }
  }

  }
  // ---- assemble ------------------------------------------------------------
  const blocking = d.filter((x) => x.severity === "block").map((x) => x.code);
  const reasons: Reason[] = d.map((x) => ({ code: x.code, severity: x.severity, detail: x.detail }));

  return {
    token: snapshot.token,
    symbol: snapshot.symbol,
    purpose: snapshot.purpose,
    safe: blocking.length === 0,
    reasons,
    blockingCodes: blocking,
    warningCodes: d.filter((x) => x.severity === "warn").map((x) => x.code),
    policyId: policy.policyId,
  };
}
