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
import { readFileSync } from "node:fs";
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
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
