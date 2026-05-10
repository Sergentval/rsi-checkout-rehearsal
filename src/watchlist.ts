// Watchlist filter: turn the daemon's broad detection feed into per-ship
// alerts with warbond-vs-store-credit preference. Pure logic, no I/O —
// caller (main.ts) decides what to do with a match.

export interface WatchEntry {
  readonly ship: string; // case-insensitive substring match against title+url
  readonly mode: "warbond" | "store-credit" | "any";
}

// Comma-separated `ship:mode` pairs. Mode is optional — defaults to "any".
// Examples:
//   "Polaris:warbond"
//   "Polaris:warbond,Idris:any,Galaxy:store-credit"
//   "Polaris,Idris" (both default to "any")
export function parseWatchlist(raw: string | undefined): WatchEntry[] {
  if (!raw) return [];
  const out: WatchEntry[] = [];
  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    const ship = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
    if (!ship) continue;
    const modeRaw = (colon === -1 ? "any" : trimmed.slice(colon + 1).trim()).toLowerCase();
    let mode: WatchEntry["mode"];
    if (modeRaw === "warbond" || modeRaw === "wb") mode = "warbond";
    else if (modeRaw === "store-credit" || modeRaw === "credit" || modeRaw === "sc") mode = "store-credit";
    else mode = "any";
    out.push({ ship, mode });
  }
  return out;
}

// Returns the matched entry, or null. The detection event's title and url
// are concatenated and searched case-insensitively for both the ship name
// and the warbond marker. "warbond" mode requires the marker; "store-credit"
// mode requires its absence; "any" accepts either.
export function matchWatchlist(
  watchlist: ReadonlyArray<WatchEntry>,
  event: { readonly title: string; readonly url: string },
): WatchEntry | null {
  if (watchlist.length === 0) return null;
  const haystack = `${event.title} ${event.url}`.toLowerCase();
  const isWarbond = /\bwarbond\b/.test(haystack);
  for (const entry of watchlist) {
    if (!haystack.includes(entry.ship.toLowerCase())) continue;
    if (entry.mode === "warbond" && !isWarbond) continue;
    if (entry.mode === "store-credit" && isWarbond) continue;
    return entry;
  }
  return null;
}
