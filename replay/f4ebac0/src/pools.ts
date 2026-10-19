/**
 * pools.ts — pool discovery and TWAP (spec v1.1 §5.6).
 *
 * Corrections to spec v1.0 that this module encodes:
 *
 *  - §5.6 says "discover token/USDG pools". On 4663 the deepest Stock Token pool is
 *    AAPL/**WETH**, not AAPL/USDG. Advancing the quote asset from USDG to WETH is fine,
 *    but the resulting price is denominated in ETH, so it must be converted to USD with
 *    the Chainlink ETH/USD feed before it can be compared to a USD-denominated equity feed.
 *
 *  - The Uniswap v3 factory is NOT at the canonical mainnet address. Verified by reading
 *    factory() on a real UniswapV3Pool (0x8bb3514e…).
 *
 *  - The Uniswap v4 PoolManager is also not canonical; the usual 0x000…4444 address is
 *    not deployed here. v3 is preferred anyway because observe() gives a built-in TWAP,
 *    with no swap-log scan.
 *
 * This module is shared by the replay and the live service.
 */

import { encodeFunctionData, decodeFunctionResult, type Hex } from "viem";
import {
  UNISWAP_V3_FACTORY, V3_FACTORY_ABI, V3_POOL_ABI, V3_FEE_TIERS,
  USDG, WETH, ERC20_ABI,
} from "./chain.ts";
import { multicall3, type SubCall, type RpcEndpointOpts } from "./rpc.ts";

export interface PoolCandidate {
  address: string;
  venue: "uniswap-v3";
  fee: number;
  token0: string;
  token1: string;
  /** Which side of the pair the Stock Token is on. */
  tokenIsToken0: boolean;
  quote: string;
  liquidity: bigint;
}

export interface PoolReading {
  address: string;
  fee: number;
  quote: string;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  observationCardinality: number;
  /** Raw pool price of one Stock Token, denominated in the quote asset. */
  priceInQuote: number;
  /** Pool price in USD, after the quote→USD conversion. */
  priceUsd: number;
  /** 30-minute TWAP in USD, or null if the pool cannot serve one. */
  twap30mUsd: number | null;
  /** Why a TWAP is unavailable, when it is. */
  twapUnavailableReason?: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function enc(abi: readonly unknown[], fn: string, args: unknown[] = []): Hex {
  return encodeFunctionData({ abi, functionName: fn, args } as never) as Hex;
}

/**
 * Find the deepest v3 pool for a token against each candidate quote asset, at one block.
 *
 * `quotes` defaults to [WETH, USDG] — WETH first because that is where the liquidity
 * actually is on this chain.
 */
export async function discoverPools(
  token: string,
  blockTag: string,
  quotes: readonly string[] = [WETH, USDG],
  opts: RpcEndpointOpts = {},
): Promise<PoolCandidate[]> {
  // 1. Ask the factory for a pool at every (quote, fee) combination.
  const probes: SubCall[] = [];
  const keys: { quote: string; fee: number }[] = [];
  for (const quote of quotes) {
    for (const fee of V3_FEE_TIERS) {
      probes.push({
        target: UNISWAP_V3_FACTORY,
        callData: enc(V3_FACTORY_ABI, "getPool", [token, quote, fee]),
        allowFailure: true,
      });
      keys.push({ quote, fee });
    }
  }

  const found = await multicall3(probes, blockTag, opts);
  const addresses: { address: string; quote: string; fee: number }[] = [];
  for (let i = 0; i < found.length; i++) {
    const r = found[i];
    if (!r.success || r.returnData === "0x") continue;
    const addr = ("0x" + r.returnData.slice(-40)) as string;
    if (addr.toLowerCase() === ZERO) continue;
    addresses.push({ address: addr, quote: keys[i].quote, fee: keys[i].fee });
  }
  if (addresses.length === 0) return [];

  // 2. Read token0/token1 and liquidity for each, in one more multicall.
  const reads: SubCall[] = [];
  for (const a of addresses) {
    reads.push({ target: a.address, callData: enc(V3_POOL_ABI, "token0"), allowFailure: false });
    reads.push({ target: a.address, callData: enc(V3_POOL_ABI, "token1"), allowFailure: false });
    reads.push({ target: a.address, callData: enc(V3_POOL_ABI, "liquidity"), allowFailure: false });
  }
  const res = await multicall3(reads, blockTag, opts);

  const out: PoolCandidate[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i];
    const t0r = res[i * 3], t1r = res[i * 3 + 1], lqr = res[i * 3 + 2];
    if (!t0r?.success || !t1r?.success) continue;
    const token0 = ("0x" + t0r.returnData.slice(-40)).toLowerCase();
    const token1 = ("0x" + t1r.returnData.slice(-40)).toLowerCase();
    const liquidity = lqr?.success
      ? (decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "liquidity", data: lqr.returnData }) as bigint)
      : 0n;
    out.push({
      address: a.address,
      venue: "uniswap-v3",
      fee: a.fee,
      token0,
      token1,
      tokenIsToken0: token0 === token.toLowerCase(),
      quote: a.quote,
      liquidity,
    });
  }

  // Deepest first. Raw liquidity units are comparable only within the same fee tier
  // family, but for discovery that is good enough; the caller re-checks USD value.
  out.sort((x, y) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0));
  return out;
}

/** sqrtPriceX96 → price of token1 in units of token0, as a float. */
function priceFromSqrtX96(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const q = Number(sqrtPriceX96) / 2 ** 96;
  const raw = q * q; // token1 per token0, in raw units
  return raw * 10 ** (dec0 - dec1);
}

/**
 * Read a pool's state and 30-minute TWAP at a pinned block.
 *
 * TWAP is computed from observe([POOL_TWAP_SEC, 0]): the delta in cumulative tick divided
 * by the elapsed seconds, then converted to a price. This needs the pool to have kept
 * enough observations — `observationCardinality` tells us — so we surface a reason rather
 * than silently returning spot.
 */
export async function readPool(
  cand: PoolCandidate,
  blockTag: string,
  opts: RpcEndpointOpts & { twapSeconds?: number } = {},
): Promise<PoolReading | null> {
  const twapSeconds = opts.twapSeconds ?? 1800;

  const calls: SubCall[] = [
    { target: cand.address, callData: enc(V3_POOL_ABI, "slot0"), allowFailure: false },
    { target: cand.address, callData: enc(V3_POOL_ABI, "liquidity"), allowFailure: false },
    { target: cand.quote, callData: enc(ERC20_ABI, "decimals"), allowFailure: false },
    { target: cand.address, callData: enc(V3_POOL_ABI, "observe", [[twapSeconds, 0]]), allowFailure: true },
  ];
  const tokenDecimalsCall: SubCall = {
    target: cand.tokenIsToken0 ? cand.token0 : cand.token1,
    callData: enc(ERC20_ABI, "decimals"),
    allowFailure: false,
  };
  calls.push(tokenDecimalsCall);

  const r = await multicall3(calls, blockTag, opts);
  if (!r[0]?.success) return null;

  const slot0 = decodeFunctionResult({
    abi: V3_POOL_ABI, functionName: "slot0", data: r[0].returnData,
  }) as readonly [bigint, number, number, number, number, number, boolean];

  const sqrtPriceX96 = slot0[0];
  const tick = Number(slot0[1]);
  const observationCardinality = Number(slot0[3]);
  const liquidity = r[1]?.success
    ? (decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "liquidity", data: r[1].returnData }) as bigint)
    : 0n;

  const quoteDecimals = r[2]?.success
    ? Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: r[2].returnData }))
    : 18;
  const tokenDecimals = r[4]?.success
    ? Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: r[4].returnData }))
    : 18;

  // priceFromSqrtX96 gives token1-per-token0. Map that onto "Stock Token per quote asset"
  // depending on which side our token sits.
  const dec0 = cand.tokenIsToken0 ? tokenDecimals : quoteDecimals;
  const dec1 = cand.tokenIsToken0 ? quoteDecimals : tokenDecimals;
  const token1PerToken0 = priceFromSqrtX96(sqrtPriceX96, dec0, dec1);
  const priceInQuote = cand.tokenIsToken0 ? token1PerToken0 : 1 / token1PerToken0;

  let twap30mUsd: number | null = null;
  let twapUnavailableReason: string | undefined;

  if (!r[3]?.success) {
    twapUnavailableReason = "observe() reverted — pool has insufficient observation history";
  } else {
    try {
      const obs = decodeFunctionResult({
        abi: V3_POOL_ABI, functionName: "observe", data: r[3].returnData,
      }) as readonly [readonly bigint[], readonly bigint[]];
      const cum = obs[0];
      const delta = Number(cum[1] - cum[0]);
      const avgTick = delta / twapSeconds;
      // Same side-mapping as the spot price above.
      const raw = Math.pow(1.0001, avgTick);
      twap30mUsd = cand.tokenIsToken0 ? raw : 1 / raw;
    } catch (e) {
      twapUnavailableReason = `observe() decode failed: ${(e as Error).message}`;
    }
  }

  // The caller supplies the quote→USD rate (ETH/USD feed for a WETH-quoted pool).
  return {
    address: cand.address,
    fee: cand.fee,
    quote: cand.quote,
    liquidity,
    sqrtPriceX96,
    tick,
    observationCardinality,
    priceInQuote,
    priceUsd: priceInQuote, // replaced by the caller once quoteUsd is known
    twap30mUsd,
    twapUnavailableReason,
  };
}

/**
 * Convert a quote-denominated price (or TWAP) to USD.
 *
 * `quoteUsd` is 1 for USDG and the Chainlink ETH/USD answer for a WETH-quoted pool —
 * which is exactly why ETH/USD is read alongside the equity feed in every snapshot.
 */
export function quoteToUsd(
  reading: PoolReading,
  quoteUsd: number,
): PoolReading {
  return {
    ...reading,
    priceUsd: reading.priceInQuote * quoteUsd,
    twap30mUsd: reading.twap30mUsd === null ? null : reading.twap30mUsd * quoteUsd,
  };
}
