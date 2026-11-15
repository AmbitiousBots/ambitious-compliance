import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(object(selfcheck.db).userVersion, 2);
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
