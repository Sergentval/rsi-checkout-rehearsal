import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseProbeUrls, classifyTransition } from "../src/probe.js";

test("parseProbeUrls: empty / undefined returns []", () => {
  assert.deepEqual(parseProbeUrls(undefined), []);
  assert.deepEqual(parseProbeUrls(""), []);
});

test("parseProbeUrls: drops entries without http(s):// scheme", () => {
  assert.deepEqual(parseProbeUrls("not-a-url,https://x.test/a,/relative,http://y.test"), [
    "https://x.test/a",
    "http://y.test",
  ]);
});

test("parseProbeUrls: trims whitespace, splits on comma", () => {
  assert.deepEqual(
    parseProbeUrls(" https://a.test/x , https://b.test/y "),
    ["https://a.test/x", "https://b.test/y"],
  );
});

test("classifyTransition: first observation is always silent", () => {
  assert.equal(classifyTransition(undefined, 200).kind, "silent");
  assert.equal(classifyTransition(undefined, 404).kind, "silent");
  assert.equal(classifyTransition(undefined, -1).kind, "silent");
});

test("classifyTransition: 4xx → 2xx is went-live (the headline event)", () => {
  assert.equal(classifyTransition(404, 200).kind, "went-live");
  assert.equal(classifyTransition(403, 200).kind, "went-live");
  assert.equal(classifyTransition(-1, 200).kind, "went-live");
  assert.equal(classifyTransition(500, 204).kind, "went-live");
});

test("classifyTransition: 2xx → 4xx is went-down (informational)", () => {
  assert.equal(classifyTransition(200, 404).kind, "went-down");
  assert.equal(classifyTransition(200, 500).kind, "went-down");
  assert.equal(classifyTransition(200, -1).kind, "went-down");
});

test("classifyTransition: same-class transitions are silent", () => {
  assert.equal(classifyTransition(200, 200).kind, "silent");
  assert.equal(classifyTransition(200, 204).kind, "silent");
  assert.equal(classifyTransition(404, 500).kind, "silent");
  assert.equal(classifyTransition(404, 404).kind, "silent");
});
