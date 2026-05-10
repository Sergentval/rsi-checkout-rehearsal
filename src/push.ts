import type { DropEvent } from "./sources.js";

export interface PushTargets {
  readonly discordWebhookUrl: string | undefined;
  readonly ntfyTopicUrl: string | undefined;
  readonly ntfyToken: string | undefined;
  readonly userAgent: string;
  readonly live: boolean;
}

interface NotifyArgs {
  readonly kind: "new" | "removed" | "error" | "watchlist";
  readonly event?: DropEvent;
  readonly message: string;
}

function severity(kind: NotifyArgs["kind"]): { color: number; tag: string; priority: string } {
  switch (kind) {
    case "new":
      return { color: 0x00cc66, tag: "DROP", priority: "high" };
    case "removed":
      return { color: 0x888888, tag: "GONE", priority: "default" };
    case "error":
      return { color: 0xcc0033, tag: "ERROR", priority: "low" };
    case "watchlist":
      // Loudest channel: bright red embed, ntfy "max" priority + alarm tag.
      // ntfy on the phone vibrates differently for max-priority pushes.
      return { color: 0xff0033, tag: "WATCH", priority: "max" };
  }
}

function fmtTitle(args: NotifyArgs): string {
  const { tag } = severity(args.kind);
  if (args.event) return `[${tag}] ${args.event.source}: ${args.event.title}`;
  return `[${tag}] ${args.message.slice(0, 120)}`;
}

async function sendDiscord(url: string, args: NotifyArgs, ua: string): Promise<void> {
  const sev = severity(args.kind);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (args.event?.extra) {
    for (const [k, v] of Object.entries(args.event.extra)) {
      if (v == null || v === "") continue;
      fields.push({ name: k, value: String(v).slice(0, 200), inline: true });
    }
  }
  const body = {
    username: "sc-drop-watcher",
    embeds: [
      {
        title: fmtTitle(args).slice(0, 256),
        url: args.event?.url,
        description: args.message.slice(0, 2000),
        color: sev.color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": ua },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`discord webhook → HTTP ${res.status}`);
}

async function sendNtfy(url: string, args: NotifyArgs, token: string | undefined, ua: string): Promise<void> {
  const sev = severity(args.kind);
  const headers: Record<string, string> = {
    "user-agent": ua,
    "title": fmtTitle(args).slice(0, 250),
    "priority": sev.priority,
    "tags":
      args.kind === "watchlist" ? "rotating_light"
      : args.kind === "new" ? "rocket"
      : args.kind === "error" ? "warning"
      : "wastebasket",
  };
  if (args.event?.url) headers["click"] = args.event.url;
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: args.message.slice(0, 4000),
  });
  if (!res.ok) throw new Error(`ntfy → HTTP ${res.status}`);
}

export async function notify(targets: PushTargets, args: NotifyArgs): Promise<void> {
  const line = `${new Date().toISOString()} ${fmtTitle(args)} :: ${args.message}`;
  if (!targets.live) {
    console.log(`[DRY] ${line}${args.event?.url ? ` :: ${args.event.url}` : ""}`);
    return;
  }
  console.log(line);
  const tasks: Array<Promise<void>> = [];
  if (targets.discordWebhookUrl) tasks.push(sendDiscord(targets.discordWebhookUrl, args, targets.userAgent));
  if (targets.ntfyTopicUrl) tasks.push(sendNtfy(targets.ntfyTopicUrl, args, targets.ntfyToken, targets.userAgent));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.error("[push] failed:", r.reason);
  }
}
