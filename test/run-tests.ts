/**
 * run-tests.ts — the whole test suite, no test framework.
 *
 * Node 18's node:test is experimental and the extra dependency is not worth it for a library this
 * size. This harness fails loudly and exits non-zero.
 *
 * Run: npx tsx test/run-tests.ts
 */

import { loadCalendar, makeHolidaySet, makeEarlyCloseMap, sessionAt, feedMode } from "../src/sessions.ts";
import { coverageYears, calendarCovers, coverageLabel } from "../src/sessions-guard.ts";
import { evaluate } from "../src/rules.ts";
import { DEFAULT_POLICY, type Policy } from "../src/policy.ts";
import type { Snapshot } from "../src/types.ts";
import { check as checkToken } from "../src/index.ts";
import {
  resolveRpcUrls, resolveReqPerSec, endpointLabels, configureEndpoints, isCacheable,
  RpcConfigError,
} from "../src/rpc.ts";
import { MULTICALL3_ABI, RPC_ARCHIVE_POOL } from "../src/chain.ts";
import { encodeFunctionResult } from "viem";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
const cal = loadCalendar(fileURLToPath(new URL("../calendar/nyse-holidays.json", import.meta.url)));
const holidays = makeHolidaySet(cal);
const earlyCloses = makeEarlyCloseMap(cal);

/** ET wall clock -> UTC instant, resolving the offset at that instant. */
function etToUtc(y: number, mo: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const off = (t: number): number => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const x of dtf.formatToParts(new Date(t))) p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - t) / 1000);
  };
  let t = guess - off(guess) * 1000;
  t = guess - off(t) * 1000;
  return t;
}

const boundary: Array<[string, number, string]> = [
  ["Fri 15:59 ET is REGULAR", etToUtc(2026, 9, 11, 15, 59), "REGULAR"],
  ["Fri 16:00 ET is POST_MARKET", etToUtc(2026, 9, 11, 16, 0), "POST_MARKET"],
  ["Fri 19:59 ET is still open", etToUtc(2026, 9, 11, 19, 59), "POST_MARKET"],
  ["Fri 20:00 ET is CLOSED_WEEKEND", etToUtc(2026, 9, 11, 20, 0), "CLOSED_WEEKEND"],
  ["Sun 19:59 ET is CLOSED_WEEKEND", etToUtc(2026, 9, 13, 19, 59), "CLOSED_WEEKEND"],
  ["Sun 20:00 ET is OVERNIGHT", etToUtc(2026, 9, 13, 20, 0), "OVERNIGHT"],
  ["Labor Day midday is CLOSED_HOLIDAY", etToUtc(2026, 9, 7, 12, 0), "CLOSED_HOLIDAY"],
  ["Labor Day 20:00 ET reopens", etToUtc(2026, 9, 7, 20, 0), "OVERNIGHT"],
  ["pre-holiday Sunday evening stays closed", etToUtc(2026, 9, 6, 20, 0), "CLOSED_WEEKEND"],
  ["half day 12:00 ET is REGULAR", etToUtc(2026, 11, 27, 12, 0), "REGULAR"],
  ["half day 17:00 ET is closed", etToUtc(2026, 11, 27, 17, 0), "CLOSED_WEEKEND"],
];
for (const [name, ms, expect] of boundary) {
  eq(name, sessionAt(ms, holidays, earlyCloses).session, expect);
}

// The Friday 16:00-20:00 window was a real bug: Robinhood's 24 Hour Market runs to Fri 20:00 ET.
check("Friday post-market window exists (24h market runs to 20:00 ET)",
  sessionAt(etToUtc(2026, 9, 11, 18, 0), holidays, earlyCloses).session === "POST_MARKET");

// DST must actually change, or the boundary tests prove nothing.
const dstA = etToUtc(2026, 10, 15, 12, 0), dstB = etToUtc(2026, 11, 15, 12, 0);
check("DST offset differs across 2026-11-01",
  (dstA - Date.UTC(2026, 9, 15, 12, 0)) !== (dstB - Date.UTC(2026, 10, 15, 12, 0)));

// feed.mode must distinguish a live price from a smoothed or frozen one.
eq("REGULAR feed mode is live", feedMode("REGULAR"), "live");
eq("OVERNIGHT feed mode is ema_overnight", feedMode("OVERNIGHT"), "ema_overnight");
eq("CLOSED_WEEKEND feed mode is frozen_closed", feedMode("CLOSED_WEEKEND"), "frozen_closed");
eq("CLOSED_HOLIDAY feed mode is frozen_closed", feedMode("CLOSED_HOLIDAY"), "frozen_closed");

// Coverage guard
const years = coverageYears(cal);
check("calendar covers 2027", years.includes(2027), `years=${years.join(",")}`);
check("calendar covers 2026", years.includes(2026));
check("a 2026 date is covered", calendarCovers(cal, etToUtc(2026, 9, 15, 12, 0)));
check("a 2027 date is covered", calendarCovers(cal, etToUtc(2027, 3, 15, 12, 0)));
check("a 2028 date is NOT covered", !calendarCovers(cal, etToUtc(2028, 3, 15, 12, 0)));
check("a 2019 date is NOT covered", !calendarCovers(cal, etToUtc(2019, 3, 15, 12, 0)));
check("coverage label is a range", /^\d{4}–\d{4}$/.test(coverageLabel(cal)), coverageLabel(cal));

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
const T = etToUtc(2026, 9, 15, 12, 0) / 1000;

function base(over: Partial<Snapshot> = {}): Snapshot {
  return {
    token: "0x0000000000000000000000000000000000000001",
    symbol: "AAPL",
    uid: null,
    blockNumber: 63_000_000,
    blockTime: T,
    purpose: "trade",
    session: "REGULAR",
    feedMode: "live",
    feed: { answer: 100_00000000n, decimals: 8, updatedAt: T - 60, roundId: 1n },
    tokenState: {
      oraclePaused: false, tokenPaused: false, paused: false,
      // Mirrors the real contract when nothing is staged: newUIMultiplier equals uiMultiplier, and
      // effectiveAt() returns a PAST timestamp rather than null (fact F6). A null here means the
      // read failed, which is a different thing and must not be modelled as "nothing staged".
      uiMultiplier: 1_000_000000000000000n,
      newUIMultiplier: 1_000_000000000000000n,
      effectiveAt: T - 86_400,
    },
    reference: null,
    reopening: { lastReopenAt: null, hasUpdatedSinceReopen: null },
    sequencer: {
      latestBlockAgeSec: 1, measurement: "head_age",
      blockRatePerSec: 10, longestInterBlockGapSec: null,
    },
    corpActionInProgress: false,
    ...over,
  };
}

const P: Policy = DEFAULT_POLICY;

function codes(s: Snapshot, p: Policy = P): string[] {
  const v = evaluate(s, p);
  return [...v.blockingCodes, ...v.warningCodes];
}

// A healthy sample must be safe and must NOT invent pool codes when the pool check is off.
{
  const c = codes(base());
  check("healthy sample is safe", evaluate(base(), P).safe, c.join(","));
  check("pool check OFF emits no pool codes",
    !c.some((x) => x.startsWith("POOL_") || x === "REFERENCE_UNAVAILABLE"), c.join(","));
}

// Failed reads are SOURCE_UNAVAILABLE, never a default value.
for (const [name, over] of [
  ["feed answer null", { feed: { answer: null, decimals: 8, updatedAt: T - 60, roundId: null } }],
  ["feed updatedAt null", { feed: { answer: 100_00000000n, decimals: 8, updatedAt: null, roundId: null } }],
] as const) {
  const c = codes(base(over as Partial<Snapshot>));
  check(`failed read (${name}) is SOURCE_UNAVAILABLE`, c.includes("SOURCE_UNAVAILABLE"), c.join(","));
  check(`failed read (${name}) is not safe`, !evaluate(base(over as Partial<Snapshot>), P).safe);
}

// A failed multiplier read must not read as "no change pending".
for (const [name, over] of [
  ["oraclePaused null", { tokenState: { ...base().tokenState, oraclePaused: null } }],
  ["tokenPaused null", { tokenState: { ...base().tokenState, tokenPaused: null } }],
  ["paused null", { tokenState: { ...base().tokenState, paused: null } }],
  ["uiMultiplier null", { tokenState: { ...base().tokenState, uiMultiplier: null } }],
  ["newUIMultiplier null", { tokenState: { ...base().tokenState, newUIMultiplier: null } }],
  ["effectiveAt null", { tokenState: { ...base().tokenState, effectiveAt: null } }],
] as const) {
  const c = codes(base(over as Partial<Snapshot>));
  check(`failed read (${name}) is SOURCE_UNAVAILABLE`, c.includes("SOURCE_UNAVAILABLE"), c.join(","));
}

// Pause flags
{
  const c = codes(base({ tokenState: { ...base().tokenState, oraclePaused: true } }));
  check("oraclePaused true blocks", c.includes("ORACLE_PAUSED"), c.join(","));
}
{
  const c = codes(base({ tokenState: { ...base().tokenState, tokenPaused: true } }));
  check("tokenPaused true blocks", c.includes("TOKEN_PAUSED"), c.join(","));
}
{
  const c = codes(base({ tokenState: { ...base().tokenState, paused: true } }));
  check("registry paused blocks", c.includes("REGISTRY_PAUSED"), c.join(","));
}

// Closed market
{
  const s = base({ session: "CLOSED_WEEKEND", feedMode: "frozen_closed" });
  const c = codes(s);
  check("closed weekend is MARKET_CLOSED", c.includes("MARKET_CLOSED"), c.join(","));
  check("MARKET_CLOSED blocks a trade", evaluate(s, P).safe === false);
  const price = evaluate({ ...s, purpose: "price" }, P);
  check("MARKET_CLOSED only warns for a price use",
    price.safe === true && price.warningCodes.includes("MARKET_CLOSED"),
    price.warningCodes.join(","));
}

// A feed still showing the pre-closure price after the reopen is unsafe (decision B).
{
  const reopenAt = T - 3600;
  const s = base({
    session: "OVERNIGHT", feedMode: "ema_overnight",
    feed: { answer: 100_00000000n, decimals: 8, updatedAt: reopenAt - 7200, roundId: 1n },
    reopening: { lastReopenAt: reopenAt, hasUpdatedSinceReopen: false },
  });
  const c = codes(s);
  check("feed not updated since reopen is FEED_AWAITING_REOPEN_UPDATE",
    c.includes("FEED_AWAITING_REOPEN_UPDATE"), c.join(","));
}

// Heartbeat backstop: open, no reopen, age beyond heartbeat + grace.
{
  const s = base({ feed: { answer: 100_00000000n, decimals: 8, updatedAt: T - (86_400 + 900), roundId: 1n } });
  const c = codes(s);
  check("age beyond heartbeat+grace is FEED_STALE_OPEN", c.includes("FEED_STALE_OPEN"), c.join(","));
}

// Sequencer stall
{
  const s = base({
    sequencer: { latestBlockAgeSec: 120, measurement: "head_age", blockRatePerSec: 10, longestInterBlockGapSec: null },
  });
  const c = codes(s);
  check("stale sequencer blocks", c.includes("SEQUENCER_STALE"), c.join(","));
}

// Pool rules only exist when explicitly enabled.
{
  const on: Policy = { ...P, POOL_CHECK_ENABLED: true };
  const c = codes(base(), on);
  check("pool check ON emits REFERENCE_UNAVAILABLE when there is no reference",
    c.includes("REFERENCE_UNAVAILABLE"), c.join(","));
}

// The feed map must not silently lose its provenance.
{
  const map = JSON.parse(readFileSync(new URL("../data/feed-map.json", import.meta.url), "utf8"));
  const syms = Object.keys(map);
  eq("feed map has 35 tokens", syms.length, 35);
  const unlisted = syms.filter((s) => map[s].chainlinkListed === false).sort();
  eq("SGOV and USAR are marked not listed by Chainlink", unlisted.join(","), "SGOV,USAR");
  const missing = syms.filter((s) => !map[s].source || !map[s].feed || !map[s].token);
  eq("every feed has an address and a source", missing.length, 0);
}

// ---------------------------------------------------------------------------
// RPC endpoints (v0.1.1). No network: fetch is replaced by a fake chain for these tests only.
// ---------------------------------------------------------------------------
{
  // Low-entropy placeholders, shaped like keyed provider URLs. None of these hosts exist.
  const A = "https://provider-a.example/v2/test-key-aaaa";
  const B = "https://provider-b.example/v2/test-key-bbbb";
  const C = "https://provider-c.example/v2/test-key-cccc";
  const WRONG = "https://provider-w.example/v2/test-key-wwww";
  const ECHO = "https://provider-e.example/v2/test-key-eeee";
  const SECRETS = [A, B, C, WRONG, ECHO, "test-key-"];

  type Mode = "ok" | "wrongChain" | "echo400";
  const modeOf = (url: string): Mode => (url === WRONG ? "wrongChain" : url === ECHO ? "echo400" : "ok");
  let throttleAll = false;
  let head = 63_000_000;
  const calls: { url: string; method: string }[] = [];
  const realFetch = globalThis.fetch;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const aggregateAllFailed = encodeFunctionResult({
    abi: MULTICALL3_ABI, functionName: "aggregate3",
    result: Array.from({ length: 13 }, () => ({ success: false, returnData: "0x" as const })),
  } as never);

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const req = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    calls.push({ url, method: req.method });
    if (throttleAll) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    const mode = modeOf(url);
    if (req.method === "eth_chainId") return json({ jsonrpc: "2.0", id: 1, result: mode === "wrongChain" ? "0x1" : "0x1237" });
    if (mode === "echo400") return new Response(`bad request for ${url}`, { status: 400 });
    if (req.method === "eth_getBlockByNumber") {
      head += 1;
      return json({ jsonrpc: "2.0", id: 1, result: { number: "0x" + head.toString(16), timestamp: "0x" + T.toString(16) } });
    }
    if (req.method === "eth_call") return json({ jsonrpc: "2.0", id: 1, result: aggregateAllFailed });
    return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
  }) as typeof fetch;

  // Everything printed while these tests run, so it can be searched for a URL afterwards.
  let printed = "";
  const origLog = console.log, origWarn = console.warn, origErr = console.error;
  const origStderr = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => { printed += a.map(String).join(" ") + "\n"; };
  console.warn = (...a: unknown[]) => { printed += a.map(String).join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { printed += a.map(String).join(" ") + "\n"; };
  process.stderr.write = ((chunk: unknown) => { printed += String(chunk); return true; }) as typeof process.stderr.write;

  const savedEnv = { urls: process.env.STOCK_CHECK_RPC_URLS, rps: process.env.STOCK_CHECK_RPS };
  delete process.env.STOCK_CHECK_RPC_URLS;
  delete process.env.STOCK_CHECK_RPS;
  const cacheDir = mkdtempSync(join(tmpdir(), "stc-test-"));
  const fast = { cacheDir, reqPerSec: 1000 };
  const urlsSince = (n: number, methodFilter?: (m: string) => boolean): string[] =>
    calls.slice(n).filter((c) => !methodFilter || methodFilter(c.method)).map((c) => c.url);
  let outputs = "";

  try {
    // 1. Unset variable: the default pool is used.
    eq("unset STOCK_CHECK_RPC_URLS resolves to the defaults", resolveRpcUrls(undefined, undefined), null);
    eq("blank STOCK_CHECK_RPC_URLS resolves to the defaults", resolveRpcUrls(undefined, "  "), null);
    eq("unset STOCK_CHECK_RPS is 2.5", resolveReqPerSec(undefined, undefined), 2.5);
    {
      const n = calls.length;
      const r = await checkToken("AAPL", "trade", fast);
      outputs += JSON.stringify(r);
      const used = urlsSince(n);
      check("default pool: requests were made", used.length > 0);
      check("default pool: every request went to a built-in endpoint",
        used.every((u) => (RPC_ARCHIVE_POOL as readonly string[]).includes(u)), used.join(","));
      eq("default pool: labels are the built-in URLs", endpointLabels().join(","), RPC_ARCHIVE_POOL.join(","));
      check("default pool: no chain-ID probe on the built-in endpoints",
        !calls.slice(n).some((c) => c.method === "eth_chainId"));
    }

    // Stale head (v0.1.1 fix): "latest" is read from the chain every time, never from the cache.
    {
      const r1 = await checkToken("AAPL", "trade", fast);
      const r2 = await checkToken("AAPL", "trade", fast);
      outputs += JSON.stringify(r1) + JSON.stringify(r2);
      check("a second check reads a new head, not the cached one",
        r2.inputs.blockNumber > r1.inputs.blockNumber, `${r1.inputs.blockNumber} then ${r2.inputs.blockNumber}`);
      check("a request for 'latest' is not cacheable", !isCacheable("eth_getBlockByNumber", ["latest", false]));
      check("a request pinned to a block is cacheable", isCacheable("eth_call", [{ to: "0x1", data: "0x" }, "0x3c14dc0"]));
    }

    // Throttling: endpoints that keep refusing give SOURCE_UNAVAILABLE, never an exception or a value.
    {
      throttleAll = true;
      const r = await checkToken("MSFT", "trade", fast);
      throttleAll = false;
      outputs += JSON.stringify(r);
      check("throttled: verdict is not safe", r.verdict.safe === false);
      eq("throttled: the blocking code is SOURCE_UNAVAILABLE", r.verdict.blockingCodes.join(","), "SOURCE_UNAVAILABLE");
      eq("throttled: no feed value is filled in", r.inputs.feedAnswer, null);
    }

    // 2. Set variable: only the custom URLs are used, in rotation.
    {
      process.env.STOCK_CHECK_RPC_URLS = ` ${A} , ${B} `;
      const n = calls.length;
      const r1 = await checkToken("AAPL", "trade", fast);
      const r2 = await checkToken("AAPL", "trade", fast);
      outputs += JSON.stringify(r1) + JSON.stringify(r2);
      const used = urlsSince(n);
      check("custom pool: only the custom URLs were contacted",
        used.length > 0 && used.every((u) => u === A || u === B), [...new Set(used)].length + " hosts");
      const probed = urlsSince(n, (m) => m === "eth_chainId");
      eq("custom pool: each URL's chain ID checked once, in order", probed.join(","), `${A},${B}`);
      const work = urlsSince(n, (m) => m !== "eth_chainId");
      check("custom pool: requests rotate A, B, A, B, ...",
        work.length >= 4 && work.every((u, i) => u === (i % 2 === 0 ? A : B)),
        work.map((u) => (u === A ? "A" : u === B ? "B" : "?")).join(""));
      eq("custom pool: labels are custom-1, custom-2", endpointLabels().join(","), "custom-1,custom-2");
    }

    // 3. The option overrides the variable.
    {
      process.env.STOCK_CHECK_RPC_URLS = `${A},${B}`;
      const n = calls.length;
      const r = await checkToken("AAPL", "trade", { ...fast, rpcUrls: [C] });
      outputs += JSON.stringify(r);
      const used = urlsSince(n);
      check("rpcUrls option overrides STOCK_CHECK_RPC_URLS",
        used.length > 0 && used.every((u) => u === C), [...new Set(used)].length + " hosts");
      eq("reqPerSec option overrides STOCK_CHECK_RPS", resolveReqPerSec(7, "3"), 7);
      eq("STOCK_CHECK_RPS is read when no option is given", resolveReqPerSec(undefined, "1.5"), 1.5);
      delete process.env.STOCK_CHECK_RPC_URLS;
    }

    // 4. A bad scheme, an empty entry and a wrong chain ID are each refused with a clear error.
    const refused = (fn: () => unknown): string => {
      try { fn(); return ""; } catch (e) { return e instanceof RpcConfigError ? e.message : "WRONG TYPE: " + String(e); }
    };
    {
      const m = refused(() => resolveRpcUrls(["http://provider-a.example/v2/test-key-aaaa"]));
      check("plain http is refused", /RPC URL 1 must start with https:\/\//.test(m), m);
      check("the refusal does not echo the URL", !m.includes("test-key"), m);
      const m2 = refused(() => resolveRpcUrls(undefined, `${A},,${B}`));
      check("an empty entry is refused, naming its position", m2 === "RPC URL 2 is empty", m2);
      const m3 = refused(() => resolveRpcUrls(undefined, `${A},`));
      check("a trailing comma is an empty entry, refused", m3 === "RPC URL 2 is empty", m3);
      const m4 = refused(() => resolveRpcUrls(["http://localhost.provider-a.example/x"]));
      check("http://localhost.<other host> is refused", /must start with https/.test(m4), m4);
      check("http://localhost:8545 is allowed", refused(() => resolveRpcUrls(["http://localhost:8545"])) === "");
      check("http://127.0.0.1 is allowed", refused(() => resolveRpcUrls(["http://127.0.0.1/rpc"])) === "");
      const m5 = refused(() => resolveReqPerSec(undefined, "fast"));
      check("a non-numeric STOCK_CHECK_RPS is refused", /STOCK_CHECK_RPS must be a positive number/.test(m5), m5);

      process.env.STOCK_CHECK_RPC_URLS = "ftp://provider-a.example/x";
      let threw = "";
      try { await checkToken("AAPL", "trade", fast); } catch (e) { threw = (e as Error).message; }
      check("an invalid variable is an error, not a fall back to the defaults", /RPC URL 1 must start with https/.test(threw), threw);
      delete process.env.STOCK_CHECK_RPC_URLS;

      const n = calls.length;
      let wrong = "";
      let isConfig = false;
      try {
        await checkToken("AAPL", "trade", { ...fast, rpcUrls: [C, WRONG] });
      } catch (e) {
        wrong = (e as Error).message;
        isConfig = e instanceof RpcConfigError;
      }
      outputs += wrong;
      check("a wrong chain ID is refused, naming URL 2", wrong.startsWith("URL 2 is not Robinhood Chain"), wrong);
      check("a wrong chain ID is a configuration error, not a verdict", isConfig);
      check("a wrong chain ID: nothing but chain-ID probes was sent",
        calls.slice(n).every((c) => c.method === "eth_chainId"));
    }

    // An error from a custom endpoint that echoes its own URL back is redacted.
    {
      const r = await checkToken("AAPL", "trade", { ...fast, rpcUrls: [ECHO] });
      outputs += JSON.stringify(r);
      eq("an endpoint failure is SOURCE_UNAVAILABLE", r.verdict.blockingCodes.join(","), "SOURCE_UNAVAILABLE");
      const detail = r.verdict.reasons.map((x) => x.detail).join(" ");
      check("the failure names custom-1, not the URL", detail.includes("custom-1") && !detail.includes("test-key"), detail);
    }

    // 5. After runs with custom URLs, the cache folder and the output contain no URL.
    {
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p); else files.push(p);
        }
      };
      walk(cacheDir);
      const disk = files.map((f) => readFileSync(f, "utf8")).join("\n");
      check("the cache holds records to search", files.length > 0, String(files.length));
      check("cache records name custom endpoints by label", disk.includes('"endpoint":"custom-1"'));
      const haystack = disk + "\n" + printed + "\n" + outputs;
      const hits = SECRETS.filter((s) => haystack.includes(s));
      eq("custom URLs found in the cache folder and the output", hits.length, 0);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.log = origLog; console.warn = origWarn; console.error = origErr;
    process.stderr.write = origStderr as typeof process.stderr.write;
    if (savedEnv.urls === undefined) delete process.env.STOCK_CHECK_RPC_URLS; else process.env.STOCK_CHECK_RPC_URLS = savedEnv.urls;
    if (savedEnv.rps === undefined) delete process.env.STOCK_CHECK_RPS; else process.env.STOCK_CHECK_RPS = savedEnv.rps;
    configureEndpoints(null);
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
