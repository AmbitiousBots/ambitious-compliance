import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isRecord } from "@ambitious/kit/domain/json";

const binary = resolve("dist/ambitious-compliance.mjs");
const now = "2026-01-10T00:00:00.000Z";
const provenance = { actor: "operator", reason: "Routine review" };
const program = { id: "program-a", name: "Example program", framework: "custom", ...provenance };
const control = { id: "control-a", programId: program.id, ref: "review-1", title: "Periodic review", owner: "owner", cadenceDays: 20, ...provenance };
const evidence = { id: "evidence-a", controlId: control.id, kind: "review", summary: "Review completed", collectedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-14T00:00:00Z", ...provenance };
const page = { pageId: "page-a", version: 1, sha256: "a".repeat(64) };
const document = { id: "document-a", programId: program.id, title: "Review procedure", page, ...provenance };

const object = (raw: unknown): Readonly<Record<string, unknown>> => {
  assert.ok(isRecord(raw));
  return raw;
};

const array = (raw: unknown): readonly unknown[] => {
  assert.ok(Array.isArray(raw));
  return raw;
};

const run = (home: string, command: string, input: unknown = {}, flags: readonly string[] = [], expected = 0) => {
  const effectiveFlags = flags.includes("--now") ? flags : ["--now", now, ...flags];
  const result = spawnSync(process.execPath, [binary, ...command.split(" "), "--seed", "7", ...effectiveFlags], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, AMBITIOUS_HOME: home },
  });
  assert.equal(result.status, expected, `${command}: ${result.stdout}${result.stderr}`);
  const envelope = object(JSON.parse(result.stdout));
  assert.deepEqual(Object.keys(envelope), ["ok", "schemaVersion", "module", "command", "data", "errors", "meta"]);
  assert.equal(envelope.ok, expected === 0);
  assert.equal(envelope.module, "compliance");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(result.stdout.split("\n").length, 2);
  return { envelope, data: object(envelope.data), stdout: result.stdout };
};

const isolated = (check: (home: string) => void) => {
  const home = mkdtempSync(join(tmpdir(), "compliance-cli-"));
  try { check(home); } finally { rmSync(home, { recursive: true, force: true }); }
};

const setup = (home: string) => {
  run(home, "program add", program);
  run(home, "control add", control);
};

const statusColor = (data: Readonly<Record<string, unknown>>): unknown => object(object(array(data.controls)[0]).status).color;

test("programs and controls persist with a history receipt for each write", () => isolated((home) => {
  const addedProgram = run(home, "program add", program).data;
  assert.equal(addedProgram.entity, "program");
  assert.equal(addedProgram.historySeq, 1);
  assert.match(String(addedProgram.hash), /^[0-9a-f]{64}$/);
  const addedControl = run(home, "control add", control).data;
  assert.equal(addedControl.historySeq, 2);
  assert.notEqual(addedControl.hash, addedProgram.hash);
  assert.equal(statusColor(run(home, "status", { programId: program.id }).data), "red");
  const exported = run(home, "export", { programId: program.id }).data;
  assert.equal(object(array(exported.programs)[0]).name, program.name);
  assert.equal(object(array(exported.controls)[0]).title, control.title);
  assert.equal(array(exported.history).length, 2);
}));

test("evidence and attestations change status only while current", () => isolated((home) => {
  setup(home);
  assert.equal(array(run(home, "gaps", { programId: program.id }).data.controls).length, 1);
  run(home, "evidence add", evidence);
  assert.equal(statusColor(run(home, "status", { programId: program.id }).data), "yellow");
  assert.equal(array(run(home, "gaps", { programId: program.id }).data.controls).length, 0);
  const expired = run(home, "status", { programId: program.id }, ["--now", "2026-01-14T00:00:00Z"]);
  assert.equal(statusColor(expired.data), "red");
  run(home, "attest", { id: "attestation-a", controlId: control.id, by: "reviewer", statement: "Review confirmed", at: now, expiresAt: "2026-03-01T00:00:00Z", ...provenance });
  assert.equal(statusColor(run(home, "status", { programId: program.id }).data), "green");
  assert.equal(array(run(home, "gaps", { programId: program.id }, ["--now", "2026-01-14T00:00:00Z"]).data.controls).length, 1);
  assert.equal(statusColor(run(home, "status", { programId: program.id }, ["--now", "2026-03-01T00:00:00Z"]).data), "red");
}));

test("expiry suggestions contain task inputs and never create another module database", () => isolated((home) => {
  setup(home);
  run(home, "evidence add", evidence);
  run(home, "attest", { id: "evidence-a", controlId: control.id, by: "reviewer", statement: "Review confirmed", at: now, expiresAt: evidence.expiresAt, ...provenance });
  const result = run(home, "expiring", { programId: program.id, withinDays: 4 }).data;
  const items = array(result.items).map(object);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.kind).sort(), ["attestation", "evidence"]);
  const keys = items.map((item) => object(item.task).idem_key).sort();
  assert.deepEqual(keys, ["compliance:attestation:evidence-a:2026-01-14T00:00:00.000Z", "compliance:evidence-a:2026-01-14T00:00:00.000Z"]);
  assert.equal(array(run(home, "expiring", { programId: program.id, withinDays: 3 }).data.items).length, 0);
  assert.equal(array(run(home, "expiring", { programId: program.id, withinDays: 30 }, ["--now", "2026-01-14T00:00:00Z"]).data.items).length, 0);
  assert.equal(existsSync(join(home, "tasks")), false);
}));

test("document checks report changed content without recording it", () => isolated((home) => {
  setup(home);
  run(home, "doc record", document);
  assert.equal(run(home, "doc check", { docId: document.id, sha256: page.sha256 }).data.matches, true);
  const before = run(home, "export", { programId: program.id }).stdout;
  const changed = run(home, "doc check", { docId: document.id, sha256: "b".repeat(64) }, [], 1);
  assert.equal(object(array(changed.envelope.errors)[0]).code, "E_DOC_CHANGED");
  assert.equal(run(home, "export", { programId: program.id }).stdout, before);
  run(home, "doc record", { ...document, page: { ...page, version: 2, sha256: "b".repeat(64) }, reason: "Record approved revision" });
  assert.equal(run(home, "doc check", { docId: document.id, sha256: "b".repeat(64) }).data.matches, true);
  assert.equal(array(run(home, "export", { programId: program.id }).data.history).length, 4);
}));

test("exported history verifies independently and rebuild preserves the visible state", () => isolated((home) => {
  setup(home);
  run(home, "evidence add", evidence);
  run(home, "doc record", document);
  const before = run(home, "export", { programId: program.id });
  assert.equal(run(home, "verify-chain").data.ok, true);
  const otherHome = join(home, "independent");
  assert.equal(run(otherHome, "verify-chain", before.stdout).data.ok, true);
  assert.equal(run(otherHome, "verify-chain", before.data).data.ok, true);
  assert.equal(existsSync(join(otherHome, "compliance", "compliance.sqlite")), false);
  const entries = array(before.data.history).map(object);
  const damaged = { ...before.data, history: entries.map((entry, index) => index === 1 ? { ...entry, reason: "Changed reason" } : entry) };
  const verification = run(otherHome, "verify-chain", damaged).data;
  assert.equal(verification.ok, false);
  assert.equal(verification.firstBadSeq, 2);
  run(home, "rebuild");
  assert.equal(run(home, "export", { programId: program.id }).stdout, before.stdout);
}));

test("analysis returns identical bytes and leaves the stored database unchanged", () => isolated((home) => {
  setup(home);
  run(home, "evidence add", evidence);
  run(home, "doc record", document);
  const database = join(home, "compliance", "compliance.sqlite");
  const before = readFileSync(database);
  const queries = [
    { command: "status", input: { programId: program.id } },
    { command: "gaps", input: { programId: program.id } },
    { command: "expiring", input: { programId: program.id, withinDays: 10 } },
    { command: "doc check", input: { docId: document.id, sha256: page.sha256 } },
    { command: "export", input: { programId: program.id } },
    { command: "verify-chain", input: {} },
  ];
  for (const query of queries) {
    assert.equal(run(home, query.command, query.input).stdout, run(home, query.command, query.input).stdout);
    assert.deepEqual(readFileSync(database), before);
  }
}));

test("analysis needs a current database and never creates one", () => isolated((home) => {
  const queries = [
    { command: "status", input: { programId: program.id } },
    { command: "gaps", input: { programId: program.id } },
    { command: "expiring", input: { programId: program.id, withinDays: 10 } },
    { command: "doc check", input: { docId: document.id, sha256: page.sha256 } },
    { command: "export", input: { programId: program.id } },
    { command: "verify-chain", input: {} },
  ];
  for (const query of queries) {
    const result = run(home, query.command, query.input, [], 2);
    assert.equal(object(array(result.envelope.errors)[0]).code, "E_MIGRATION");
    assert.equal(existsSync(join(home, "compliance")), false);
  }
}));

test("invalid read input is rejected before a database is opened", () => isolated((home) => {
  for (const command of ["status", "gaps", "expiring", "doc check", "export"]) {
    const result = run(home, command, {}, [], 1);
    assert.equal(object(array(result.envelope.errors)[0]).code, "E_INPUT_SCHEMA");
    assert.equal(existsSync(join(home, "compliance")), false);
  }
  const result = run(home, "verify-chain", { history: [] }, [], 1);
  assert.equal(object(array(result.envelope.errors)[0]).code, "E_INPUT_SCHEMA");
  assert.equal(existsSync(join(home, "compliance")), false);
}));

test("selfcheck and discovery expose a ready database and every command", () => isolated((home) => {
  const selfcheck = run(home, "selfcheck").data;
  assert.deepEqual(selfcheck.problems, []);
  assert.equal(object(selfcheck.runtime).name, "node");
  assert.match(String(object(selfcheck.runtime).version), /^24\./);
  assert.equal(object(selfcheck.binary).sha256, createHash("sha256").update(readFileSync(binary)).digest("hex"));
  assert.equal(object(selfcheck.db).integrityCheck, "ok");
  assert.equal(object(selfcheck.db).userVersion, 3);
  assert.equal(existsSync(join(home, "compliance", "compliance.sqlite")), true);
  const discovery = run(home, "commands").data;
  const commands = array(discovery.commands).map(object);
  assert.deepEqual(commands.map((item) => item.name).sort(), ["attest", "commands", "control add", "doc check", "doc record", "evidence add", "expiring", "export", "gaps", "program add", "rebuild", "selfcheck", "status", "verify-chain"].sort());
  for (const name of ["status", "gaps", "expiring", "doc check", "export"]) {
    assert.equal(commands.find((item) => item.name === name)?.access, "read");
  }
}));

test("invalid input fails before creation and input files match stdin", () => isolated((home) => {
  for (const input of ["{", { ...program, actor: "" }, { ...program, unexpected: true }]) {
    const rejected = run(home, "program add", input, [], 1);
    assert.equal(object(array(rejected.envelope.errors)[0]).code, "E_INPUT_SCHEMA");
    assert.equal(existsSync(join(home, "compliance", "compliance.sqlite")), false);
  }
  const file = join(home, "program.json");
  writeFileSync(file, JSON.stringify(program));
  run(home, "program add", "", ["--in", file]);
  const otherHome = join(home, "stdin");
  run(otherHome, "program add", program);
  assert.equal(run(home, "export", { programId: program.id }).stdout, run(otherHome, "export", { programId: program.id }).stdout);
  const nonexistent = run(home, "status", { programId: "absent" }, [], 1);
  assert.equal(object(array(nonexistent.envelope.errors)[0]).code, "E_NOT_FOUND");
}));

test("ill-formed text is rejected before creation and cannot change existing history", () => isolated((home) => {
  setup(home);
  run(home, "doc record", document);
  const before = run(home, "export", { programId: program.id }).stdout;
  const database = join(home, "compliance", "compliance.sqlite");
  const stored = readFileSync(database);
  const fresh = join(home, "fresh");
  for (const text of ["lone \ud800 surrogate", "lone \udc00 surrogate"]) {
    const writes = [
      ...["actor", "reason", "name"].map((field) => ({ command: "program add", input: { ...program, id: "new-program", [field]: text } })),
      { command: "doc record", input: { ...document, page: { ...page, pageId: text } } },
    ];
    for (const { command, input } of writes) {
      for (const target of [fresh, home]) {
        const rejected = run(target, command, input, [], 1);
        assert.equal(object(array(rejected.envelope.errors)[0]).code, "E_INPUT_SCHEMA");
      }
      assert.equal(existsSync(join(fresh, "compliance")), false);
      assert.deepEqual(readFileSync(database), stored);
      assert.equal(run(home, "export", { programId: program.id }).stdout, before);
      assert.equal(run(home, "verify-chain").data.ok, true);
    }
  }
  assert.equal(run(home, "evidence add", evidence).data.historySeq, 4);
  assert.equal(run(home, "verify-chain").data.ok, true);
}));

test("valid Unicode text round-trips through history, projections and rebuild", () => isolated((home) => {
  const text = "Review \ud83d\udcdd Ελληνικά 中文 \ufffd";
  const metadata = { actor: text, reason: text };
  const unicodePage = { pageId: text, version: 1, sha256: page.sha256 };
  run(home, "program add", { ...program, name: text, framework: text, ...metadata });
  run(home, "control add", { ...control, ref: text, title: text, owner: text, ...metadata });
  run(home, "evidence add", { ...evidence, kind: text, summary: text, page: unicodePage, ...metadata });
  run(home, "attest", { id: "attestation-a", controlId: control.id, by: text, statement: text, at: now, expiresAt: "2026-03-01T00:00:00Z", ...metadata });
  run(home, "doc record", { ...document, title: text, page: unicodePage, ...metadata });
  const before = run(home, "export", { programId: program.id });
  const history = array(before.data.history).map(object);
  const records = [
    { table: "programs", fields: ["name", "framework"] },
    { table: "controls", fields: ["ref", "title", "owner"] },
    { table: "evidence", fields: ["kind", "summary"] },
    { table: "attestations", fields: ["by", "statement"] },
    { table: "documents", fields: ["title"] },
  ];
  for (const [index, { table, fields }] of records.entries()) {
    const row = object(array(before.data[table])[0]);
    const entry = object(history[index]);
    assert.deepEqual(row, entry.body);
    assert.equal(entry.actor, text);
    assert.equal(entry.reason, text);
    for (const field of fields) assert.equal(row[field], text);
    if (table === "evidence" || table === "documents") assert.equal(object(row.page).pageId, text);
  }
  assert.equal(run(home, "verify-chain").data.ok, true);
  assert.equal(run(join(home, "independent"), "verify-chain", before.stdout).data.ok, true);
  run(home, "rebuild");
  assert.equal(run(home, "export", { programId: program.id }).stdout, before.stdout);
}));

const controls = (data: Readonly<Record<string, unknown>>) => array(data.controls).map(object);
const firstError = (envelope: Readonly<Record<string, unknown>>) => object(array(envelope.errors)[0]);
const query = { programId: program.id };
const longEvidence = { ...evidence, expiresAt: "2026-12-01T00:00:00Z" };

test("evidence weight: draft and decision are documented only, official is the only evidence that supports a control", () => isolated((home) => {
  setup(home);
  for (const weight of ["draft", "decision"]) {
    const id = `${weight}-a`;
    run(home, "evidence add", { ...longEvidence, id, weight, kind: "official" });
    const documented = { kind: "documented_not_official", evidenceId: id, weight, expiresAt: "2026-12-01T00:00:00.000Z" };
    for (const input of [query, { ...query, withinDays: 0 }, { ...query, withinDays: 400 }]) {
      const status = object(controls(run(home, "status", input).data)[0]?.status);
      assert.equal(status.color, "red");
      assert.ok(array(status.reasons).some((reason) => JSON.stringify(reason) === JSON.stringify(documented)));
      assert.ok(array(status.reasons).every((reason) => object(reason).kind === "documented_not_official"));
    }
    const gaps = controls(run(home, "gaps", query).data);
    assert.equal(gaps.length, 1);
    assert.ok(array(gaps[0]?.reasons).some((reason) => JSON.stringify(reason) === JSON.stringify(documented)));
    assert.deepEqual(run(home, "expiring", { ...query, withinDays: 400 }).data.items, []);
    for (const [now, kind] of [["2027-01-01T00:00:00Z", "documented_expired"], ["2025-01-01T00:00:00Z", "documented_future_dated"]] as const) {
      for (const command of ["status", "gaps"]) {
        const row = controls(run(home, command, query, ["--now", now]).data)[0];
        const reasons = array(command === "status" ? object(row?.status).reasons : row?.reasons).map(object);
        if (command === "status") assert.equal(object(row?.status).color, "red");
        assert.ok(reasons.some((reason) => reason.evidenceId === id && reason.weight === weight));
        assert.ok(reasons.every((reason) => reason.kind === kind));
      }
    }
  }
  run(home, "evidence add", { ...longEvidence, id: "implicit-a", kind: "draft" });
  assert.deepEqual(controls(run(home, "status", query).data)[0]?.status, {
    color: "green", reasons: [{ kind: "current", support: { kind: "evidence", evidenceId: "implicit-a", expiresAt: "2026-12-01T00:00:00.000Z" } }],
  });
  assert.deepEqual(run(home, "gaps", query).data.controls, []);
  assert.deepEqual(array(run(home, "expiring", { ...query, withinDays: 400 }).data.items).map((item) => object(item).id), ["implicit-a"]);
  const exported = run(home, "export", query);
  assert.deepEqual(array(exported.data.evidence).map((item) => [object(item).id, object(item).kind, object(item).weight]), [["decision-a", "official", "decision"], ["draft-a", "official", "draft"], ["implicit-a", "draft", "official"]]);
  assert.deepEqual(array(exported.data.history).slice(2).map((entry) => object(object(entry).body).weight), ["draft", "decision", "official"]);
  assert.equal(run(join(home, "independent"), "verify-chain", exported.stdout).data.ok, true);
  run(home, "rebuild");
  assert.equal(run(home, "export", query).stdout, exported.stdout);
  const before = readFileSync(join(home, "compliance", "compliance.sqlite"));
  for (const weight of ["final", "Draft", "", 1, null, ["draft"]]) {
    const rejected = run(home, "evidence add", { ...longEvidence, id: "rejected-a", weight }, [], 1);
    assert.equal(firstError(rejected.envelope).code, "E_INPUT_SCHEMA");
    assert.match(String(firstError(rejected.envelope).hint), /official, draft, decision/);
  }
  assert.deepEqual(readFileSync(join(home, "compliance", "compliance.sqlite")), before);
}));

test("mixed weights: a draft that expires soon never turns a control with longer official evidence yellow", () => isolated((home) => {
  setup(home);
  run(home, "evidence add", { ...evidence, id: "draft-soon", weight: "draft" });
  run(home, "evidence add", { ...longEvidence, id: "official-long", weight: "official" });
  const status = run(home, "status", query).data;
  assert.equal(status.withinDays, 30);
  assert.deepEqual(controls(status)[0]?.status, {
    color: "green", reasons: [{ kind: "current", support: { kind: "evidence", evidenceId: "official-long", expiresAt: "2026-12-01T00:00:00.000Z" } }],
  });
  assert.deepEqual(run(home, "expiring", query).data.items, []);
  assert.deepEqual(run(home, "gaps", query).data.controls, []);
}));

test("expires-soon window: status and expiring default to 30 days, accept withinDays and report the window they used", () => isolated((home) => {
  setup(home);
  run(home, "evidence add", { ...evidence, weight: "official", collectedAt: "2026-11-01T00:00:00Z", expiresAt: "2027-02-15T08:00:00.000Z" });
  const at = ["--now", "2026-11-22T02:50:00.000Z"];
  const support = { kind: "evidence", evidenceId: evidence.id, expiresAt: "2027-02-15T08:00:00.000Z" };
  const byDefault = run(home, "status", query, at);
  assert.equal(object(byDefault.envelope.meta).now, "2026-11-22T02:50:00.000Z");
  assert.equal(byDefault.data.withinDays, 30);
  assert.deepEqual(controls(byDefault.data)[0]?.status, { color: "green", reasons: [{ kind: "current", support }] });
  assert.equal(run(home, "status", { ...query, withinDays: 30 }, at).stdout, byDefault.stdout);
  assert.equal(statusColor(run(home, "status", { ...query, withinDays: 85 }, at).data), "green");
  for (const input of [{ ...query, withinDays: 90 }, { program_id: program.id, within_days: 90 }]) {
    const widened = run(home, "status", input, at).data;
    assert.equal(widened.withinDays, 90);
    assert.deepEqual(controls(widened)[0]?.status, { color: "yellow", reasons: [{ kind: "expiring", support, withinDays: 90 }] });
  }
  const expiring = run(home, "expiring", query, at).data;
  assert.equal(expiring.withinDays, 30);
  assert.deepEqual(expiring.items, []);
  assert.equal(array(run(home, "expiring", { ...query, withinDays: 90 }, at).data.items).length, 1);
  const soon = run(home, "status", query, ["--now", "2027-01-20T00:00:00Z"]).data;
  assert.deepEqual(controls(soon)[0]?.status, { color: "yellow", reasons: [{ kind: "expiring", support, withinDays: 30 }] });
  assert.equal(array(run(home, "expiring", query, ["--now", "2027-01-20T00:00:00Z"]).data.items).length, 1);
  for (const command of ["status", "expiring"]) {
    for (const withinDays of [-1, 1.5, "30", null, true, 1e300]) {
      const rejected = run(home, command, { ...query, withinDays }, at, 1);
      assert.equal(firstError(rejected.envelope).code, "E_INPUT_SCHEMA", `${command} ${String(withinDays)}`);
      assert.match(String(firstError(rejected.envelope).hint), /non-negative safe integer number of days, or omit it to use 30/);
    }
    assert.equal(firstError(run(home, command, { ...query, withinDays: 30, within_days: 31 }, at, 1).envelope).code, "E_INPUT_SCHEMA");
  }
  assert.equal(firstError(run(home, "gaps", { ...query, withinDays: 30 }, at, 1).envelope).code, "E_INPUT_SCHEMA");
}));

test("actor rule: internal spaces are stored unchanged; padding, control characters and more than 200 characters are rejected with the rule", () => isolated((home) => {
  const rule = "Provide 1 to 200 Unicode characters with no control characters (including newlines) and no leading or trailing whitespace; spaces inside the value are allowed for actor.";
  const rejected = [" operator", "operator ", "\toperator", "operator\n", "first\nsecond", "nul\u0000", "delete\u007f", "   ", "", "x".repeat(201)];
  for (const actor of rejected) {
    const result = run(home, "program add", { ...program, actor }, [], 1);
    assert.equal(firstError(result.envelope).code, "E_INPUT_SCHEMA", JSON.stringify(actor));
    assert.equal(firstError(result.envelope).message, "The actor field is not valid.");
    assert.equal(firstError(result.envelope).hint, rule);
    assert.equal(existsSync(join(home, "compliance")), false);
  }
  run(home, "program add", { ...program, actor: "Office Manager" });
  run(home, "control add", { ...control, actor: "x".repeat(200) });
  const writes = [
    { command: "evidence add", input: { ...evidence, actor: "operator " } },
    { command: "attest", input: { id: "attestation-a", controlId: control.id, by: "reviewer", statement: "Review confirmed", at: now, expiresAt: "2026-03-01T00:00:00Z", reason: "Routine review", actor: "line\nbreak" } },
    { command: "doc record", input: { ...document, actor: " operator" } },
  ];
  for (const { command, input } of writes) assert.equal(firstError(run(home, command, input, [], 1).envelope).hint, rule);
  const history = array(run(home, "export", query).data.history).map(object);
  assert.deepEqual(history.map((entry) => entry.actor), ["Office Manager", "x".repeat(200)]);
  assert.equal(run(home, "verify-chain").data.ok, true);
}));

test("no claim: documentation, skills, source and command output describe the register and never state that requirements are satisfied", () => isolated((home) => {
  const claims = [
    /\bcompliant\b/i, /\bnon-?compliant\b/i, /\bin (?:full )?compliance\b/i, /\bout of compliance\b/i, /\bcompliance (?:is|was|has been) (?:met|achieved|reached|confirmed)\b/i,
    /\b(?:is|are|stays?|remains?|becomes?) certified\b/i, /\baudit[- ]ready\b/i, /\bpass(?:es|ed)? (?:an? |the )?audit\b/i,
    /\b(?:meets?|satisf(?:y|ies)|fulfils?|fulfills?) (?:the |its |all |every |any |a )?(?:\w+ )?(?:requirements?|obligations?|regulations?|standards?|frameworks?)\b/i,
    /\bgreen means\b[^.]*\b(?:met|satisfied|passed)\b/i,
  ];
  const assertNoClaim = (text: string, where: string) => {
    for (const claim of claims) assert.doesNotMatch(text, claim, where);
  };
  for (const sample of ["The business is compliant.", "You are in compliance.", "This control meets the requirement.", "Green means the control is met."]) {
    assert.ok(claims.some((claim) => claim.test(sample)), sample);
  }
  const root = new URL("../", import.meta.url);
  const sources = globSync(["README.md", "**/SKILL.md", "skills/**/*", "src/**/*.ts", "migrations/*.sql", "verify/features.json"], { cwd: root, exclude: (name) => name === "node_modules" });
  assert.ok(sources.includes("README.md") && sources.some((path) => path.endsWith("SKILL.md")));
  for (const path of sources) assertNoClaim(readFileSync(new URL(path, root), "utf8"), path);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  assert.match(readme, /not an opinion/);

  setup(home);
  const outputs = [run(home, "status", query).stdout, run(home, "gaps", query).stdout];
  run(home, "evidence add", { ...longEvidence, id: "draft-a", weight: "draft" });
  run(home, "evidence add", { ...longEvidence, id: "decision-a", weight: "decision" });
  outputs.push(run(home, "status", query).stdout, run(home, "gaps", query).stdout);
  run(home, "evidence add", evidence);
  run(home, "attest", { id: "attestation-a", controlId: control.id, by: "reviewer", statement: "Review confirmed", at: now, expiresAt: "2026-12-01T00:00:00Z", ...provenance });
  for (const input of [query, { ...query, withinDays: 400 }]) outputs.push(run(home, "status", input).stdout, run(home, "expiring", input).stdout);
  outputs.push(run(home, "gaps", query).stdout, run(home, "commands").stdout, run(home, "selfcheck").stdout);
  outputs.push(run(home, "program add", { ...program, id: "other", actor: " padded" }, [], 1).stdout, run(home, "status", { ...query, withinDays: -1 }, [], 1).stdout);
  for (const [index, output] of outputs.entries()) assertNoClaim(output, `output ${index}: ${output}`);
}));
