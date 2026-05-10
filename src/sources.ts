import { parse } from "node-html-parser";

export interface DropEvent {
  readonly source: "ship-matrix" | "pledge-store" | "comm-link";
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly extra?: Record<string, string | number | undefined>;
}

interface FetchOptions {
  readonly userAgent: string;
  readonly timeoutMs?: number;
}

async function getText(url: string, opts: FetchOptions): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "user-agent": opts.userAgent,
        "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function postJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "user-agent": opts.userAgent,
        "accept": "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface ShipMatrixResponse {
  readonly success: number;
  readonly data: ReadonlyArray<{
    readonly id: number;
    readonly name?: string;
    readonly production_status?: string;
    readonly manufacturer?: { readonly name?: string };
    // RSI's own canonical pledge-page path, e.g. "/pledge/ships/rsi-aurora/Aurora-Mk-I-ES".
    // Present for nearly every entry; absent for some early-concept rows.
    readonly url?: string;
  }>;
}

export async function fetchShipMatrix(opts: FetchOptions): Promise<DropEvent[]> {
  const json = await postJson<ShipMatrixResponse>(
    "https://robertsspaceindustries.com/ship-matrix/index",
    opts,
  );
  if (json.success !== 1 || !Array.isArray(json.data)) {
    throw new Error("ship-matrix: unexpected payload shape");
  }
  return json.data.map((s) => {
    // Use RSI's own canonical URL when available. The path is relative
    // (e.g. "/pledge/ships/rsi-aurora/Aurora-Mk-I-ES"); prepend origin.
    // Fall back to the generic landing page only if `url` is missing.
    const path = typeof s.url === "string" && s.url.startsWith("/") ? s.url : null;
    return {
      source: "ship-matrix" as const,
      // Encode status into the dedup id so a concept→flight-ready transition
      // (or any status flip) registers as a new event — that's the leak signal
      // beyond "ship ID never seen before".
      id: `${s.id}:${s.production_status ?? "unknown"}`,
      title: `${s.name ?? `ship #${s.id}`}${s.production_status ? ` [${s.production_status}]` : ""}`,
      url: path
        ? `https://robertsspaceindustries.com${path}`
        : "https://robertsspaceindustries.com/pledge/ships",
      extra: {
        manufacturer: s.manufacturer?.name,
        production_status: s.production_status,
      },
    };
  });
}

export async function fetchCommLink(opts: FetchOptions): Promise<DropEvent[]> {
  const html = await getText(
    "https://robertsspaceindustries.com/en/comm-link/transmission",
    opts,
  );
  const root = parse(html);
  const out: DropEvent[] = [];
  // Comm-link cards have anchor hrefs of the form /en/comm-link/<category>/<id>-<slug>.
  for (const a of root.querySelectorAll('a[href*="/comm-link/"]')) {
    const href = a.getAttribute("href") ?? "";
    const m = href.match(/\/comm-link\/[^/]+\/(\d+)-([^/?#]+)/);
    if (!m) continue;
    const id = m[1]!;
    const slug = m[2]!;
    if (out.some((e) => e.id === id)) continue;
    // Comm-link cards include card metadata (comment count, posted-ago,
    // excerpt) as inline text inside the same anchor, so a.text yields a
    // multi-line garbled string. The slug is always a clean kebab-case title
    // suitable for direct display.
    const title = slug.replace(/-/g, " ").slice(0, 200);
    out.push({
      source: "comm-link",
      id,
      title,
      url: href.startsWith("http") ? href : `https://robertsspaceindustries.com${href}`,
    });
  }
  return out;
}

export async function fetchPledgeStore(opts: FetchOptions): Promise<DropEvent[]> {
  const html = await getText(
    "https://robertsspaceindustries.com/en/pledge/ships",
    opts,
  );
  const root = parse(html);
  const out: DropEvent[] = [];
  // Pledge-store ship cards link to /en/pledge/<numeric-id>-<slug>. We treat each
  // unique (id, slug) we see in the listing HTML as a SKU on offer right now.
  for (const a of root.querySelectorAll('a[href*="/pledge/"]')) {
    const href = a.getAttribute("href") ?? "";
    const m = href.match(/\/pledge\/(?:[a-z-]+\/)?(\d+)-([^/?#]+)/i);
    if (!m) continue;
    const id = m[1]!;
    const slug = m[2]!;
    if (out.some((e) => e.id === id)) continue;
    const title = slug.replace(/-/g, " ").trim().slice(0, 200);
    out.push({
      source: "pledge-store",
      id,
      title,
      url: href.startsWith("http") ? href : `https://robertsspaceindustries.com${href}`,
    });
  }
  return out;
}
