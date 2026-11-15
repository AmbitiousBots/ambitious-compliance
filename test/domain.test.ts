import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { Failure } from "@ambitious/kit/domain/failure";
import { programExpiring, programGaps, programStatus } from "../src/domain/analysis.ts";
import { parseAttestation, parseControl, parseEvidence, parseInstant, parseProgram } from "../src/domain/parse.ts";
import type { Attestation, Control, Evidence, Projection } from "../src/domain/types.ts";

const DAY_MS = 86_400_000;
const program = parseProgram({ id: "program-1", name: "Example program", framework: "custom" });
const control = parseControl({ id: "control-1", programId: program.id, ref: "C1", title: "Review records", owner: "reviewer", cadenceDays: 28 });
const instant = (epoch: number) => parseInstant(new Date(epoch).toISOString());
const origin = Date.parse("2026-01-01T00:00:00.000Z");

const evidence = (id: string, start: number, end: number, controlId = control.id): Evidence => parseEvidence({
  id, controlId, kind: "record", summary: "Recorded review", collectedAt: instant(start), expiresAt: instant(end),
});

const attestation = (id: string, start: number, end: number, controlId = control.id): Attestation => parseAttestation({
  id, controlId, by: "reviewer", statement: "Review completed", at: instant(start), expiresAt: instant(end),
});

const projection = (items: readonly Evidence[] = [], attestations: readonly Attestation[] = [], controls: readonly Control[] = [control]): Projection => ({
  programs: new Map([[program.id, program]]),
  controls: new Map(controls.map((item) => [item.id, item])),
  evidence: new Map(items.map((item) => [item.id, item])),
  attestations: new Map(attestations.map((item) => [item.id, item])),
  documents: new Map(),
});

test("status includes collection time, excludes expiration time, and marks the renewal threshold yellow", () => {
  const state = projection([evidence("record-1", origin, origin + 28 * DAY_MS)]);
  const colors = [-1, 0, 21 * DAY_MS - 1, 21 * DAY_MS, 28 * DAY_MS - 1, 28 * DAY_MS].map((offset) =>
    programStatus(state, program.id, instant(origin + offset)).controls[0]?.status.color);
  assert.deepEqual(colors, ["red", "green", "green", "yellow", "yellow", "red"]);
  assert.equal(programGaps(state, program.id, instant(origin)).controls.length, 0);
  assert.equal(programGaps(state, program.id, instant(origin + 28 * DAY_MS)).controls.length, 1);
});

test("every required control with no current support is red with a reason", () => {
  assert.deepEqual(programStatus(projection(), program.id, instant(origin)).controls, [{
    controlId: control.id, status: { color: "red", reasons: [{ kind: "nothing_recorded" }] },
  }]);
  const future = evidence("future", origin + DAY_MS, origin + 2 * DAY_MS);
  const expired = attestation("past", origin - 2 * DAY_MS, origin);
  assert.deepEqual(programStatus(projection([future], [expired]), program.id, instant(origin)).controls[0]?.status, {
    color: "red",
    reasons: [
      { kind: "not_yet_collected", evidenceId: future.id, collectedAt: future.collectedAt },
      { kind: "expired", support: { kind: "attestation", attestationId: expired.id, expiresAt: expired.expiresAt } },
    ],
  });
});

test("a current attestation supports status until expiration while an evidence gap remains", () => {
  const item = attestation("review-1", origin, origin + 28 * DAY_MS);
  const state = projection([], [item]);
  assert.equal(programStatus(state, program.id, instant(origin - 1)).controls[0]?.status.color, "red");
  assert.equal(programStatus(state, program.id, instant(origin)).controls[0]?.status.color, "green");
  assert.deepEqual(programGaps(state, program.id, instant(origin)).controls, [{ controlId: control.id, reasons: [{ kind: "nothing_recorded" }] }]);
  assert.equal(programStatus(state, program.id, item.expiresAt).controls[0]?.status.color, "red");
});

test("the longest remaining support determines status without depending on map insertion order", () => {
  const shorter = evidence("short", origin, origin + DAY_MS);
  const longer = evidence("long", origin, origin + 30 * DAY_MS);
  const laterAttestation = attestation("review", origin, origin + 60 * DAY_MS);
  const first = programStatus(projection([shorter, longer], [laterAttestation]), program.id, instant(origin));
  const second = programStatus(projection([longer, shorter], [laterAttestation]), program.id, instant(origin));
  assert.deepEqual(first, second);
  assert.deepEqual(first.controls[0]?.status, {
    color: "green", reasons: [{ kind: "current", support: { kind: "attestation", attestationId: laterAttestation.id, expiresAt: laterAttestation.expiresAt } }],
  });
});

test("generated clocks never count expired or future evidence", () => {
  fc.assert(fc.property(
    fc.integer({ min: -2_000_000_000_000, max: 2_000_000_000_000 }),
    fc.integer({ min: 1, max: 90 * DAY_MS }),
    fc.integer({ min: -90 * DAY_MS, max: 180 * DAY_MS }),
    (start, duration, offset) => {
      const end = start + duration;
      const now = start + offset;
      const item = evidence("generated", start, end);
      const state = projection([item]);
      const status = programStatus(state, program.id, instant(now)).controls[0]?.status.color;
      const current = start <= now && now < end;
      const expected = !current ? "red" : end - now <= 7 * DAY_MS ? "yellow" : "green";
      assert.equal(status, expected);
      assert.equal(programGaps(state, program.id, instant(now)).controls.length, current ? 0 : 1);
    },
  ), { numRuns: 2_000, seed: 1307 });
});

test("generated clocks never count expired or future attestations", () => {
  fc.assert(fc.property(
    fc.integer({ min: -2_000_000_000_000, max: 2_000_000_000_000 }),
    fc.integer({ min: 1, max: 90 * DAY_MS }),
    fc.integer({ min: -90 * DAY_MS, max: 180 * DAY_MS }),
    (start, duration, offset) => {
      const end = start + duration;
      const now = start + offset;
      const state = projection([], [attestation("generated", start, end)]);
      const expected = now < start || now >= end ? "red" : end - now <= 7 * DAY_MS ? "yellow" : "green";
      assert.equal(programStatus(state, program.id, instant(now)).controls[0]?.status.color, expected);
      assert.equal(programGaps(state, program.id, instant(now)).controls.length, 1);
    },
  ), { numRuns: 2_000, seed: 1308 });
});

test("expiring suggestions include the horizon boundary and distinguish evidence from attestations", () => {
  const state = projection([
    evidence("same-id", origin, origin + 7 * DAY_MS),
    evidence("expired", origin - DAY_MS, origin),
    evidence("future", origin + DAY_MS, origin + 2 * DAY_MS),
    evidence("later", origin, origin + 7 * DAY_MS + 1),
  ], [attestation("same-id", origin, origin + 7 * DAY_MS)]);
  const result = programExpiring(state, program.id, instant(origin), 7);
  assert.deepEqual(result.items.map(({ kind, id }) => [kind, id]), [["attestation", "same-id"], ["evidence", "same-id"]]);
  assert.deepEqual(result.items.map(({ task }) => task.idem_key), [
    "compliance:attestation:same-id:2026-01-08T00:00:00.000Z",
    "compliance:same-id:2026-01-08T00:00:00.000Z",
  ]);
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item.task).sort(), ["done_when", "due", "idem_key", "labels", "list", "title"]);
    assert.equal(item.task.list, "compliance");
    assert.equal(item.task.due, "2026-01-08T00:00:00.000Z");
    assert.deepEqual(item.task.labels, ["compliance", "program:program-1", "control:control-1"]);
    assert.equal(item.task.title, `Renew ${item.kind} same-id`);
    assert.match(item.task.done_when, /control control-1 before 2026-01-08T00:00:00.000Z/);
  }
  assert.equal(programExpiring(state, program.id, instant(origin), 0).items.length, 0);
  assert.deepEqual(programExpiring(state, program.id, instant(origin + 1), 7).items[0]?.task, result.items[0]?.task);
});

test("analysis filters other programs and sorts controls by identifier", () => {
  const otherProgram = parseProgram({ id: "other-program", name: "Other program", framework: "custom" });
  const otherControl = parseControl({ ...control, id: "control-0", programId: otherProgram.id });
  const laterControl = parseControl({ ...control, id: "control-2" });
  const state = projection([], [], [laterControl, otherControl, control]);
  assert.deepEqual(programStatus(state, program.id, instant(origin)).controls.map((item) => item.controlId), [control.id, laterControl.id]);
  assert.deepEqual(programGaps(state, program.id, instant(origin)).controls.map((item) => item.controlId), [control.id, laterControl.id]);
  assert.throws(() => programStatus(state, otherProgram.id, instant(origin)), (error: unknown) => error instanceof Failure && error.errors[0].code === "E_NOT_FOUND");
});
