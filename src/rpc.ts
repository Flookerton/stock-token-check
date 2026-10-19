/**
 * rpc.ts — cached, rate-limited JSON-RPC transport.
 *
 * Two requirements drive this design (design notes 5 and 1):
 *
 *  1. Every raw response is written to disk, content-addressed by the SHA-256 of its
 *     request. The replay must be able to re-run from the cache ALONE, with no network,
 *     and that offline re-run is what reproduces the CSV hash. The archive endpoint is
 *     free but outside our control, so it must never be a runtime dependency.
 *  2. The endpoint is aggressively abuse-limited. Measured 2026-10-15: 1 req/s ran
 *     45/45 clean; 3 req/s gave 86/90 with retryable 429s; bursts trigger a temporary
 *     ban that returns 403. So we pace deliberately and back off on 403/429.
 */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { encodeFunctionData, decodeFunctionResult, type Hex } from "viem";
import { MULTICALL3, MULTICALL3_ABI, RPC_ARCHIVE_POOL, RPC_LATEST } from "./chain.ts";

export interface RpcEndpointOpts {
  /** Use the archive pool (historical state). Default: the fast public endpoint. */
  archive?: boolean;
  /** Throw instead of fetching on a cache miss. */
  offline?: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  retries: number;
  requests: number;
}

export const stats: CacheStats = { hits: 0, misses: 0, retries: 0, requests: 0 };

/**
 * Design requirement B6: no silent errors. Anything caught and swallowed increments this, and
 * every run asserts it is still zero at the end. A swallowed provider error looks like
 * "no events found", which is worse than a crash.
 */
let errorsSwallowed = 0;
export function noteSwallowedError(): void { errorsSwallowed += 1; }
export function swallowedErrorCount(): number { return errorsSwallowed; }

let CACHE_DIR = "replay/cache";
let REQ_PER_SEC = 2.5;

export function configureCache(dir: string, reqPerSec = 2.5): void {
  CACHE_DIR = dir;
  REQ_PER_SEC = reqPerSec;
  mkdirSync(dir, { recursive: true });
}

export function cacheDir(): string {
  return CACHE_DIR;
}

/** Content-address of a request: identical request ⇒ identical file. */
export function cacheKey(method: string, params: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ method, params }))
    .digest("hex");
}

function cachePath(key: string): string {
  // Fan out by first two hex chars so a directory with tens of thousands of
  // entries stays navigable.
  return join(CACHE_DIR, key.slice(0, 2), `${key}.json`);
}

// --- pacing -------------------------------------------------------------

let nextSlot = 0;
let hostCursor = 0;

async function pace(): Promise<void> {
  const interval = 1000 / REQ_PER_SEC;
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + interval;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function nextEndpoint(archive: boolean): string {
  if (!archive) return RPC_LATEST;
  const pool = RPC_ARCHIVE_POOL;
  const url = pool[hostCursor % pool.length];
  hostCursor += 1;
  return url;
}

// --- core call ----------------------------------------------------------

/**
 * Perform one JSON-RPC call, through the cache.
 *
 * A cached response is returned without touching the network, so an offline re-run
 * reproduces the previous run exactly.
 */
export async function rpc(
  method: string,
  params: unknown[],
  opts: RpcEndpointOpts = {},
): Promise<unknown> {
  const key = cacheKey(method, params);
  const path = cachePath(key);

  if (existsSync(path)) {
    stats.hits += 1;
    const rec = JSON.parse(readFileSync(path, "utf8"));
    if (rec.error) throw new RpcError(method, rec.error);
    return rec.result;
  }

  if (opts.offline || process.env.REPLAY_OFFLINE === "1") {
    throw new Error(
      `offline cache miss for ${method} (key ${key.slice(0, 12)}…) — the cache is incomplete`,
    );
  }

  stats.misses += 1;
  const archive = opts.archive ?? true;
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await pace();
    const endpoint = nextEndpoint(archive);
    stats.requests += 1;

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
    } catch (err) {
      stats.retries += 1;
      await backoff(attempt);
      continue;
    }

    // Retryable: rate limiters, upstream timeouts, and server faults. 408 belongs here —
    // a load-balanced backend that times out on one request usually answers the next one,
    // and treating that as fatal killed a run that was 53% complete.
    const RETRYABLE_STATUS = new Set([403, 408, 425, 429]);
    if (RETRYABLE_STATUS.has(res.status) || res.status >= 500) {
      stats.retries += 1;
      const ra = res.headers.get("retry-after");
      const wait = ra ? Number(ra) * 1000 : backoffMs(attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (res.status === 400) {
      // Providers report a missing historical state as HTTP 400, not as a JSON-RPC error
      // (dRPC does exactly this). That is the same transient class as the JSON form, so it
      // rotates and retries rather than killing the run; a genuinely malformed request
      // still exhausts its attempts and fails loudly.
      const text = await res.text().catch(() => "");
      stats.retries += 1;
      const looksTransient = /not available|unknown state|no state|try again|timeout|pruned/i.test(text);
      if (!looksTransient && attempt >= 1) {
        throw new Error(`RPC ${method} HTTP 400 (not a state-availability problem): ${text.slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      continue;
    }

    if (!res.ok) {
      stats.retries += 1;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw new Error(`RPC ${method} HTTP ${res.status} after ${attempt + 1} attempts`);
    }

    const body = (await res.json()) as { result?: unknown; error?: unknown };

    if (body.error) {
      const msg = JSON.stringify(body.error);

      // A load-balanced endpoint can land on a backend that does not hold the state for
      // this block, even when the pool as a whole is archive-capable. That is TRANSIENT,
      // and it must NOT be cached: caching it would bake a momentary infrastructure blip
      // into the evidence store as though it were a deterministic answer, and every later
      // replay would reproduce the blip instead of the chain.
      const transient =
        /historical state .* is not available/i.test(msg) ||
        /not available/i.test(msg) ||
        /timeout|timed out|temporarily|try again/i.test(msg);

      if (transient) {
        stats.retries += 1;
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue; // rotate to the next endpoint and try again
      }

      // A revert IS deterministic — cache it so replaying is reproducible.
      writeRecord(path, { key, method, params, error: body.error, endpoint, fetchedAt: isoNow() });
      throw new RpcError(method, body.error);
    }

    writeRecord(path, { key, method, params, result: body.result, endpoint, fetchedAt: isoNow() });
    return body.result;
  }

  throw new Error(`RPC ${method} exhausted ${maxAttempts} attempts (endpoint kept rate-limiting)`);
}

function backoffMs(attempt: number): number {
  return Math.min(60_000, 2 ** attempt * 500) + Math.floor(Math.random() * 250);
}

async function backoff(attempt: number): Promise<void> {
  await new Promise((r) => setTimeout(r, backoffMs(attempt)));
}

function isoNow(): string {
  return new Date().toISOString();
}

function writeRecord(path: string, rec: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rec));
}

export class RpcError extends Error {
  constructor(method: string, public detail: unknown) {
    super(`RPC ${method} reverted/errored: ${JSON.stringify(detail).slice(0, 200)}`);
  }
}

// --- multicall ----------------------------------------------------------

export interface SubCall {
  target: string;
  callData: Hex;
  allowFailure?: boolean;
}

export interface SubResult {
  success: boolean;
  returnData: Hex;
}

/**
 * One Multicall3 call covering many reads at one pinned block.
 *
 * This is what keeps the replay affordable: six or seven reads per token per sample
 * collapse into a single eth_call, so 10 tokens × 8,640 samples is ~86,400 requests
 * rather than ~518,400.
 */
export async function multicall3(
  calls: SubCall[],
  blockTag: string,
  opts: RpcEndpointOpts = {},
): Promise<SubResult[]> {
  if (calls.length === 0) return [];

  const data = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [
      calls.map((c) => ({
        target: c.target as `0x${string}`,
        allowFailure: c.allowFailure ?? true,
        callData: c.callData,
      })),
    ],
  });

  const raw = (await rpc(
    "eth_call",
    [{ to: MULTICALL3, data }, blockTag],
    opts,
  )) as Hex;

  const decoded = decodeFunctionResult({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    data: raw,
  }) as readonly { success: boolean; returnData: Hex }[];

  return decoded.map((d) => ({ success: d.success, returnData: d.returnData }));
}

// --- block clock --------------------------------------------------------

export interface BlockRef {
  number: number;
  timestamp: number;
}

/** Fetch a block header by number (or tag) and return just what we need. */
export async function getBlock(
  tag: string,
  opts: RpcEndpointOpts = {},
): Promise<BlockRef | null> {
  const b = (await rpc("eth_getBlockByNumber", [tag, false], opts)) as {
    number: string;
    timestamp: string;
  } | null;
  if (!b) return null;
  return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)) };
}

/**
 * Find the last block with timestamp at or before `targetSec`.
 *
 * At ~99 ms per block, a 30-day window is ~26 million blocks, so scanning is out of
 * the question. We seed from a linear estimate anchored on a known block and refine by
 * binary search, which converges in ~25 probes but typically far fewer because the
 * estimate is close.
 */
export async function blockAtOrBefore(
  targetSec: number,
  anchor: BlockRef,
  opts: RpcEndpointOpts = {},
): Promise<BlockRef> {
  // Walk to a window guaranteed to straddle the target. The anchor is normally "latest".
  if (targetSec >= anchor.timestamp) return anchor;

  let lo: BlockRef | undefined;
  let hi: BlockRef | undefined;

  const estBlocks = Math.max(
    1,
    Math.round(((anchor.timestamp - targetSec) * 1000) / 99), // ~99 ms/block
  );
  let guess = Math.max(1, anchor.number - estBlocks);

  for (let i = 0; i < 40; i++) {
    const b = await getBlock("0x" + guess.toString(16), opts);
    if (!b) throw new Error(`block ${guess} not found`);
    if (b.timestamp <= targetSec) {
      lo = b;
      // Probe forward for an upper bound.
      const upperNum = Math.min(anchor.number, guess + estBlocks + 1000);
      hi = (await getBlock("0x" + upperNum.toString(16), opts)) ?? anchor;
      break;
    }
    guess = Math.max(1, guess - Math.max(1000, Math.round(((b.timestamp - targetSec) * 1000) / 99)));
  }

  if (!lo || !hi) {
    // Could not bracket by estimation — fall back to a full binary search.
    const first = await getBlock("0x1", opts);
    if (!first) throw new Error("could not read block 1");
    lo = first;
    hi = anchor;
  }

  while (hi.number - lo.number > 1) {
    const mid = Math.floor((lo.number + hi.number) / 2);
    const b = await getBlock("0x" + mid.toString(16), opts);
    if (!b) break;
    if (b.timestamp <= targetSec) lo = b;
    else hi = b;
  }

  return lo;
}

/** Cache statistics as a plain object for writing into meta.json. */
export function cacheStats(): CacheStats {
  return { ...stats };
}


// --- log queries (design review B6) --------------------------------------

/**
 * eth_getLogs that never silently truncates.
 *
 * Providers cap by MATCHED LOGS, not block range. On a cap error we halve the range and
 * retry, recursively, until it succeeds. Any other error propagates. Nothing is swallowed.
 */
export async function getLogsSafe(
  filter: { address?: string | string[]; topics?: (string | null | string[])[] },
  fromBlock: number,
  toBlock: number,
  opts: RpcEndpointOpts = {},
): Promise<{ address: string; topics: string[]; data: string; blockNumber: string }[]> {
  const attempt = async (from: number, to: number): Promise<typeof result> => {
    const result = (await rpc(
      "eth_getLogs",
      [{
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        ...(filter.address ? { address: filter.address } : {}),
        ...(filter.topics ? { topics: filter.topics } : {}),
      }],
      opts,
    )) as { address: string; topics: string[]; data: string; blockNumber: string }[];
    return result;
  };

  try {
    return await attempt(fromBlock, toBlock);
  } catch (err) {
    const msg = String((err as Error).message);
    const isCap = msg.includes("exceeds limit") || msg.includes("-32005") || msg.includes("query returned more than");
    if (!isCap) throw err;
    if (toBlock - fromBlock <= 1) {
      // A single block that still trips the cap: genuinely unpartitionable. Fail loudly.
      throw new Error(
        `log query capped even at a single block ${fromBlock}; refusing to truncate silently`,
      );
    }
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsSafe(filter, fromBlock, mid, opts);
    const right = await getLogsSafe(filter, mid + 1, toBlock, opts);
    return [...left, ...right];
  }
}
