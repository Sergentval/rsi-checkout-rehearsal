// RSI runs a fairly predictable annual cadence of sale events. Hardcode the
// recurring windows so we can ping you ~24h before one opens, and again the
// moment it does. Dates are month/day pairs (year-agnostic) and approximate —
// CIG sometimes shifts by ±3 days, so windows are deliberately wide.

export interface SaleWindow {
  readonly key: string;
  readonly name: string;
  readonly startMonth: number; // 1-12
  readonly startDay: number;
  readonly endMonth: number;
  readonly endDay: number;
  readonly notes: string;
}

export const SALE_CALENDAR: ReadonlyArray<SaleWindow> = [
  {
    key: "invictus",
    name: "Invictus Launch Week",
    startMonth: 5, startDay: 16,
    endMonth: 5, endDay: 31,
    notes: "Military ships, free-fly. Concept reveals possible.",
  },
  {
    key: "alien-week",
    name: "Alien Week",
    startMonth: 10, startDay: 6,
    endMonth: 10, endDay: 14,
    notes: "Banu / Vanduul / Xi'an / Aopoa ships, occasional concept sale.",
  },
  {
    key: "citizencon",
    name: "CitizenCon",
    startMonth: 10, startDay: 19,
    endMonth: 10, endDay: 26,
    notes: "Major concept ship reveals — biggest leak/drop window of the year.",
  },
  {
    key: "iae",
    name: "Intergalactic Aerospace Expo (IAE) / Anniversary",
    startMonth: 11, startDay: 19,
    endMonth: 12, endDay: 5,
    notes: "Every ship purchasable. Highest volume of concept sales.",
  },
  {
    key: "luminalia",
    name: "Luminalia",
    startMonth: 12, startDay: 14,
    endMonth: 12, endDay: 26,
    notes: "Gift-themed sales, daily reveals.",
  },
];

interface OccurrenceWindow {
  readonly window: SaleWindow;
  readonly start: Date;
  readonly end: Date;
}

function makeOccurrence(window: SaleWindow, year: number): OccurrenceWindow {
  // Windows that wrap year-end (start month > end month) need the end pushed
  // to the following calendar year. None of the current entries do, but the
  // logic is here so adding one later doesn't silently break.
  const start = new Date(Date.UTC(year, window.startMonth - 1, window.startDay, 0, 0, 0));
  const endYear = window.endMonth < window.startMonth ? year + 1 : year;
  const end = new Date(Date.UTC(endYear, window.endMonth - 1, window.endDay, 23, 59, 59));
  return { window, start, end };
}

function* upcomingOccurrences(now: Date): Generator<OccurrenceWindow> {
  const year = now.getUTCFullYear();
  // Yield occurrences from this year and next, sorted by start date, filtered
  // to those whose end is still in the future.
  const all: OccurrenceWindow[] = [];
  for (const w of SALE_CALENDAR) {
    all.push(makeOccurrence(w, year));
    all.push(makeOccurrence(w, year + 1));
  }
  all.sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const o of all) {
    if (o.end.getTime() >= now.getTime()) yield o;
  }
}

export interface CalendarTick {
  readonly key: string;
  readonly kind: "imminent" | "opened" | "closing";
  readonly summary: string;
}

// Returns ticks the daemon should announce. Caller is expected to deduplicate
// against state.seenCalendarTicks so each transition only fires once.
export function calendarTicks(now: Date = new Date()): CalendarTick[] {
  const out: CalendarTick[] = [];
  for (const occ of upcomingOccurrences(now)) {
    const start = occ.start.getTime();
    const end = occ.end.getTime();
    const t = now.getTime();
    const dayMs = 24 * 60 * 60 * 1000;

    const yyyy = occ.start.getUTCFullYear();
    const idPrefix = `${occ.window.key}-${yyyy}`;

    if (t < start && start - t <= dayMs) {
      out.push({
        key: `${idPrefix}-imminent`,
        kind: "imminent",
        summary:
          `${occ.window.name} starts in ~${Math.round((start - t) / 3600_000)}h ` +
          `(${occ.start.toISOString().slice(0, 10)}). ${occ.window.notes}`,
      });
    } else if (t >= start && t <= end) {
      out.push({
        key: `${idPrefix}-opened`,
        kind: "opened",
        summary:
          `${occ.window.name} is LIVE (window ${occ.start.toISOString().slice(0, 10)}` +
          ` → ${occ.end.toISOString().slice(0, 10)}). ${occ.window.notes}`,
      });
      if (end - t <= dayMs) {
        out.push({
          key: `${idPrefix}-closing`,
          kind: "closing",
          summary: `${occ.window.name} closes in ~${Math.round((end - t) / 3600_000)}h.`,
        });
      }
    }
    // Stop after the first not-yet-started occurrence to keep output small.
    if (t < start && start - t > dayMs) break;
  }
  return out;
}
