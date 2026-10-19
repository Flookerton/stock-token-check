/**
 * run.ts — the Milestone 1 replay runner.
 *
 * Changes from pilot 2, per orchestrator Part B:
 *   B1  raw USD only; the uiMultiplier comparison mode is gone
 *   A2  the live /corporate-actions status is NOT used (it is a present-tense input)
 *   A3  every sample reads pool spot plus 5, 15 and 30-minute TWAPs at the same block
 *   B5  all 33 feed-backed tokens by default; sub-calls batched into a few multicalls
 *   B6  no silent errors: swallowed errors are counted and a non-zero count fails the run
 *
 * Usage:
 *   npx tsx replay/run.ts --from 2026-08-16T00:00:00Z --to 2026-09-14T23:59:59Z \
 *                         --out replay/out/calibration.csv --req 3
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

import {
  getBlock, blockAtOrBefore, configureCache, cacheStats, swallowedErrorCount,
  type BlockRef,
} from "../src/rpc.ts";
import { blockByEstimate, findLongestGap, measureInterval } from "../src/blocks.ts";
import { loadCalendar, makeHolidaySet, makeEarlyCloseMap, sessionAt, type SessionName } from "../src/sessions.ts";
import {
  loadFeedMap, readSnapshotBatch, readFailureCounts, readFailureTotal, type SnapshotInput,
} from "../src/snapshot.ts";
import { evaluate, multiplierChangeBps } from "../src/rules.ts";
import { loadPolicy } from "../src/policy.ts";
import { RPC_ARCHIVE_POOL, RPC_LATEST } from "../src/chain.ts";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (n: string) => process.argv.includes(`--${n}`);

const FROM = arg("from", "2026-08-16T00:00:00Z");
const TO = arg("to", "2026-09-14T23:59:59Z");
const OUT = arg("out", "replay/out/run.csv");
const REQ_PER_SEC = Number(arg("req", "3"));
const SAMPLE_SECONDS = Number(arg("step", "300"));
const POLICY_PATH = has("prereg") ? arg("prereg", "") : "";
const GAP_ZOOM_RATE_FLOOR = Number(arg("rateFloor", "8"));
const PRECISION = arg("precision", "second") as "exact" | "second";
const MAX_SUBCALLS = Number(arg("maxSubcalls", "180"));
const RESUME = has("resume");
/** A3: extra TWAP windows read at every sample. The primary is the policy's POOL_TWAP_SEC. */
const EXTRA_TWAP_WINDOWS = arg("twapWindows", "300,900").split(",").map(Number);

const ROOT = process.cwd();

// ---- working rule 11: refuse to start from uncommitted code -----------------
// A run that produces evidence must refuse to start from uncommitted code and must record the
// commit hash in meta.json. Evidence that cannot be tied to a revision cannot be reproduced, and
// a bad edit cannot be undone. The git check runs before anything is read or written.
const GIT_STATUS = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
if (GIT_STATUS) {
  console.error("refusing to run: the working tree is not clean (working rule 11).");
  console.error(GIT_STATUS);
  console.error("Commit or stash the changes first; evidence must be tied to a revision.");
  process.exit(1);
}
const GIT_COMMIT = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();

const feedMap = JSON.parse(readFileSync(join(ROOT, "replay/feed-map.json"), "utf8"));
loadFeedMap(feedMap);
const ALL_SYMBOLS: string[] = Object.keys(feedMap).sort();
const SYMBOLS = has("tokens") ? arg("tokens", "").split(",").map((s) => s.trim()) : ALL_SYMBOLS;

const cal = loadCalendar(join(ROOT, "calendar/nyse-holidays.json"));
const holidays = makeHolidaySet(cal);
const earlyCloses = makeEarlyCloseMap(cal);
const policy = loadPolicy(POLICY_PATH || undefined);
const twapWindows = [...new Set([policy.POOL_TWAP_SEC, ...EXTRA_TWAP_WINDOWS])].sort((a, b) => b - a);

const CSV_COLS = [
  "symbol", "sampleTime", "block", "blockTime", "session", "feedMode",
  "feedAnswer", "feedUpdatedAt", "feedAgeSec",
  "oraclePaused", "tokenPaused", "registryPaused",
  "uiMultiplier", "newUIMultiplier", "effectiveAt", "stagedChangeBps",
  "ethAnswer", "reopenAt", "updatedSinceReopen", "reopenWaitSec",
  "blockRatePerSec", "blocksInInterval", "longestInterBlockGapSec",
  "refVenue", "refAddress", "refQuote", "refQuoteUsd", "poolSpotUsd",
  ...twapWindows.map((w) => `dev${w}s`),
  "safe", "blockingCodes", "warnCodes",
];

const OPEN = new Set<SessionName>(["PRE_MARKET", "REGULAR", "POST_MARKET", "OVERNIGHT"]);

async function main(): Promise<void> {
  configureCache(join(ROOT, "replay/cache"), REQ_PER_SEC);
  mkdirSync(join(ROOT, "replay/out"), { recursive: true });

  const fromSec = Math.floor(Date.parse(FROM) / 1000);
  const toSec = Math.floor(Date.parse(TO) / 1000);
  const nSamples = Math.floor((toSec - fromSec) / SAMPLE_SECONDS) + 1;
  const startedUtc = new Date().toISOString();
  const startedMs = Date.now();

  console.log(`run: ${SYMBOLS.length} tokens, ${FROM} .. ${TO}, ${nSamples} sample times`);
  console.log(`twap windows: ${twapWindows.map((w) => w + "s").join(", ")} | precision=${PRECISION} | maxSubcalls=${MAX_SUBCALLS}`);
  console.log("NOTE: /corporate-actions is NOT read — it reports present-tense status only (A2).");

  const anchor = (await getBlock("latest"))!;
  console.log(`anchor block ${anchor.number}`);

  const rows: string[] = [];
  const codeCounts: Record<string, number> = {};
  const blockRates: number[] = [];
  const gapsFound: { afterBlock: number; gapSec: number; fromTime: number }[] = [];
  const driftWarnings: { sampleTime: number; block: number; driftSec: number }[] = [];
  const readFailures: { sampleTime: number; block: number; error: string }[] = [];
  const reopenStateFor = (sym: string, _t: number): string | number => {
    const r = reopening.get(sym);
    return r?.lastReopenAt ?? "";
  };
  let prevBlock: BlockRef | null = null;
  let rate = 9.8;
  let probeTotal = 0;
  let firstBlock: number | null = null;
  let lastBlock: number | null = null;

  const reopening = new Map<string, { lastReopenAt: number | null; hasUpdatedSinceReopen: boolean | null }>();
  const lastSession = new Map<string, SessionName>();
  for (const s of SYMBOLS) reopening.set(s, { lastReopenAt: null, hasUpdatedSinceReopen: null });

  const t0 = Date.now();

  // Rows are flushed to disk every sample. The first attempt at this run computed 1,681
  // samples x 33 tokens = 55,473 rows and then lost every one of them when the process
  // exited, because the CSV was only written at the end. A long unattended run must be
  // resumable or a single transient failure costs hours.
  let headerWritten = false;
  const doneSampleTimes = new Set<string>();
  // ---- single-writer guard -------------------------------------------------
  // Two runs appending to one evidence file is silent corruption. A process we thought we
  // had killed kept flushing, and the result was duplicate sample blocks (68 rows = 35+33,
  // 70 = 35+35) inside the artifact we publish. An evidence file that is quietly wrong is
  // worse than no file, so refuse to start rather than write into one.
  const LOCK = OUT + ".lock";
  if (existsSync(LOCK)) {
    const oldPid = Number(readFileSync(LOCK, "utf8").trim());
    let alive = false;
    if (Number.isFinite(oldPid) && oldPid > 0) {
      try { process.kill(oldPid, 0); alive = true; } catch { alive = false; }
    }
    if (alive) {
      console.error(`refusing to run: pid ${oldPid} is still writing ${OUT}.`);
      console.error(`Kill it first, or point --out at a different file.`);
      process.exit(1);
    }
    console.warn(`stale lock from pid ${oldPid} (not alive); taking it over.`);
  }
  writeFileSync(LOCK, String(process.pid));
  const releaseLock = () => {
    try {
      if (existsSync(LOCK) && readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK);
    } catch { /* best effort */ }
  };
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(130); });

  if (RESUME && existsSync(OUT)) {
    // A resumed file must describe the same universe, or its sample blocks are mixed
    // and the CSV silently contains two different token sets.
    const body = readFileSync(OUT, "utf8").split("\n").slice(1).filter(Boolean);
    const head = new Set(body.slice(0, SYMBOLS.length * 2).map((l) => l.split(",")[0]));
    const absent = SYMBOLS.filter((sym) => !head.has(sym));
    if (absent.length) {
      console.error(`refusing to resume ${OUT}: its existing rows do not contain ${absent.join(", ")}.`);
      console.error(`That means the file was written with a different universe. Delete it and re-run.`);
      process.exit(1);
    }
  }

  if (RESUME && existsSync(OUT)) {
    const prior = readFileSync(OUT, "utf8").trim().split("\n");
    headerWritten = true;
    for (const line of prior.slice(1)) {
      if (!line) continue;
      const cells = line.split(",");
      if (cells[1]) doneSampleTimes.add(cells[1]);
    }
    console.log(`resume: ${doneSampleTimes.size} sample times already on disk`);
  } else {
    writeFileSync(OUT, CSV_COLS.join(",") + "\n");
    headerWritten = true;
  }

  let skipped = 0;
  for (let i = 0; i < nSamples; i++) {
    const sampleTime = fromSec + i * SAMPLE_SECONDS;

    if (doneSampleTimes.has(String(sampleTime))) {
      skipped += 1;
      continue;
    }

    let block: BlockRef;
    try {
      if (prevBlock) {
        const r = await blockByEstimate(sampleTime, prevBlock, rate, anchor, {}, PRECISION);
        block = r.ref;
        probeTotal += r.probes;
      } else {
        block = await blockAtOrBefore(sampleTime, anchor);
      }
    } catch (err) {
      // Block resolution is a single point of failure for the whole sample. One upstream
      // timeout must not end a long run: record it, fail closed for this sample, move on.
      readFailures.push({
        sampleTime,
        block: -1,
        error: `block resolution failed: ${(err as Error).message.slice(0, 240)}`,
      });
      prevBlock = null; // next sample re-seeds from the anchor
      for (const sym of SYMBOLS) {
        rows.push([
          sym, sampleTime, "", "", "unknown", "unknown",
          "", "", "", "", "", "", "", "", "", "", "", "", "", "",
          "", "", "",
          "", "", "", "", "", ...twapWindows.map(() => ""),
          false, "SOURCE_UNAVAILABLE", "",
        ].join(","));
      }
      if (rows.length) appendFileSync(OUT, rows.join("\n") + "\n");
      rows.length = 0;
      continue;
    }

    if (firstBlock === null) firstBlock = block.number;
    lastBlock = block.number;

    const driftSec = sampleTime - block.timestamp;
    if (driftSec < 0 || driftSec > 120) {
      driftWarnings.push({ sampleTime, block: block.number, driftSec });
    }

    let intervalMeasured: { blocks: number; seconds: number; ratePerSec: number } | null = null;
    let longestGapSec: number | null = null;
    if (prevBlock) {
      const m = measureInterval(prevBlock, block);
      intervalMeasured = m;
      if (m.seconds > 0 && m.blocks > 0) {
        blockRates.push(m.ratePerSec);
        rate = 0.7 * rate + 0.3 * m.ratePerSec;
      }
      if (m.ratePerSec > 0 && m.ratePerSec < GAP_ZOOM_RATE_FLOOR && m.blocks > 2) {
        const zoom = await findLongestGap(prevBlock, block);
        probeTotal += zoom.probes;
        longestGapSec = zoom.longestGapSec;
        if (zoom.gapBetween) {
          gapsFound.push({
            afterBlock: zoom.gapBetween.fromBlock,
            gapSec: zoom.longestGapSec,
            fromTime: zoom.gapBetween.fromTime,
          });
        }
      }
    }

    const info = sessionAt(sampleTime * 1000, holidays, earlyCloses);
    const tag = "0x" + block.number.toString(16);

    for (const sym of SYMBOLS) {
      const prev = lastSession.get(sym);
      const wasClosed = prev !== undefined && !OPEN.has(prev);
      if (wasClosed && OPEN.has(info.session)) {
        reopening.set(sym, { lastReopenAt: block.timestamp, hasUpdatedSinceReopen: false });
      }
      lastSession.set(sym, info.session);
    }

    const inputs: SnapshotInput[] = SYMBOLS.map((sym) => ({
      token: feedMap[sym].token as string,
      symbol: sym,
      blockTag: tag,
      blockNumber: block.number,
      blockTime: block.timestamp,
      session: info.session,
      purpose: "trade",
      latestBlockTime: block.timestamp,
      observedInterBlockGapSec: longestGapSec,
      reopening: { ...reopening.get(sym)! },
      corpActionInProgress: false,
      referenceMode: "twap",
      twapSeconds: policy.POOL_TWAP_SEC,
      extraTwapWindows: EXTRA_TWAP_WINDOWS,
    }));

    // A single unreadable sample must not discard hours of work. Fail CLOSED and VISIBLE:
    // the sample is recorded with null inputs and counted, so the report states exactly how
    // many samples could not be read rather than quietly dropping them.
    let results: Awaited<ReturnType<typeof readSnapshotBatch>>;
    try {
      results = await readSnapshotBatch(inputs, { maxCallsPerMulticall: MAX_SUBCALLS });
    } catch (err) {
      readFailures.push({
        sampleTime,
        block: block.number,
        error: (err as Error).message.slice(0, 300),
      });
      for (const sym of SYMBOLS) {
        rows.push([
          sym, sampleTime, block.number, block.timestamp, info.session, "unknown",
          "", "", "", "", "", "", "", "", "", "", "", reopenStateFor(sym, block.timestamp), "", "",
          intervalMeasured?.ratePerSec?.toFixed(3) ?? "", intervalMeasured?.blocks ?? "", longestGapSec ?? "",
          "", "", "", "", "", ...twapWindows.map(() => ""),
          false, "SOURCE_UNAVAILABLE", "",
        ].join(","));
      }
      prevBlock = block;
      if (rows.length) appendFileSync(OUT, rows.join("\n") + "\n");
      rows.length = 0;
      continue;
    }

    for (let k = 0; k < SYMBOLS.length; k++) {
      const sym = SYMBOLS[k];
      const { snapshot, extras } = results[k];
      const reopen = reopening.get(sym)!;

      if (reopen.lastReopenAt !== null && reopen.hasUpdatedSinceReopen === false &&
          snapshot.feed.updatedAt !== null && snapshot.feed.updatedAt >= reopen.lastReopenAt) {
        reopen.hasUpdatedSinceReopen = true;
        snapshot.reopening = { ...reopen };
      }

      const verdict = evaluate(snapshot, policy);
      for (const c of verdict.blockingCodes) codeCounts[c] = (codeCounts[c] ?? 0) + 1;
      for (const c of verdict.warningCodes) codeCounts[c] = (codeCounts[c] ?? 0) + 1;

      const feedAge = snapshot.feed.updatedAt !== null ? block.timestamp - snapshot.feed.updatedAt : null;
      const stagedBps = multiplierChangeBps(snapshot.tokenState.uiMultiplier, snapshot.tokenState.newUIMultiplier);
      const reopenWait = reopen.lastReopenAt !== null ? block.timestamp - reopen.lastReopenAt : null;
      const t = snapshot.tokenState;

      rows.push([
        sym, sampleTime, block.number, block.timestamp, info.session, snapshot.feedMode,
        snapshot.feed.answer?.toString() ?? "", snapshot.feed.updatedAt ?? "", feedAge ?? "",
        t.oraclePaused ?? "", t.tokenPaused ?? "",
        t.paused === null || t.tokenPaused === null ? "" : (t.paused && !t.tokenPaused),
        t.uiMultiplier?.toString() ?? "", t.newUIMultiplier?.toString() ?? "",
        t.effectiveAt ?? "", stagedBps ?? "",
        extras.referenceQuoteUsd ?? "",
        reopen.lastReopenAt ?? "", snapshot.reopening.hasUpdatedSinceReopen ?? "", reopenWait ?? "",
        intervalMeasured?.ratePerSec?.toFixed(3) ?? "", intervalMeasured?.blocks ?? "", longestGapSec ?? "",
        extras.referenceVenue ?? "", extras.referenceAddress ?? "", snapshot.reference?.quote ?? "",
        extras.referenceQuoteUsd ?? "", extras.poolSpotUsd ?? "",
        ...twapWindows.map((w) => extras.deviationByWindow[String(w)] ?? ""),
        verdict.safe, verdict.blockingCodes.join("|"), verdict.warningCodes.join("|"),
      ].join(","));
    }

    prevBlock = block;

    if (rows.length) {
      if (!headerWritten) {
        writeFileSync(OUT, CSV_COLS.join(",") + "\n");
        headerWritten = true;
      }
      appendFileSync(OUT, rows.join("\n") + "\n");
      rows.length = 0;
    }

    if (i % 48 === 0 || i === nSamples - 1) {
      console.log(
        `  ${new Date(sampleTime * 1000).toISOString().slice(0, 16)} ${i + 1}/${nSamples} ` +
        `rows=${rows.length} probes=${probeTotal} hit=${cacheStats().hits} miss=${cacheStats().misses} ` +
        `retry=${cacheStats().retries} swallowed=${swallowedErrorCount()}`,
      );
    }
  }

  // The file is already complete: rows were appended sample by sample. This block is only a
  // safety net for anything still buffered when the loop finished.
  if (rows.length) appendFileSync(OUT, rows.join("\n") + "\n");
  const totalRows = readFileSync(OUT, "utf8").trim().split("\n").length - 1;

  // ---- evidence invariants ---------------------------------------------------
  // A SHA-256 proves the file is UNCHANGED; only these prove it is WELL-FORMED. An earlier
  // version of this runner produced a CSV that looked complete, carried duplicate sample
  // blocks written by a process believed dead, and would have been published with a hash for
  // third parties to reproduce. It passed every check we had, because the check we had was
  // the hash. Assert the shape too, and fail loudly when it is wrong.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invariantReport: any = { assertion: "NOT_RUN" };
  {
    const body = readFileSync(OUT, "utf8").split("\n").slice(1).filter(Boolean);
    const perSymbol = new Map<string, number>();
    const perSampleTime = new Map<string, number>();
    const seenPairs = new Set<string>();
    let duplicatePairs = 0;
    for (const line of body) {
      const cells = line.split(",");
      const sy = cells[0];
      const tm = cells[1];
      perSymbol.set(sy, (perSymbol.get(sy) ?? 0) + 1);
      perSampleTime.set(tm, (perSampleTime.get(tm) ?? 0) + 1);
      const key = `${sy}@${tm}`;
      if (seenPairs.has(key)) duplicatePairs += 1;
      seenPairs.add(key);
    }
    const symbolCounts = [...new Set(perSymbol.values())];
    const sampleCounts = [...new Set(perSampleTime.values())];
    const absent = SYMBOLS.filter((s) => !perSymbol.has(s));
    const problems: string[] = [];
    if (absent.length) problems.push(`symbols absent from the file: ${absent.join(", ")}`);
    if (symbolCounts.length > 1) {
      problems.push(`symbols have unequal row counts: ${JSON.stringify([...perSymbol])}`);
    }
    if (sampleCounts.length > 1) {
      const odd = [...perSampleTime.entries()].filter(([, n]) => n !== SYMBOLS.length).slice(0, 5);
      problems.push(`sample times have rows != ${SYMBOLS.length}: ${JSON.stringify(odd)}`);
    }
    if (duplicatePairs > 0) problems.push(`${duplicatePairs} duplicate (symbol, sampleTime) pairs`);
    if (body.length !== totalRows) problems.push(`row count drift: parsed ${body.length} vs reported ${totalRows}`);

    invariantReport = {
      rowsPerSymbol: symbolCounts.length === 1 ? symbolCounts[0] : null,
      rowsPerSymbolAllEqual: symbolCounts.length === 1,
      rowsPerSampleTimeAllEqual: sampleCounts.length === 1,
      distinctSymbols: perSymbol.size,
      distinctSampleTimes: perSampleTime.size,
      duplicatePairs,
      problems,
      assertion: problems.length === 0 ? "PASS" : "FAIL",
    };
  }

  const st = cacheStats();
  const swallowed = swallowedErrorCount();
  const summary = {
    generatedUtc: new Date().toISOString(),
    startedUtc,
    from: FROM, to: TO,
    tokens: SYMBOLS, tokenCount: SYMBOLS.length,
    sampleStepSec: SAMPLE_SECONDS,
    nSampleTimes: nSamples,
    rowsWritten: totalRows,
    sampleTimesSkippedOnResume: skipped,
    elapsedSec: Math.round((Date.now() - startedMs) / 1000),
    rpc: st,
    probes: probeTotal,
    callsPerSampleTime: Number((st.misses / Math.max(1, nSamples)).toFixed(2)),
    reference: { mode: "twap", twapWindowsSec: twapWindows, comparison: "raw_usd" },
    blockPrecision: PRECISION,
    maxCallsPerMulticall: MAX_SUBCALLS,
    blockRate: {
      n: blockRates.length,
      min: blockRates.length ? Math.min(...blockRates) : null,
      p50: blockRates.length ? [...blockRates].sort((a, b) => a - b)[Math.floor(blockRates.length / 2)] : null,
      max: blockRates.length ? Math.max(...blockRates) : null,
      zoomTriggered: gapsFound.length,
      gapsFound,
    },
    codeCounts,
    blockResolution: {
      samplesWithDriftOver120s: driftWarnings.length,
      worst: driftWarnings.slice(0, 10),
    },
    // Orchestrator B6: an assertion, not a note.
    sampleReadFailures: readFailures.length,
    sampleReadFailureDetail: readFailures.slice(0, 20),
    errorsSwallowed: swallowed,
    errorsSwallowedAssertion: swallowed === 0 ? "PASS" : "FAIL",
    // Failed sub-calls, by call name. A failed read is never a value: it is counted here, and
    // any verdict that depends on it is SOURCE_UNAVAILABLE (working rule 2).
    readFailures: readFailureCounts(),
    readFailureTotal: readFailureTotal(),
    corporateActionsUsed: false,
    // Shape, not just bytes. The CSV hash proves the file is unchanged; this proves it is
    // well-formed. Both go in meta.json.
    evidenceInvariants: invariantReport,
    out: OUT,
  };
  writeFileSync(OUT.replace(/\.csv$/, "") + ".summary.json", JSON.stringify(summary, null, 1));

  // ---- replay/meta.json: the reproducibility anchor (spec section 3.4 item 3) --------------
  // Universe, method, block range, RPC provider, code commit, thresholds, CSV SHA-256 and the
  // evidence invariants. A third party reruns from this file and must reproduce the CSV hash.
  const csvSha256 = createHash("sha256").update(readFileSync(OUT)).digest("hex");
  const preregSha256 = POLICY_PATH && existsSync(POLICY_PATH)
    ? createHash("sha256").update(readFileSync(POLICY_PATH)).digest("hex") : null;
  const meta = {
    generatedUtc: new Date().toISOString(),
    kind: "replay-evaluation",
    window: "evaluation",
    from: FROM, to: TO,
    universe: SYMBOLS, universeCount: SYMBOLS.length,
    sampleStepSec: SAMPLE_SECONDS, nSampleTimes: nSamples,
    method:
      "archive eth_call + Multicall3 at the last block at or before each sample time; " +
      "the block timestamp is the clock; raw USD comparison",
    blockRange: { first: firstBlock, last: lastBlock },
    rpcProviders: { archivePool: RPC_ARCHIVE_POOL, latest: RPC_LATEST },
    codeCommit: GIT_COMMIT,
    gitStatusClean: GIT_STATUS === "",
    preregistration: POLICY_PATH ? { path: POLICY_PATH, sha256: preregSha256 } : null,
    thresholds: policy,
    csv: { path: OUT, rows: totalRows, sha256: csvSha256 },
    evidenceInvariants: invariantReport,
    errorsSwallowed: swallowed,
    errorsSwallowedAssertion: swallowed === 0 ? "PASS" : "FAIL",
    readFailures: readFailureCounts(),
    readFailureTotal: readFailureTotal(),
  };
  writeFileSync(join(ROOT, "replay/meta.json"), JSON.stringify(meta, null, 1));
  // rule 1: read it back and assert the fields the reproducibility claim rests on.
  const metaBack = JSON.parse(readFileSync(join(ROOT, "replay/meta.json"), "utf8"));
  if (metaBack.csv.sha256 !== csvSha256 || metaBack.codeCommit !== GIT_COMMIT) {
    console.error("FATAL: replay/meta.json did not read back as written.");
    process.exit(4);
  }
  console.log(`wrote replay/meta.json  commit=${GIT_COMMIT.slice(0, 8)} csvSha=${csvSha256.slice(0, 12)}`);

  console.log("\n=== RUN SUMMARY ===");
  console.log(JSON.stringify(summary, null, 1));

  if (swallowed !== 0) {
    console.error(`\nFATAL: errorsSwallowed=${swallowed}. A provider error was caught and not surfaced.`);
    process.exit(2);
  }

  // The evidence file must be well-formed, not merely present. Exiting non-zero here means a
  // caller that only checks the exit code cannot mistake a malformed CSV for a finished run.
  if (invariantReport.assertion !== "PASS") {
    console.error(`\nFATAL: evidence invariants failed on ${OUT}:`);
    for (const p of invariantReport.problems) console.error(`  - ${p}`);
    process.exit(3);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
