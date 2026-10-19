/**
 * sessions.ts — US equity market sessions, in US Eastern time.
 *
 * Verified 2026-10-15: Chainlink's own Tokenized Equity session table is IDENTICAL
 * to spec v1.1 §5.4, so these boundaries are the right ones.
 *
 *   Pre-Market      04:00 - 09:30   Mon-Fri
 *   Regular         09:30 - 16:00   Mon-Fri
 *   Post-Market     16:00 - 20:00   Mon-Fri
 *   Overnight       20:00 - 04:00   (Sun 20:00 through Fri 04:00)
 *   Closed          Fri 20:00 - Sun 20:00, plus NYSE full-day holidays
 *
 * Caveat, by design: Chainlink's session table does NOT exclude NYSE holidays — on a
 * holiday, "overnight" is still open by Chainlink's definition. Holiday handling is a
 * spec addition, so it carries its own CLOSED_HOLIDAY session rather than being folded
 * into the ordinary session logic.
 *
 * DST is handled by formatting the instant in America/New_York rather than by
 * arithmetic on UTC offsets.
 *
 * This module is shared by the replay and the live service (spec §7).
 */

import { readFileSync } from "node:fs";

export type SessionName =
  | "PRE_MARKET"
  | "REGULAR"
  | "POST_MARKET"
  | "OVERNIGHT"
  | "CLOSED_WEEKEND"
  | "CLOSED_HOLIDAY";

export interface CalendarEntry {
  date: string;
  weekday?: string;
  holiday: string;
  close?: string;
  confidence?: string;
}

export interface Calendar {
  timezone: string;
  fullDayClosures: CalendarEntry[];
  earlyCloses: CalendarEntry[];
}

export interface SessionInfo {
  session: SessionName;
  /** True for PRE_MARKET, REGULAR, POST_MARKET, OVERNIGHT — i.e. the feed is expected to publish. */
  isOpen: boolean;
  /** "YYYY-MM-DD" in US Eastern time. */
  etDate: string;
  /** Minutes since midnight, US Eastern time. */
  etMinutes: number;
  /** 0 = Sunday .. 6 = Saturday, in US Eastern time. */
  etWeekday: number;
  isHoliday: boolean;
  /** Set when today is a scheduled early-close day. */
  earlyClose?: string;
}

const ET = "America/New_York";

// Reused formatter — constructing Intl.DateTimeFormat is expensive, and the replay
// calls sessionAt() once per sample.
const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Convert a UTC instant to US Eastern calendar components, DST-correct. */
export function etComponents(utcMs: number): {
  date: string; minutes: number; weekday: number; hour: number;
} {
  const parts = etParts.formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  // "24" appears for midnight in some ICU builds with hour12:false — normalise it.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return {
    date: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    hour,
  };
}

export function loadCalendar(path: string): Calendar {
  return JSON.parse(readFileSync(path, "utf8")) as Calendar;
}

export function makeHolidaySet(cal: Calendar): Set<string> {
  return new Set(cal.fullDayClosures.map((h) => h.date));
}

export function makeEarlyCloseMap(cal: Calendar): Map<string, string> {
  return new Map(cal.earlyCloses.map((h) => [h.date, h.close ?? "13:00"]));
}

const OPEN_SESSIONS: ReadonlySet<SessionName> = new Set<SessionName>([
  "PRE_MARKET", "REGULAR", "POST_MARKET", "OVERNIGHT",
]);

/** A full trading day: Monday-Friday and not a full-day NYSE holiday. */
function isTradingDay(utcMs: number, holidays: Set<string>): boolean {
  const { date, weekday } = etComponents(utcMs);
  return weekday >= 1 && weekday <= 5 && !holidays.has(date);
}

/**
 * Classify a UTC instant into a market session.
 *
 * Pass precomputed holiday/early-close collections when calling in a loop.
 */
export function sessionAt(
  utcMs: number,
  holidays: Set<string>,
  earlyCloses?: Map<string, string>,
): SessionInfo {
  const { date, minutes, weekday } = etComponents(utcMs);
  const isHoliday = holidays.has(date);
  const earlyClose = earlyCloses?.get(date);

  const base = { etDate: date, etMinutes: minutes, etWeekday: weekday, isHoliday, earlyClose };

  // A full-day holiday closes the DAYTIME sessions, but NOT the evening. Robinhood's 24 Hour
  // Market page says orders can execute "8 PM-12 AM ET" on the "evening before a full trading
  // day", and that the market runs "from Sunday 8 PM ET through Friday 8 PM ET". So the evening
  // of a holiday opens an overnight session whenever the next day trades.
  //
  // Closing the whole holiday day was wrong, and the calibration data proves it: 239 feed
  // updates landed inside a period this function labelled CLOSED_HOLIDAY, every one of them on
  // Labor Day evening 2026-09-07 from 20:00 ET (2026-09-08 00:00 UTC) onward. Feeds publish when
  // there is a market; there was one.
  if (isHoliday && minutes >= 20 * 60 && isTradingDay(utcMs + 24 * 3600 * 1000, holidays)) {
    return { ...base, session: "OVERNIGHT", isOpen: true };
  }

  if (isHoliday) {
    return { ...base, session: "CLOSED_HOLIDAY", isOpen: false };
  }

  // Overnight 00:00-04:00 belongs to the session that OPENED at 20:00 ET the previous
  // evening, so the previous evening's calendar decides it. Without this, the evening of
  // a holiday was CLOSED_HOLIDAY but midnight onwards silently became OVERNIGHT, cutting a
  // contiguous overnight session in half at the date boundary (orchestrator B4.3).
  //
  // Source for the session boundaries: Chainlink, "Tokenized Equity Feeds" — Pre-Market
  // 04:00-09:30, Regular 09:30-16:00, Post-Market 16:00-20:00, Overnight 20:00-04:00,
  // Weekend Fri 20:00-Sun 20:00 (ET). Chainlink's table has NO holiday row at all: holiday
  // handling is a spec addition, not a vendor behaviour, so it is applied here explicitly
  // rather than implied.
  if (weekday >= 1 && weekday <= 5 && minutes < 4 * 60) {
    const prev = etComponents(utcMs - 24 * 3600 * 1000);
    if (holidays.has(prev.date) || prev.weekday === 5 || prev.weekday === 6) {
      return { ...base, session: "CLOSED_HOLIDAY", isOpen: false };
    }
  }

  let session: SessionName;

  if (weekday === 6) {
    // Saturday: closed all day.
    session = "CLOSED_WEEKEND";
  } else if (weekday === 0) {
    // Sunday: closed until 20:00, then the overnight session opens — but only if Monday
    // actually trades. The Sunday evening before a Monday holiday is NOT an opening, which is
    // the mirror of the holiday-evening rule above and the reason 35 weekend reopenings in the
    // calibration window had no feed update within 60 minutes.
    session = (minutes >= 20 * 60 && isTradingDay(utcMs + 24 * 3600 * 1000, holidays))
      ? "OVERNIGHT"
      : "CLOSED_WEEKEND";
  } else {
    // Monday-Friday. Early-close days end the regular session at the early close
    // (after which only the post-market window remains).
    const closeMin = earlyClose
      ? Number(earlyClose.slice(0, 2)) * 60 + Number(earlyClose.slice(3, 5))
      : 16 * 60;
    // On an early-close day Robinhood's 24 Hour Market closes at 17:00 ET ("12 AM-5 PM ET"),
    // not 20:00, so the post-market window is shorter and the evening is closed.
    const pmEndMin = earlyClose ? 17 * 60 : 20 * 60;

    if (minutes < 4 * 60) {
      // 00:00-04:00 belongs to the overnight session that opened at 20:00 the previous
      // evening. On Monday that previous evening is Sunday, which is inside the
      // Sun 20:00 - Fri 04:00 window, so this is overnight either way.
      session = "OVERNIGHT";
    } else if (minutes < 9 * 60 + 30) {
      session = "PRE_MARKET";
    } else if (minutes < closeMin) {
      session = "REGULAR";
    } else if (minutes < pmEndMin) {
      // Post-market. Friday is NOT special here: Robinhood's 24 Hour Market runs "from Sunday
      // 8 PM ET through Friday 8 PM ET", so Friday 16:00-20:00 ET is an open post-market
      // session and the weekend silence starts at 20:00, not 16:00. Closing Friday at the
      // regular-session close was wrong and moved 16 hours of open session per month into
      // CLOSED_WEEKEND, shifting every per-session number and every weekend silence length.
      session = "POST_MARKET";
    } else if (earlyClose && minutes < 20 * 60) {
      // Early-close day: the market has already ended, so 17:00-20:00 ET is closed. Named
      // CLOSED_WEEKEND because that is the existing "closed, not a holiday" bucket; a dedicated
      // CLOSED_EARLY name would be clearer and is worth adding if a half day ever enters a window.
      session = "CLOSED_WEEKEND";
    } else {
      // 20:00 onwards. Friday evening closes the week.
      session = weekday === 5 ? "CLOSED_WEEKEND" : "OVERNIGHT";
    }
  }

  return { ...base, session, isOpen: OPEN_SESSIONS.has(session) };
}

/** Human label for reports. */
export function sessionLabel(s: SessionName): string {
  switch (s) {
    case "PRE_MARKET": return "pre-market";
    case "REGULAR": return "regular";
    case "POST_MARKET": return "post-market";
    case "OVERNIGHT": return "overnight";
    case "CLOSED_WEEKEND": return "closed (weekend)";
    case "CLOSED_HOLIDAY": return "closed (holiday)";
  }
}

/** Is this a closed session (either kind)? */
export function isClosed(s: SessionName): boolean {
  return s === "CLOSED_WEEKEND" || s === "CLOSED_HOLIDAY";
}

/**
 * The feed's reporting mode for a session (spec v1.1 §4.2).
 * Overnight the feed publishes an EMA, not a spot price — see Chainlink's
 * Tokenized Equity Feeds page.
 */
export function feedMode(session: SessionName): "live" | "ema_overnight" | "frozen_closed" {
  if (session === "OVERNIGHT") return "ema_overnight";
  if (isClosed(session)) return "frozen_closed";
  return "live";
}
