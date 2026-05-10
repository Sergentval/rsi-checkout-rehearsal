// URL existence probe — HEAD specific RSI URLs and alert when a 4xx URL
// flips to 2xx. Catches ships that go live on the store before any
// comm-link announcement (or that re-stock silently).
//
// This is read-only and per-URL — NOT a catalog scanner. The user explicitly
// lists the URLs they want polled in PROBE_URLS. Default cadence is one
// request per URL every 120s. Each request is a HEAD with the configured
// user-agent — minimum bandwidth, identifies us honestly.

export interface ProbeConfig {
  readonly urls: ReadonlyArray<string>;
  readonly userAgent: string;
  readonly intervalMs: number;
}

export interface ProbeResult {
  readonly url: string;
  readonly status: number; // -1 if request failed (DNS/timeout/etc.)
}

export function parseProbeUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!/^https?:\/\//i.test(trimmed)) continue; // skip malformed entries silently
    out.push(trimmed);
  }
  return out;
}

export async function headProbe(url: string, opts: { userAgent: string; timeoutMs?: number }): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual", // a 302 to /en/... is fine; we want the raw status
      signal: ctrl.signal,
      headers: {
        "user-agent": opts.userAgent,
        "accept": "text/html,*/*;q=0.8",
      },
    });
    return { url, status: res.status };
  } catch {
    return { url, status: -1 };
  } finally {
    clearTimeout(timer);
  }
}

// Decide what kind of state-transition is worth alerting on.
//   first observation (prev undefined) → silent (just learn)
//   2xx → 4xx                          → "removed" (page taken down)
//   4xx/-1 → 2xx                       → "watchlist" (page is live!)
//   anything else                      → silent
export type ProbeTransition =
  | { readonly kind: "silent" }
  | { readonly kind: "went-live" }      // alert as watchlist
  | { readonly kind: "went-down" };     // alert as removed

export function classifyTransition(prev: number | undefined, curr: number): ProbeTransition {
  if (prev === undefined) return { kind: "silent" };
  const wasOk = prev >= 200 && prev < 300;
  const isOk = curr >= 200 && curr < 300;
  if (!wasOk && isOk) return { kind: "went-live" };
  if (wasOk && !isOk) return { kind: "went-down" };
  return { kind: "silent" };
}
