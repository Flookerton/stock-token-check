/**
 * sessions-guard.ts — the calendar cannot go quietly stale.
 *
 * A market calendar is a data file, and a data file goes stale silently. If this library is asked
 * about a date outside the years the calendar covers, it must say so rather than keep answering
 * with a calendar that no longer knows about holidays — a missed holiday would look like a normal
 * trading session and produce a confident, wrong answer.
 *
 * Callers treat `false` from `calendarCovers` as SOURCE_UNAVAILABLE. See src/index.ts.
 */

import type { Calendar } from "./sessions.ts";

/** Every four-digit year named by the calendar data or its coverage statement. */
export function coverageYears(cal: Calendar): number[] {
  const years = new Set<number>();
  const entries = [
    ...((cal as unknown as { fullDayClosures?: { date: string }[] }).fullDayClosures ?? []),
    ...((cal as unknown as { earlyCloses?: { date: string }[] }).earlyCloses ?? []),
  ];
  for (const e of entries) {
    const y = Number(String(e.date ?? "").slice(0, 4));
    if (Number.isFinite(y) && y > 1900) years.add(y);
  }
  const declared = String((cal as unknown as { coverage?: string }).coverage ?? "");
  for (const m of declared.match(/\b(20\d{2})\b/g) ?? []) years.add(Number(m));
  return [...years].sort((a, b) => a - b);
}

/**
 * True when `utcMs` falls inside a year the calendar actually covers.
 *
 * The year is taken in UTC. That is deliberate: this is a whole-year coverage guard, not a session
 * calculation, and the only edge is a few hours either side of New Year — where the answer is
 * "possibly outside coverage", which the guard flags rather than guesses.
 */
export function calendarCovers(cal: Calendar, utcMs: number): boolean {
  const years = coverageYears(cal);
  if (years.length === 0) return false;
  const y = new Date(utcMs).getUTCFullYear();
  return y >= years[0] && y <= years[years.length - 1];
}

/** Human-readable coverage string for README, warnings and MCP output. */
export function coverageLabel(cal: Calendar): string {
  const years = coverageYears(cal);
  if (years.length === 0) return "unknown";
  return years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
}
