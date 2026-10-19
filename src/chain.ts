/**
 * chain.ts — verified constants for Robinhood Chain (4663).
 *
 * Rule (§14.3): nothing here may be hardcoded until it has been verified live.
 * Every address below carries its evidence. See docs/verification-log.md.
 */

import { parseAbi } from "viem";

export const CHAIN_ID = 4663;

/** Robinhood's public RPC. NOTE: serves `latest` fine, but has NO historical state. */
export const RPC_LATEST = "https://rpc.mainnet.chain.robinhood.com";

/**
 * Archive RPC. Verified 2026-10-15: serves full historical state from genesis
 * (eth_getBalance at block 0x1 → 0x0; feed reads at blocks 50,331,648 / 75,497,472 /
 * 88,080,384 all returned distinct historical values).
 * It is rate-limited and bursts trigger a temporary ban — drive it politely.
 * Two hostnames front the same backend and can be round-robined.
 */
export const RPC_ARCHIVE_POOL = [
  "https://robinhood-chain.rpc.thirdweb.com",
  "https://4663.rpc.thirdweb.com",
  // Verified 2026-10-15 in replay/probe-archive.py: dRPC answers historical eth_call at
  // 0%/10%/25%/50%/75%/100%-of-chain blocks. A second provider matters because a
  // load-balanced backend can serve `latest` but not historical state.
  "https://robinhood.drpc.org",
] as const;

/** Multicall3. Verified deployed on 4663 (eth_getCode → 3,809 bytes). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** Canonical quote assets, from Robinhood's Token Contracts page. USDG verified live (decimals 6). */
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;

/**
 * Uniswap v3 factory on 4663. NOT the canonical mainnet address.
 * Verified by reading factory() on a real UniswapV3Pool (0x8bb3514e…).
 */
export const UNISWAP_V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as const;

/**
 * Uniswap v4 PoolManager on 4663. Also NOT the canonical address (the canonical
 * 0x000…4444c5dc75cB358380D2e3dE08A90 is NOT deployed here; eth_getCode → 0x).
 * Identified as "PoolManager" and verified on Blockscout.
 */
export const UNISWAP_V4_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;

/** Chainlink ETH/USD feed on 4663 (crypto feed, 8 decimals). Needed to value WETH-quoted pools in USD. */
export const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as const;

/**
 * NO Chainlink L2 Sequencer Uptime Feed exists on 4663.
 * Chainlink lists 11 other networks and states it is "no longer expanding" the product.
 * We therefore infer sequencer health from L2 block production (§3.3 SEQUENCER_STALE).
 *
 * Robinhood's native Arbitrum-style feed (live only, NOT replayable — a WebSocket has no history):
 *   wss://feed.mainnet.chain.robinhood.com
 *   wss://delayed-feed.mainnet.chain.robinhood.com   (~500 ms behind, documented as the fallback)
 */
export const SEQUENCER_WS_PRIMARY = "wss://feed.mainnet.chain.robinhood.com" as const;
export const SEQUENCER_WS_BACKUP = "wss://delayed-feed.mainnet.chain.robinhood.com" as const;

/** Block clock. Measured 2026-10-15: ~99 ms/block (~10 blocks/sec). */
export const APPROX_BLOCK_MS = 99;

// ---------------------------------------------------------------------------
// ABIs — human-readable, for viem. Every selector was confirmed against the
// deployed bytecode dispatch table of the Stock implementation and called live.
// ---------------------------------------------------------------------------

/** Stock token, implementation `0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2` (src/Stock.sol). */
export const STOCK_ABI = parseAbi([
  "function uid() view returns (bytes32)",
  "function decimals() view returns (uint8)",
  "function oraclePaused() view returns (bool)",   // 0x7706ba52
  "function uiMultiplier() view returns (uint256)", // 0xa60bf13d
  "function newUIMultiplier() view returns (uint256)", // 0xdc767007
  "function effectiveAt() view returns (uint256)", // 0x97a4064f
  "function tokenPaused() view returns (bool)",   // 0x86c75e74 — NOT in spec v1.0
  "function paused() view returns (bool)",        // 0x5c975abb — token OR registry-wide
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

/** Chainlink AggregatorV3Interface. */
export const AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

/** Uniswap v3 pool — built-in TWAP via observe(), so no swap-log scan is needed. */
export const V3_POOL_ABI = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function token0Decimals() view returns (uint8)",
]);

export const V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

export const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/** Uniswap v3 fee tiers worth probing on this chain. */
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Chainlink AnswerUpdated topic — checked, and the equity feeds emit NO logs at all. */
export const ANSWER_UPDATED_TOPIC =
  "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f" as const;

/** Uniswap v3 Swap event topic — used to rank tokens by on-chain volume. */
export const V3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as const;

/** Public RPC caps eth_getLogs at 10,000 matched logs per query. */
export const GETLOGS_MAX_LOGS = 10_000;
