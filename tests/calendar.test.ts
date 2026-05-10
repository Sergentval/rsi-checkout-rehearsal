import { test } from "node:test";
import { strict as assert } from "node:assert";
import { calendarTicks } from "../src/calendar.js";

test("calendar emits 'imminent' inside the 24h pre-window", () => {
  // Invictus opens May 16. At May 15 12:00 UTC we should be within 24h.
  const now = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));
  const ticks = calendarTicks(now);
  const invictus = ticks.find((t) => t.key.startsWith("invictus-2026-imminent"));
  assert.ok(invictus, "expected invictus-2026-imminent tick");
  assert.equal(invictus?.kind, "imminent");
});

test("calendar emits 'opened' while inside the window", () => {
  const now = new Date(Date.UTC(2026, 4, 20, 12, 0, 0));
  const ticks = calendarTicks(now);
  const opened = ticks.find((t) => t.key === "invictus-2026-opened");
  assert.ok(opened);
  assert.equal(opened?.kind, "opened");
});

test("calendar emits nothing when no window is near", () => {
  // August has no window in the calendar.
  const now = new Date(Date.UTC(2026, 7, 1, 0, 0, 0));
  const ticks = calendarTicks(now);
  assert.equal(ticks.length, 0);
});

test("each tick has a unique stable key", () => {
  const now = new Date(Date.UTC(2026, 4, 20, 12, 0, 0));
  const a = calendarTicks(now).map((t) => t.key);
  const b = calendarTicks(now).map((t) => t.key);
  assert.deepEqual(a, b, "ticks should be deterministic for a given instant");
  assert.equal(new Set(a).size, a.length, "tick keys should be unique");
});
