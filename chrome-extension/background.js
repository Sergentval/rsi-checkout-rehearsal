// MV3 service worker — runs the Scout (periodic ship-availability polling)
// and the cart-tab keep-alive (prevents Chrome from discarding the tab).
//
// Activated by chrome.alarms; each tick reads the scout list from storage,
// fetches each ship's pledge page, and detects state transitions.

"use strict";

const SCOUT_ALARM = "scr-scout";
const KEEPALIVE_ALARM = "scr-keepalive";
const PREWAVE_ALARM = "scr-prewave";
const PREWAVE_LEAD_MIN = 5; // notification fires N minutes before each wave

// Storage shape:
//   scoutShips:        Array<{ id, name, url, lastAvailable, lastChecked, lastTransitionAt, lastError }>
//   scoutEnabled:      boolean    (default true)
//   scoutIntervalSec:  number     (default 30; min 1.5; ≥30 uses chrome.alarms,
//                                  <30 uses setInterval inside the SW)
//   keepAliveEnabled:  boolean    (default true) — non-discardable cart tabs

const DEFAULTS = {
  scoutShips: [],
  scoutEnabled: true,
  scoutIntervalSec: 30,
  keepAliveEnabled: true,
};

// Wave config defaults — kept in sync with content.js DEFAULT_WAVE_CONFIG.
// (Verified from the DefenseCon 2956 FAQ on 2026-05-11.)
const DEFAULT_WAVE_CONFIG = {
  eventName: "DefenseCon 2956",
  startMs: Date.UTC(2026, 4, 14, 16, 0, 0),
  endMs:   Date.UTC(2026, 4, 27, 20, 0, 0),
  waveTimesUtc: [16 * 60, 20 * 60, 0 * 60, 4 * 60, 8 * 60, 12 * 60],
  limitedShips: [
    { name: "Drake Kraken",           availableFromMs: Date.UTC(2026, 4, 14, 16, 0, 0) },
    { name: "Drake Kraken Privateer", availableFromMs: Date.UTC(2026, 4, 14, 16, 0, 0) },
    { name: "Aegis Idris-P",          availableFromMs: Date.UTC(2026, 4, 20, 16, 0, 0) },
    { name: "Aegis Javelin",          availableFromMs: Date.UTC(2026, 4, 20, 16, 0, 0) },
  ],
};

const ALARM_FLOOR_SEC = 30;       // Chrome's MV3 alarm minimum.
const FAST_POLL_FLOOR_SEC = 1.5;  // Politeness floor for in-SW setInterval.
let fastPollHandle = null;        // setInterval handle while in fast mode.

// ---------------- Lifecycle -------------------------------------------

chrome.runtime.onInstalled.addListener(reconcileAlarms);
chrome.runtime.onStartup?.addListener(reconcileAlarms);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("scoutEnabled" in changes || "scoutIntervalSec" in changes) reconcileAlarms();
  if ("keepAliveEnabled" in changes) reconcileKeepAlive();
  if ("waveConfig" in changes || "scoutShips" in changes) schedulePreWaveAlarm();
});

// Sub-30s polling: setInterval inside the service worker. Chrome will
// terminate the SW after ~30s of idle; the SCOUT_ALARM (always running at
// the alarm-floor cadence) restarts the SW, which re-invokes
// reconcileAlarms() on startup and re-creates the interval. So fast-poll
// resumes within ~30s of any SW death.
function startFastPoll(intervalSec) {
  stopFastPoll();
  const sec = Math.max(FAST_POLL_FLOOR_SEC, Number(intervalSec) || FAST_POLL_FLOOR_SEC);
  fastPollHandle = setInterval(() => {
    pollAllScoutShips().catch((err) => console.error("[scr] fast poll err:", err));
  }, sec * 1000);
}

function stopFastPoll() {
  if (fastPollHandle) { clearInterval(fastPollHandle); fastPollHandle = null; }
}

async function reconcileAlarms() {
  const { scoutEnabled, scoutIntervalSec } = await chrome.storage.local.get(DEFAULTS);
  await chrome.alarms.clear(SCOUT_ALARM);
  stopFastPoll();

  if (scoutEnabled) {
    const sec = Math.max(FAST_POLL_FLOOR_SEC, Number(scoutIntervalSec) || 30);
    if (sec < ALARM_FLOOR_SEC) {
      // Fast tier — setInterval inside the SW, plus a 30s heartbeat alarm
      // that wakes the SW back up if Chrome killed it for being idle.
      startFastPoll(sec);
      chrome.alarms.create(SCOUT_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.05 });
    } else {
      // Slow tier — chrome.alarms is sufficient. No setInterval needed.
      chrome.alarms.create(SCOUT_ALARM, { periodInMinutes: sec / 60, delayInMinutes: 0.05 });
    }
  }

  // Keep-alive alarm — always-on (every minute, marks /cart tabs).
  await chrome.alarms.clear(KEEPALIVE_ALARM);
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });

  // Pre-wave reminder is computed from waveConfig — schedule next one.
  await schedulePreWaveAlarm();
}

// ---------------- Pre-wave reminders ----------------------------------

async function getWaveConfig() {
  const stored = await chrome.storage.local.get({ waveConfig: null });
  return stored.waveConfig
    ? { ...DEFAULT_WAVE_CONFIG, ...stored.waveConfig }
    : { ...DEFAULT_WAVE_CONFIG };
}

function computeNextWaveTimestamp(cfg, now = Date.now()) {
  if (!cfg.eventName) return null;
  if (now < cfg.startMs) return cfg.startMs;
  if (now > cfg.endMs)   return null;
  const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  const baseMs = today.getTime();
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    for (const minOff of cfg.waveTimesUtc) {
      const t = baseMs + dayOffset * 86_400_000 + minOff * 60_000;
      if (t > now && t <= cfg.endMs + 6 * 3_600_000) return t;
    }
  }
  return null;
}

async function schedulePreWaveAlarm() {
  await chrome.alarms.clear(PREWAVE_ALARM);
  const cfg = await getWaveConfig();
  const nextWaveMs = computeNextWaveTimestamp(cfg);
  if (!nextWaveMs) return;
  const fireMs = nextWaveMs - PREWAVE_LEAD_MIN * 60_000;
  // Only schedule if there's at least a minute of headroom (otherwise we'd
  // fire and immediately re-schedule the same wave).
  if (fireMs <= Date.now() + 60_000) {
    // Re-check 60s after the wave passes to schedule the one after.
    chrome.alarms.create(PREWAVE_ALARM, { when: nextWaveMs + 60_000 });
    return;
  }
  chrome.alarms.create(PREWAVE_ALARM, { when: fireMs });
}

async function firePreWaveNotification() {
  const cfg = await getWaveConfig();
  const stored = await chrome.storage.local.get({ scoutShips: [] });
  const watched = (stored.scoutShips || []).filter((s) => {
    if (!s.name) return false;
    const lower = s.name.toLowerCase();
    return cfg.limitedShips.some((w) =>
      (lower.includes(w.name.toLowerCase()) || w.name.toLowerCase().includes(lower))
      && Date.now() >= w.availableFromMs,
    );
  });
  const title = watched.length > 0
    ? `Wave in ${PREWAVE_LEAD_MIN} min — ${watched.length} ship${watched.length === 1 ? "" : "s"} active`
    : `Wave in ${PREWAVE_LEAD_MIN} min`;
  const message = watched.length > 0
    ? `Watching: ${watched.map((s) => s.name).join(", ")}\nGet ready — wave drops in ${PREWAVE_LEAD_MIN} minutes.`
    : `${cfg.eventName} wave drops in ${PREWAVE_LEAD_MIN} minutes.`;
  const id = `scr-prewave-${Date.now()}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message,
    priority: 2,
    requireInteraction: true,
  });
  // Re-schedule for the next wave.
  await schedulePreWaveAlarm();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name === SCOUT_ALARM) await pollAllScoutShips();
    else if (alarm.name === KEEPALIVE_ALARM) await reconcileKeepAlive();
    else if (alarm.name === PREWAVE_ALARM) await firePreWaveNotification();
  } catch (err) {
    console.error("[scr] alarm handler error:", err);
  }
});

// ---------------- Scout polling ---------------------------------------

async function pollAllScoutShips() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  if (!stored.scoutEnabled) return;
  const ships = Array.isArray(stored.scoutShips) ? [...stored.scoutShips] : [];
  if (ships.length === 0) return;

  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    if (!s?.url) continue;
    const result = await checkShipAvailability(s.url);
    const now = Date.now();
    const prev = s.lastAvailable;
    s.lastChecked = now;
    s.lastError = result.error || null;
    if (result.available !== null) {
      if (prev !== result.available) {
        s.lastTransitionAt = now;
        // Fire a notification on sold-out → available (the interesting case).
        if (result.available === true) await fireBackInStockNotification(s);
      }
      s.lastAvailable = result.available;
    }
    ships[i] = s;
  }
  await chrome.storage.local.set({ scoutShips: ships });
}

// Returns { available: true|false|null, error?: string }.
// `null` means the response shape was ambiguous and we don't want to flip
// state on a false signal.
async function checkShipAvailability(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: ctrl.signal,
      headers: { accept: "text/html" },
    });
    clearTimeout(t);
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const html = await res.text();

    // Positive signals (page offers a purchase path right now).
    if (/>\s*VIEW OFFERS?\s*</i.test(html)) return { available: true };
    if (/data-cy-id="button__text"[^>]*>\s*Add to cart\s*</i.test(html)) return { available: true };

    // Negative signals (RSI text patterns observed on sold-out pages).
    if (/sold[\s-]?out/i.test(html)) return { available: false };
    if (/coming\s+soon/i.test(html)) return { available: false };
    if (/no\s+longer\s+available/i.test(html)) return { available: false };
    if (/currently\s+unavailable/i.test(html)) return { available: false };

    return { available: null };
  } catch (err) {
    return { available: false, error: err.message || String(err) };
  }
}

async function fireBackInStockNotification(ship) {
  const notifId = `scr-scout-${ship.id ?? ship.url}-${Date.now()}`;
  await chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: `${ship.name} is BACK IN STOCK`,
    message: `${ship.url}\nClick to open.`,
    priority: 2,
    requireInteraction: true,
  });
  // Map notification id → url for the click handler below.
  pendingClickUrls.set(notifId, ship.url);
}

const pendingClickUrls = new Map();
chrome.notifications.onClicked.addListener(async (id) => {
  const url = pendingClickUrls.get(id);
  pendingClickUrls.delete(id);
  if (url) await chrome.tabs.create({ url, active: true });
  chrome.notifications.clear(id);
});

// ---------------- Keep-alive ------------------------------------------
// Mark /cart and /checkout tabs on RSI as non-discardable so Chrome doesn't
// unload them while you're away. Reverts automatically when the user
// closes the tab. Cheap to call — chrome.tabs.update is a no-op if the
// flag is already set.

async function reconcileKeepAlive() {
  const { keepAliveEnabled } = await chrome.storage.local.get(DEFAULTS);
  if (!keepAliveEnabled) return;
  const tabs = await chrome.tabs.query({
    url: ["*://robertsspaceindustries.com/*/cart*", "*://robertsspaceindustries.com/cart*",
          "*://robertsspaceindustries.com/*/checkout/*", "*://robertsspaceindustries.com/checkout/*"],
  });
  for (const tab of tabs) {
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); }
    catch { /* permission denied on some tab states; ignore */ }
  }
}

// Also reconcile when a relevant tab finishes loading.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab.url) return;
  if (!/robertsspaceindustries\.com\/(?:[a-z]{2}\/)?(?:cart|checkout)/i.test(tab.url)) return;
  const { keepAliveEnabled } = await chrome.storage.local.get(DEFAULTS);
  if (!keepAliveEnabled) return;
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch { /* ignore */ }
});

// First boot — make sure alarms exist even if user never opens options.
reconcileAlarms().catch(() => {});
