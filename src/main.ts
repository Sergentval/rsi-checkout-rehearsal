import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  fetchShipMatrix,
  fetchCommLink,
  fetchPledgeStore,
  type DropEvent,
} from "./sources.js";
import { notify, type PushTargets } from "./push.js";
import { calendarTicks } from "./calendar.js";

interface Config {
  readonly stateFile: string;
  readonly userAgent: string;
  readonly intervals: Record<DropEvent["source"], number>;
  readonly push: PushTargets;
}

interface State {
  // source -> set of seen ids
  seen: Record<DropEvent["source"], string[]>;
  lastError: Record<DropEvent["source"], string | undefined>;
  // Calendar tick keys we've already announced (so each transition fires once).
  seenCalendarTicks: string[];
}

function emptyState(): State {
  return {
    seen: { "ship-matrix": [], "pledge-store": [], "comm-link": [] },
    lastError: { "ship-matrix": undefined, "pledge-store": undefined, "comm-link": undefined },
    seenCalendarTicks: [],
  };
}

function readEnv(): Config {
  const e = process.env;
  const stateFile = e.STATE_FILE ?? "/home/ubuntu/projects/sc-drop-watcher/.state.json";
  const userAgent = e.USER_AGENT ?? "sc-drop-watcher/0.1";
  const live = e.LIVE === "1";
  return {
    stateFile,
    userAgent,
    intervals: {
      "ship-matrix": Number(e.POLL_SHIP_MATRIX_SEC ?? 300) * 1000,
      "pledge-store": Number(e.POLL_PLEDGE_STORE_SEC ?? 60) * 1000,
      "comm-link": Number(e.POLL_COMM_LINK_SEC ?? 60) * 1000,
    },
    push: {
      discordWebhookUrl: e.DISCORD_WEBHOOK_URL || undefined,
      ntfyTopicUrl: e.NTFY_TOPIC_URL || undefined,
      ntfyToken: e.NTFY_TOKEN || undefined,
      userAgent,
      live,
    },
  };
}

async function loadState(path: string): Promise<State> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    const base = emptyState();
    return {
      seen: { ...base.seen, ...(parsed.seen ?? {}) } as State["seen"],
      lastError: { ...base.lastError, ...(parsed.lastError ?? {}) } as State["lastError"],
      seenCalendarTicks: parsed.seenCalendarTicks ?? [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

type Fetcher = (opts: { userAgent: string }) => Promise<DropEvent[]>;

const FETCHERS: Record<DropEvent["source"], Fetcher> = {
  "ship-matrix": fetchShipMatrix,
  "pledge-store": fetchPledgeStore,
  "comm-link": fetchCommLink,
};

async function pollOnce(
  source: DropEvent["source"],
  cfg: Config,
  state: State,
): Promise<void> {
  let events: DropEvent[];
  try {
    events = await FETCHERS[source]({ userAgent: cfg.userAgent });
    state.lastError[source] = undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (state.lastError[source] !== msg) {
      state.lastError[source] = msg;
      await notify(cfg.push, { kind: "error", message: `${source} fetch failed: ${msg}` });
    }
    return;
  }

  const previous = new Set(state.seen[source]);
  const current = new Set(events.map((e) => e.id));
  const isFirstSync = previous.size === 0;

  // First sync: just learn ids, do not spam pushes.
  if (isFirstSync) {
    state.seen[source] = [...current];
    console.log(`[${source}] first sync: ${current.size} ids learned`);
    return;
  }

  const added = events.filter((e) => !previous.has(e.id));
  const removedIds = [...previous].filter((id) => !current.has(id));

  for (const ev of added) {
    await notify(cfg.push, {
      kind: "new",
      event: ev,
      message: `New ${ev.source} item: ${ev.title}\n${ev.url}`,
    });
  }
  // Removals from pledge-store are signal too (sale ended); ship-matrix removals
  // are noisy (ships toggled off). Only push removals for pledge-store.
  if (source === "pledge-store") {
    for (const id of removedIds) {
      await notify(cfg.push, {
        kind: "removed",
        message: `pledge-store SKU disappeared: ${id}`,
      });
    }
  }

  state.seen[source] = [...current];
}

function jitter(ms: number): number {
  // Spread polls across a window so we don't all fire on the same second.
  return ms + Math.floor(Math.random() * Math.min(ms * 0.2, 5_000));
}

async function calendarLoop(cfg: Config, state: State): Promise<void> {
  // Tick once an hour. Calendar windows have day-level granularity; finer
  // polling buys nothing.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const ticks = calendarTicks(new Date());
      const seen = new Set(state.seenCalendarTicks);
      for (const tick of ticks) {
        if (seen.has(tick.key)) continue;
        await notify(cfg.push, {
          kind: tick.kind === "imminent" ? "new" : tick.kind === "opened" ? "new" : "removed",
          message: `[calendar] ${tick.summary}`,
        });
        seen.add(tick.key);
      }
      state.seenCalendarTicks = [...seen];
      await saveState(cfg.stateFile, state);
    } catch (err) {
      console.error("[calendar] loop error:", err);
    }
    await new Promise((r) => setTimeout(r, 60 * 60 * 1000));
  }
}

async function loop(source: DropEvent["source"], cfg: Config, state: State): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = Date.now();
    try {
      await pollOnce(source, cfg, state);
      await saveState(cfg.stateFile, state);
    } catch (err) {
      console.error(`[${source}] loop error:`, err);
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(1_000, jitter(cfg.intervals[source]) - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function main(): Promise<void> {
  const cfg = readEnv();
  const state = await loadState(cfg.stateFile);
  console.log(
    `sc-drop-watcher starting :: live=${cfg.push.live} ` +
      `discord=${Boolean(cfg.push.discordWebhookUrl)} ntfy=${Boolean(cfg.push.ntfyTopicUrl)}`,
  );
  await Promise.all([
    loop("ship-matrix", cfg, state),
    loop("pledge-store", cfg, state),
    loop("comm-link", cfg, state),
    calendarLoop(cfg, state),
  ]);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exitCode = 1;
});
