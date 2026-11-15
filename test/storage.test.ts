import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrate } from "@ambitious/kit/db/migrate";
import { loadMigrations } from "@ambitious/kit/db/load-migrations";
import { openDb, type Db } from "@ambitious/kit/db/open-db";
import fc from "fast-check";
import { parseHistoryEntry } from "../src/domain/history.ts";
import { parseInstant, parseProgramQuery, parseWrite, type WriteInput } from "../src/domain/parse.ts";
import { replay } from "../src/domain/replay.ts";
import { verifyChain } from "../src/db/history.ts";
import { append, exportProgram, loadHistory, loadProjection, rebuild, verifyDbChain } from "../src/db/store.ts";

const migrations = loadMigrations(join(import.meta.dirname, "../migrations"));
const now = parseInstant("2026-01-01T00:00:00Z");
const metadata = { actor: "operator", reason: "Record a reviewed item" };
const program = parseWrite({ id: "program", name: "Example program", framework: "custom", ...metadata }, "program");
const control = parseWrite({ id: "control", programId: "program", ref: "C-1", title: "Review records", owner: "reviewer", cadenceDays: 28, ...metadata }, "control");
const evidence = parseWrite({ id: "evidence", controlId: "control", kind: "record", summary: "Reviewed record", collectedAt: now, expiresAt: "2026-02-01T00:00:00Z", ...metadata }, "evidence");
const attestation = parseWrite({ id: "attestation", controlId: "control", by: "reviewer", statement: "Review completed", at: now, expiresAt: "2026-02-01T00:00:00Z", ...metadata }, "attestation");
const document = (version = 1): WriteInput => parseWrite({ id: "document", programId: "program", title: "Review procedure", page: { pageId: "page", pageVersion: version, pageSha256: "a".repeat(64) }, ...metadata }, "document");

const transaction = <Value>(db: Db, work: () => Value): Value => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const withDatabase = async (work: (db: Db, path: string) => void | Promise<void>, knownMigrations = migrations): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), "compliance-storage-"));
  const path = join(directory, "compliance.sqlite");
  const db = openDb(path, { readonly: false });
  try {
    migrate(db, knownMigrations);
    await work(db, path);
  } finally {
    if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const put = (db: Db, input: WriteInput) => transaction(db, () => append(db, input, now));

test("migrations create every projection and preserve records when run again", async () => {
  await withDatabase((db) => {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
    for (const input of [program, control, evidence, attestation, document()]) put(db, input);
    const before = loadProjection(db);
    assert.deepEqual(migrate(db, migrations), []);
    assert.deepEqual(loadProjection(db), before);
    assert.equal(verifyDbChain(db).ok, true);
    assert.equal(loadHistory(db).length, 5);
  });
});

test("the insert-guard migration protects existing history without changing its contents", async () => {
  await withDatabase((db) => {
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    put(db, program);
    const before = loadHistory(db);
    assert.deepEqual(migrate(db, migrations), ["0002_protect_history_inserts"]);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.deepEqual(loadHistory(db), before);
    assert.throws(() => db.exec("REPLACE INTO history SELECT * FROM history WHERE seq = 1"), /History cannot be replaced/);
    assert.deepEqual(loadHistory(db), before);
    put(db, control);
    assert.equal(loadHistory(db).length, 2);
    assert.equal(verifyDbChain(db).ok, true);
  }, migrations.slice(0, 1));
});

test("history triggers reject SQL update and delete without changing receipts", async () => {
  await withDatabase((db) => {
    put(db, program);
    put(db, control);
    const before = loadHistory(db);
    assert.throws(() => db.prepare("UPDATE history SET reason = ? WHERE seq = 1").run("Changed reason"), /History cannot be updated/);
    assert.deepEqual(loadHistory(db), before);
    assert.throws(() => db.exec("DELETE FROM history WHERE seq = 1"), /History cannot be deleted/);
    assert.deepEqual(loadHistory(db), before);
    assert.equal(verifyDbChain(db).ok, true);
  });
});

test("history rejects replacement and upsert collisions even with recursive triggers disabled", async () => {
  await withDatabase((db) => {
    for (const input of [program, control, document(), document(2)]) put(db, input);
    db.exec("PRAGMA recursive_triggers = OFF");
    assert.equal(db.prepare("PRAGMA recursive_triggers").get()?.recursive_triggers, 0);
    const before = loadHistory(db);
    const projection = loadProjection(db);
    for (const prefix of ["INSERT OR REPLACE", "REPLACE"]) {
      for (const [seq, hash] of [["seq", "'" + "f".repeat(64) + "'"], ["seq + 100", "hash"], ["seq", "hash"]]) {
        assert.throws(() => db.exec(`${prefix} INTO history SELECT ${seq}, at, actor, 'Changed reason', entity, entity_id, op, body, prev_hash, ${hash} FROM history WHERE seq = 1`), /History cannot be replaced/);
        assert.deepEqual(loadHistory(db), before);
      }
    }
    for (const conflict of ["seq", "hash"]) {
      assert.throws(() => db.exec(`INSERT INTO history SELECT * FROM history WHERE seq = 1 ON CONFLICT(${conflict}) DO UPDATE SET reason = 'Changed reason'`), /History cannot be replaced/);
      assert.deepEqual(loadHistory(db), before);
    }
    assert.deepEqual(loadProjection(db), projection);
    assert.equal(verifyDbChain(db).ok, true);
  });
});

test("runtime writes only insert new history and never use replacement statements", () => {
  const root = new URL("../", import.meta.url);
  for (const path of globSync(["src/**/*.ts", "migrations/*.sql"], { cwd: root })) {
    const source = readFileSync(new URL(path, root), "utf8");
    assert.doesNotMatch(source, /\b(?:INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b/i, `${path}: use an in-place upsert for projections and only insert new history`);
    assert.doesNotMatch(source, /\b(?:UPDATE\s+history|DELETE\s+FROM\s+history)\b/i, `${path}: history must remain append-only`);
    assert.doesNotMatch(source, /\bINSERT\s+INTO\s+history\b[^"'\n]*ON\s+CONFLICT\b/i, `${path}: history inserts must reject existing rows`);
  }
});

test("a failed projection rolls the history append back in the same transaction", async () => {
  await withDatabase((db) => {
    put(db, program);
    const before = loadHistory(db);
    db.exec("CREATE TRIGGER reject_control BEFORE INSERT ON controls BEGIN SELECT RAISE(ABORT, 'Test projection failure'); END;");
    assert.throws(() => put(db, control), /Test projection failure/);
    assert.deepEqual(loadHistory(db), before);
    assert.equal(loadProjection(db).controls.size, 0);
    assert.equal(verifyDbChain(db).ok, true);
  });
});

test("write APIs require a transaction and duplicate adds do not overwrite records", async () => {
  await withDatabase((db) => {
    assert.throws(() => append(db, program, now), /require.*transaction/);
    put(db, program);
    const before = loadHistory(db);
    assert.throws(() => put(db, program), /E_EXISTS/);
    assert.deepEqual(loadHistory(db), before);
  });
});

test("saving a document twice and revising it preserves each earlier body and hash", async () => {
  await withDatabase((db) => {
    put(db, program);
    db.exec("CREATE TRIGGER documents_reject_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, 'Projection updates must be in place'); END;");
    put(db, document());
    const first = loadHistory(db);
    put(db, document());
    const repeated = loadHistory(db);
    assert.equal(repeated.length, 3);
    assert.deepEqual(repeated.slice(0, 2), first);
    put(db, document(2));
    const revised = loadHistory(db).map(parseHistoryEntry);
    assert.equal(revised.length, 4);
    assert.deepEqual(revised.slice(0, 3), repeated.map(parseHistoryEntry));
    assert.deepEqual(revised.filter((entry) => entry.entity === "document").map((entry) => entry.op === "retire" ? null : entry.body.page.pageVersion), [1, 1, 2]);
    assert.deepEqual(revised.map((entry) => entry.op), ["create", "create", "update", "update"]);
    assert.equal(new Set(revised.map((entry) => entry.hash)).size, 4);
    assert.equal(verifyDbChain(db).ok, true);
    assert.deepEqual(loadProjection(db), replay(revised));
  });
});

test("a document revision appends history and rebuild restores all projections without touching history", async () => {
  await withDatabase((db) => {
    for (const input of [program, control, evidence, attestation, document(), document(2)]) put(db, input);
    const before = loadProjection(db);
    const history = loadHistory(db);
    assert.deepEqual(before, replay(history.map(parseHistoryEntry)));
    db.prepare("UPDATE controls SET title = ? WHERE id = ?").run("Changed projection", "control");
    db.exec("DELETE FROM documents; DELETE FROM attestations; DELETE FROM evidence;");
    assert.notDeepEqual(loadProjection(db), before);
    assert.deepEqual(transaction(db, () => rebuild(db)), { history: 6, programs: 1, controls: 1, evidence: 1, attestations: 1, documents: 1 });
    assert.deepEqual(loadProjection(db), before);
    assert.deepEqual(loadHistory(db), history);
    assert.deepEqual(transaction(db, () => rebuild(db)), { history: 6, programs: 1, controls: 1, evidence: 1, attestations: 1, documents: 1 });
  });
});

test("generated revision histories replay to the same current rows", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 20 }), async (versions) => {
    await withDatabase((db) => {
      put(db, program);
      for (const version of versions) put(db, document(version));
      const before = loadProjection(db);
      assert.deepEqual(before, replay(loadHistory(db).map(parseHistoryEntry)));
      transaction(db, () => rebuild(db));
      assert.deepEqual(loadProjection(db), before);
      assert.equal(verifyDbChain(db).ok, true);
    });
  }), { numRuns: 100, seed: 43127 });
});

test("program exports keep a complete verifiable chain across programs and detect a missing tail against its saved head", async () => {
  await withDatabase((db) => {
    put(db, program);
    put(db, parseWrite({ id: "other", name: "Another program", framework: "custom", ...metadata }, "program"));
    put(db, control);
    const exported = exportProgram(db, parseProgramQuery({ programId: "program" }).programId);
    assert.equal(exported.programs.length, 1);
    assert.equal(exported.history.length, 3);
    assert.deepEqual(verifyChain(exported.history, exported.chainHead), { ok: true, head: exported.chainHead });
    assert.deepEqual(verifyChain(exported.history.slice(0, -1), exported.chainHead), { ok: false, firstBadSeq: 3 });
  });
});

test("read-only snapshots and exports never permit a write", async () => {
  await withDatabase((db, path) => {
    put(db, program);
    const reader = openDb(path, { readonly: true });
    try {
      assert.deepEqual(loadProjection(reader), loadProjection(db));
      assert.equal(exportProgram(reader, parseProgramQuery({ programId: "program" }).programId).history.length, 1);
      assert.throws(() => reader.exec("DELETE FROM programs"), /readonly/);
    } finally {
      reader.close();
    }
  });
});

test("an equal-length raw-file edit reports its first bad sequence and rebuild leaves projections intact", async () => {
  await withDatabase((db, path) => {
    put(db, program);
    put(db, parseWrite({ id: "control", programId: "program", ref: "C-1", title: "Review records", owner: "reviewer", cadenceDays: 28, actor: "operator", reason: "unique-original-reason" }, "control"));
    const before = loadProjection(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const bytes = readFileSync(path);
    const needle = Buffer.from("unique-original-reason");
    const index = bytes.indexOf(needle);
    assert.ok(index >= 0);
    assert.equal(bytes.indexOf(needle, index + needle.length), -1);
    Buffer.from("unique-modified-reason").copy(bytes, index);
    writeFileSync(path, bytes);
    const altered = openDb(path, { readonly: false });
    try {
      assert.deepEqual(verifyDbChain(altered), { ok: false, firstBadSeq: 2 });
      assert.throws(() => transaction(altered, () => rebuild(altered)), /E_CHAIN/);
      assert.deepEqual(loadProjection(altered), before);
    } finally {
      altered.close();
    }
  });
});

const writer = (path: string, id: number): Promise<void> => new Promise((resolve, reject) => {
  const script = `
    import { openDb } from ${JSON.stringify(import.meta.resolve("@ambitious/kit/db/open-db"))};
    import { append } from ${JSON.stringify(new URL("../src/db/store.ts", import.meta.url).href)};
    import { parseInstant, parseWrite } from ${JSON.stringify(new URL("../src/domain/parse.ts", import.meta.url).href)};
    const db = openDb(process.argv[1], { readonly: false });
    try {
      db.exec("BEGIN IMMEDIATE");
      append(db, parseWrite({ id: "program-" + process.argv[2], name: "Concurrent program", framework: "custom", actor: "writer", reason: "Concurrent write" }, "program"), parseInstant("2026-01-01T00:00:00Z"));
      db.exec("COMMIT");
    } finally { db.close(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, path, String(id)], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}: ${stderr}`)));
});

test("concurrent writers serialize their head reads and commit matching projections", async () => {
  await withDatabase(async (db, path) => {
    await Promise.all(Array.from({ length: 8 }, (_, id) => writer(path, id)));
    assert.equal(verifyDbChain(db).ok, true);
    const history = loadHistory(db).map(parseHistoryEntry);
    assert.deepEqual(history.map(({ seq }) => seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(history.map(({ hash }) => hash)).size, 8);
    assert.equal(loadProjection(db).programs.size, 8);
    assert.deepEqual(loadProjection(db), replay(history));
  });
});
