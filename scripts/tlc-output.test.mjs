import assert from "node:assert/strict";
import test from "node:test";
import { distinctStateCount } from "./tlc-output.mjs";

test("the reported state count comes from the completed search, not an earlier progress update", () => {
  const output = [
    "Progress(28) at 2026-01-01 00:00:03: 173,648 states generated (173,648 s/min), 81,531 distinct states found (81,531 ds/min), 23,752 states left on queue.",
    "Model checking completed. No error has been found.",
    "930065 states generated, 358569 distinct states found, 0 states left on queue.",
  ].join("\n");
  assert.equal(distinctStateCount(output), 358569);
});

test("thousands separators do not truncate the state count", () => {
  assert.equal(distinctStateCount("930,065 states generated, 358,569 distinct states found, 0 states left on queue."), 358569);
});

test("missing completion totals are not mistaken for a completed search", () => {
  assert.equal(distinctStateCount("Progress(12): 500 states generated, 260 distinct states found, 19 states left on queue."), null);
});
