/**
 * blocks.ts — block-by-timestamp resolution and block-production measurement.
 *
 * Two design notes live here.
 *
 * Item 6 (cut the run time): block production is steady at ~10 blocks/s, so the next
 * sample's block is close to `previousBlock + elapsed x rate`. Seeding from that estimate
 * and correcting with one or two probes replaces a fresh binary search, cutting roughly
 * 10 calls per sample-time down to 2 or 3. The old bounded binary search stays as the
 * fallback when the estimate misses.
 *
 * Item 1 (SEQUENCER_STALE_SEC was a sampling artifact): the pilot's "block-gap
 * distribution" was measuring my own 300 s sample spacing, because in every row
 * blockTime == sampleTime. The real signal is the BLOCK COUNT inside an interval and the
 * implied rate; when the rate drops below a floor, zoom in and find the actual longest
 * inter-block gap.
 */

import { getBlock, type BlockRef, type RpcEndpointOpts } from "./rpc.ts";

export type { BlockRef };

/** Measured 2026-10-15: ~9.2-10.0 blocks/s. Used only as a seed, never as truth. */
export const DEFAULT_BLOCK_RATE = 9.8;

export interface IntervalMeasurement {
  fromBlock: number;
  toBlock: number;
  blocks: number;
  seconds: number;
  ratePerSec: number;
}

export function measureInterval(from: BlockRef, to: BlockRef): IntervalMeasurement {
  const blocks = to.number - from.number;
  const seconds = to.timestamp - from.timestamp;
  return {
    fromBlock: from.number,
    toBlock: to.number,
    blocks,
    seconds,
    ratePerSec: seconds > 0 ? blocks / seconds : 0,
  };
}

/**
 * Resolve the last block with timestamp <= targetSec, seeded by an estimate.
 *
 * `seed` is normally the previously resolved sample (300 s earlier), and `rate` the
 * measured blocks/second. We probe the estimate and correct in the direction of the
 * error; each correction moves the estimate by exactly the number of blocks the error
 * implies, so this converges in one or two probes in the steady state.
 */
export async function blockByEstimate(
  targetSec: number,
  seed: BlockRef,
  rate: number,
  anchor: BlockRef,
  opts: RpcEndpointOpts = {},
  /**
   * "exact"  — the LAST block with timestamp <= targetSec (the literal spec wording).
   * "second" — any block whose timestamp lands inside the target second, i.e. within
   *            100 ms of the exact answer on this chain. Costs 1 probe instead of ~7,
   *            because at ~10 blocks/second pinning the exact last block is a log2 search
   *            whose floor is the number of blocks sharing a timestamp.
   */
  precision: "exact" | "second" = "exact",
): Promise<{ ref: BlockRef; probes: number }> {
  if (targetSec >= anchor.timestamp) return { ref: anchor, probes: 0 };

  const r = rate > 0 ? rate : DEFAULT_BLOCK_RATE;
  const clamp = (n: number) => Math.max(1, Math.min(anchor.number, Math.round(n)));
  let probes = 0;
  const probe = async (n: number): Promise<BlockRef | null> => {
    probes += 1;
    return getBlock("0x" + clamp(n).toString(16), opts);
  };

  const guess = clamp(seed.number + (targetSec - seed.timestamp) * r);
  const b = await probe(guess);
  if (!b) {
    const fb = await blockAtOrBeforeBounded(targetSec, seed, anchor, opts);
    return { ref: fb.ref, probes: probes + fb.probes };
  }

  // Fast path: a block inside the target second is within 100 ms of the exact answer.
  if (precision === "second" && b.timestamp <= targetSec && targetSec - b.timestamp < 1) {
    return { ref: b, probes };
  }

  // Bracket the answer inside [lo, hi] with lo.timestamp <= target < hi.timestamp.
  //
  // The previous version stepped one block at a time when the next block shared the
  // target's timestamp — which is the common case at ~10 blocks/second, where many blocks
  // in the same second all carry ts == target. That made a "2 probe" lookup take 30.
  // Instead, gallop: start one second's worth of blocks away and double.
  let lo: BlockRef | null = null;
  let hi: BlockRef | null = null;

  if (b.timestamp > targetSec) {
    hi = b;
    let stepBlocks = Math.max(1, Math.round(r));
    let cursor = guess;
    for (let k = 0; k < 40; k++) {
      const nextNum = clamp(cursor - stepBlocks);
      if (nextNum >= cursor) break;
      const c = await probe(nextNum);
      if (!c) break;
      if (precision === "second" && c.timestamp <= targetSec && targetSec - c.timestamp < 1) {
        return { ref: c, probes };
      }
      if (c.timestamp <= targetSec) { lo = c; break; }
      hi = c;
      cursor = nextNum;
      stepBlocks = Math.max(1, Math.ceil((c.timestamp - targetSec) * r));
    }
  } else {
    lo = b;
    let stepBlocks = Math.max(1, Math.round(r));
    let cursor = guess;
    for (let k = 0; k < 40; k++) {
      const nextNum = clamp(cursor + stepBlocks);
      if (nextNum <= cursor) break; // clamped at the head
      const c = await probe(nextNum);
      if (!c) break;
      if (precision === "second" && c.timestamp <= targetSec && targetSec - c.timestamp < 1) {
        return { ref: c, probes };
      }
      if (c.timestamp > targetSec) { hi = c; break; }
      lo = c;
      cursor = nextNum;
      // Step by the shortfall rather than doubling, so a near-miss is corrected in one hop.
      stepBlocks = Math.max(1, Math.ceil((targetSec - c.timestamp) * r));
    }
  }

  if (!lo || !hi) {
    const fb = await blockAtOrBeforeBounded(targetSec, seed, anchor, opts);
    return { ref: fb.ref, probes: probes + fb.probes };
  }

  // Binary search inside the bracket — normally a few blocks, since the gallop started one
  // second out and the estimate is already close.
  while (hi.number - lo.number > 1) {
    const mid = Math.floor((lo.number + hi.number) / 2);
    const m = await probe(mid);
    if (!m) break;
    if (m.timestamp <= targetSec) lo = m; else hi = m;
  }
  return { ref: lo, probes };
}

/**
 * Binary search for the last block with timestamp <= targetSec, inside a bracket that is
 * widened until it genuinely contains the answer.
 *
 * The earlier version returned the top of the window whenever the WHOLE window lay before
 * the target, which silently produced a block up to 249 s too early — and, because the
 * estimator then handed off to it, most of the probe budget as well. A bracket is only
 * usable when `lo.timestamp <= targetSec < hi.timestamp`; anything else must widen.
 */
async function blockAtOrBeforeBounded(
  targetSec: number,
  seed: BlockRef,
  anchor: BlockRef,
  opts: RpcEndpointOpts,
): Promise<{ ref: BlockRef; probes: number }> {
  const clamp = (n: number) => Math.max(1, Math.min(anchor.number, Math.round(n)));
  let lo = clamp(seed.number - 500);
  let hi = clamp(seed.number + 500);
  let probes = 0;
  let loB: BlockRef | null = null;
  let hiB: BlockRef | null = null;

  for (let attempt = 0; attempt < 12; attempt++) {
    loB = await getBlock("0x" + lo.toString(16), opts);
    hiB = await getBlock("0x" + hi.toString(16), opts);
    probes += 2;
    if (!loB || !hiB) break;

    const width = Math.max(1, hi - lo);
    if (loB.timestamp > targetSec) {
      if (lo <= 1) break;
      hi = lo;
      lo = clamp(lo - width * 4);
    } else if (hiB.timestamp <= targetSec) {
      if (hi >= anchor.number) return { ref: hiB, probes };
      lo = hi;
      hi = clamp(hi + width * 4);
    } else {
      break; // properly bracketed: lo.ts <= target < hi.ts
    }
  }

  if (!loB || !hiB || loB.timestamp > targetSec || hiB.timestamp <= targetSec) {
    // Still not bracketed — walk the whole range. Correct but slow; only reachable on a
    // badly wrong seed (e.g. a multi-day gap in the sample plan).
    const first = await getBlock("0x1", opts);
    probes += 1;
    if (!first) return { ref: seed, probes };
    let l = first.timestamp <= targetSec ? first : seed;
    let h = anchor;
    while (h.number - l.number > 1) {
      const mid = Math.floor((l.number + h.number) / 2);
      const m = await getBlock("0x" + mid.toString(16), opts);
      probes += 1;
      if (!m) break;
      if (m.timestamp <= targetSec) l = m; else h = m;
    }
    return { ref: l, probes };
  }

  let l = loB;
  let h = hiB;
  while (h.number - l.number > 1) {
    const mid = Math.floor((l.number + h.number) / 2);
    const m = await getBlock("0x" + mid.toString(16), opts);
    probes += 1;
    if (!m) break;
    if (m.timestamp <= targetSec) l = m; else h = m;
  }
  return { ref: l, probes };
}

/**
 * Find the longest inter-block gap inside a block interval.
 *
 * Probing every block is impossible (thousands per sample step), so we lay a coarse grid,
 * find the grid step with the largest time span, and refine inside it. If the chain did not
 * stall, no step stands out and the cost is the grid.
 *
 * Returns the grid step chosen for refinement so the caller can report how much was
 * actually examined — the zoom floor is the real resolution limit of the replay's
 * sequencer rule (a gap shorter than the refined window can be missed).
 */
export async function findLongestGap(
  from: BlockRef,
  to: BlockRef,
  opts: RpcEndpointOpts = {},
  gridStep = 100,
): Promise<{
  longestGapSec: number;
  gapBetween: { fromBlock: number; fromTime: number; toBlock: number; toTime: number } | null;
  gridStep: number;
  probes: number;
}> {
  const span = to.number - from.number;
  if (span <= 1) {
    return {
      longestGapSec: to.timestamp - from.timestamp,
      gapBetween: { fromBlock: from.number, fromTime: from.timestamp, toBlock: to.number, toTime: to.timestamp },
      gridStep,
      probes: 0,
    };
  }

  let probes = 0;
  // Coarse grid.
  const points: BlockRef[] = [from];
  for (let n = from.number + gridStep; n < to.number; n += gridStep) {
    const b = await getBlock("0x" + n.toString(16), opts);
    probes += 1;
    if (b) points.push(b);
  }
  points.push(to);

  // Pick the widest grid step.
  let bestI = 0;
  let bestSpan = -1;
  for (let i = 1; i < points.length; i++) {
    const s = points[i].timestamp - points[i - 1].timestamp;
    if (s > bestSpan) { bestSpan = s; bestI = i; }
  }
  const a = points[Math.max(0, bestI - 1)];
  const b = points[bestI];

  // Refine inside that step with a bounded binary search for the tightest single gap.
  let l = a;
  let h = b;
  let best: { gap: number; from: BlockRef; to: BlockRef } = { gap: h.timestamp - l.timestamp, from: l, to: h };
  while (h.number - l.number > 1) {
    const mid = Math.floor((l.number + h.number) / 2);
    const m = await getBlock("0x" + mid.toString(16), opts);
    probes += 1;
    if (!m) break;
    const left = m.timestamp - l.timestamp;
    const right = h.timestamp - m.timestamp;
    if (left > best.gap) best = { gap: left, from: l, to: m };
    if (right > best.gap) best = { gap: right, from: m, to: h };
    // Descend into the wider half; the tighter half cannot hold a bigger gap.
    if (left >= right) h = m; else l = m;
  }

  return {
    longestGapSec: best.gap,
    gapBetween: {
      fromBlock: best.from.number, fromTime: best.from.timestamp,
      toBlock: best.to.number, toTime: best.to.timestamp,
    },
    gridStep,
    probes,
  };
}
