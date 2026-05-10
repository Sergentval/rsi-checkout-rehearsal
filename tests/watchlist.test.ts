import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseWatchlist, matchWatchlist } from "../src/watchlist.js";

test("parseWatchlist: empty / undefined returns []", () => {
  assert.deepEqual(parseWatchlist(undefined), []);
  assert.deepEqual(parseWatchlist(""), []);
  assert.deepEqual(parseWatchlist("   "), []);
});

test("parseWatchlist: ship-only entries default to mode 'any'", () => {
  assert.deepEqual(parseWatchlist("Polaris"), [{ ship: "Polaris", mode: "any" }]);
  assert.deepEqual(parseWatchlist("Polaris,Idris"), [
    { ship: "Polaris", mode: "any" },
    { ship: "Idris", mode: "any" },
  ]);
});

test("parseWatchlist: ship:mode pairs parse the mode", () => {
  assert.deepEqual(parseWatchlist("Polaris:warbond"), [{ ship: "Polaris", mode: "warbond" }]);
  assert.deepEqual(parseWatchlist("Galaxy:store-credit"), [{ ship: "Galaxy", mode: "store-credit" }]);
  assert.deepEqual(parseWatchlist("Idris:any"), [{ ship: "Idris", mode: "any" }]);
});

test("parseWatchlist: mode aliases (wb / sc / credit)", () => {
  assert.deepEqual(parseWatchlist("Polaris:wb"), [{ ship: "Polaris", mode: "warbond" }]);
  assert.deepEqual(parseWatchlist("Polaris:sc"), [{ ship: "Polaris", mode: "store-credit" }]);
  assert.deepEqual(parseWatchlist("Polaris:credit"), [{ ship: "Polaris", mode: "store-credit" }]);
});

test("parseWatchlist: unknown modes fall back to 'any'", () => {
  assert.deepEqual(parseWatchlist("Polaris:bogus"), [{ ship: "Polaris", mode: "any" }]);
});

test("parseWatchlist: skips empty / blank entries", () => {
  assert.deepEqual(parseWatchlist("Polaris,,Idris"), [
    { ship: "Polaris", mode: "any" },
    { ship: "Idris", mode: "any" },
  ]);
  assert.deepEqual(parseWatchlist(":wb"), []);
});

test("matchWatchlist: empty list never matches", () => {
  assert.equal(matchWatchlist([], { title: "Polaris Warbond", url: "/x" }), null);
});

test("matchWatchlist: ship name match is case-insensitive substring", () => {
  const wl = parseWatchlist("polaris");
  const m = matchWatchlist(wl, { title: "POLARIS now on sale", url: "/x" });
  assert.equal(m?.ship, "polaris");
});

test("matchWatchlist: warbond mode requires the warbond marker", () => {
  const wl = parseWatchlist("Polaris:warbond");
  assert.ok(matchWatchlist(wl, { title: "Polaris Warbond", url: "/x" }));
  assert.equal(matchWatchlist(wl, { title: "Polaris", url: "/x" }), null);
});

test("matchWatchlist: store-credit mode rejects warbond marker", () => {
  const wl = parseWatchlist("Polaris:store-credit");
  assert.ok(matchWatchlist(wl, { title: "Polaris", url: "/UTV" }));
  assert.equal(matchWatchlist(wl, { title: "Polaris Warbond", url: "/UTV-Warbond" }), null);
});

test("matchWatchlist: 'any' mode accepts both", () => {
  const wl = parseWatchlist("Polaris:any");
  assert.ok(matchWatchlist(wl, { title: "Polaris Warbond", url: "/x" }));
  assert.ok(matchWatchlist(wl, { title: "Polaris", url: "/x" }));
});

test("matchWatchlist: returns the FIRST matching entry, not all", () => {
  const wl = parseWatchlist("Polaris:any,Polaris:warbond");
  const m = matchWatchlist(wl, { title: "Polaris Warbond", url: "/x" });
  assert.equal(m?.mode, "any");
});

test("matchWatchlist: 'warbond' marker is whole-word, not substring", () => {
  // Don't match a ship named e.g. 'Warbondage' — the marker requires \bwarbond\b.
  const wl = parseWatchlist("Foo:warbond");
  assert.equal(matchWatchlist(wl, { title: "Foo Warbondage", url: "/x" }), null);
});
