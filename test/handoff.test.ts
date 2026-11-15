import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isRecord } from "@ambitious/kit/domain/json";

const now = "2026-01-10T00:00:00.000Z";
const moduleBinary = resolve("dist/ambitious-compliance.mjs");
const releaseTag = "tasks-v0.1.0";
const repository = "AmbitiousBots/ambitious-tasks";
const assetName = "ambitious-tasks-0.1.0.mjs";

const object = (value: unknown): Readonly<Record<string, unknown>> => {
  assert.ok(isRecord(value));
  return value;
};

const call = (binary: string, home: string, command: string, input: unknown = {}) => {
  const result = spawnSync(process.execPath, [binary, ...command.split(" "), "--now", now, "--seed", "7"], {
    input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, AMBITIOUS_HOME: home },
  });
  assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`);
  const envelope = object(JSON.parse(result.stdout));
  assert.equal(envelope.ok, true);
  return object(envelope.data);
};

const suggestions = (home: string): readonly Readonly<Record<string, unknown>>[] => {
  const metadata = { actor: "operator", reason: "Routine review" };
  call(moduleBinary, home, "program add", { id: "program-a", name: "Example program", framework: "custom", ...metadata });
  call(moduleBinary, home, "control add", { id: "control-a", programId: "program-a", ref: "review-1", title: "Periodic review", owner: "owner", cadenceDays: 20, ...metadata });
  call(moduleBinary, home, "evidence add", { id: "record-a", controlId: "control-a", kind: "review", summary: "Review complete", collectedAt: now, expiresAt: "2026-01-14T00:00:00Z", ...metadata });
  call(moduleBinary, home, "attest", { id: "record-a", controlId: "control-a", by: "reviewer", statement: "Review confirmed", at: now, expiresAt: "2026-01-14T00:00:00Z", ...metadata });
  const result = call(moduleBinary, home, "expiring", { programId: "program-a", withinDays: 7 });
  assert.ok(Array.isArray(result.items));
  return result.items.map((item: unknown) => object(object(item).task));
};

test("suggested task payloads use the documented add fields and stable distinct keys", () => {
  const home = mkdtempSync(join(tmpdir(), "compliance-task-shape-"));
  try {
    const payloads = suggestions(home);
    assert.equal(payloads.length, 2);
    for (const payload of payloads) {
      assert.deepEqual(Object.keys(payload).sort(), ["done_when", "due", "idem_key", "labels", "list", "title"]);
      assert.equal(typeof payload.title, "string");
      assert.equal(payload.list, "compliance");
      assert.equal(payload.due, "2026-01-14T00:00:00.000Z");
      assert.ok(Array.isArray(payload.labels));
      assert.ok(payload.labels.every((label: unknown) => typeof label === "string"));
      assert.equal(typeof payload.done_when, "string");
      assert.equal(typeof payload.idem_key, "string");
    }
    assert.deepEqual(payloads.map((payload) => payload.idem_key).sort(), ["compliance:attestation:record-a:2026-01-14T00:00:00.000Z", "compliance:record-a:2026-01-14T00:00:00.000Z"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("released tasks module accepts expiry suggestions and deduplicates repeated handoffs", (context) => {
  const release = spawnSync("gh", ["release", "view", releaseTag, "--repo", repository, "--json", "tagName"], { encoding: "utf8", timeout: 30_000 });
  if (release.status !== 0 && release.stderr.trim() === "release not found") {
    context.skip(`${releaseTag} is not published in ${repository}; local task payload checks still run.`);
    return;
  }
  assert.equal(release.status, 0, `Cannot inspect the tasks release: ${release.stderr}${release.error?.message ?? ""}`);
  assert.equal(object(JSON.parse(release.stdout)).tagName, releaseTag);
  const scratch = mkdtempSync(join(tmpdir(), "compliance-task-handoff-"));
  try {
    const download = spawnSync("gh", ["release", "download", releaseTag, "--repo", repository, "--dir", scratch, "--pattern", assetName, "--pattern", "SHA256SUMS"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(download.status, 0, `Cannot download the tasks release: ${download.stderr}${download.error?.message ?? ""}`);
    const binary = join(scratch, assetName);
    const checksumLine = readFileSync(join(scratch, "SHA256SUMS"), "utf8").split("\n").find((line) => line.trim().split(/\s+/)[1] === assetName);
    assert.ok(checksumLine, "SHA256SUMS must name the tasks release asset");
    assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), checksumLine.split(/\s+/)[0]);
    const payloads = suggestions(join(scratch, "compliance-home"));
    const home = join(scratch, "tasks-home");
    call(binary, home, "selfcheck");
    for (const payload of payloads) {
      const first = call(binary, home, "add", payload);
      const repeated = call(binary, home, "add", payload);
      assert.equal(object(first.task).id, object(repeated.task).id);
    }
    const listed = call(binary, home, "list", { list: "compliance" });
    assert.ok(Array.isArray(listed.tasks));
    assert.equal(listed.tasks.length, payloads.length);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
