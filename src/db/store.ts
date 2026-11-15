import type { Db } from "@ambitious/kit/db/open-db";
import { failure } from "@ambitious/kit/domain/failure";
import { canonical, parseHistoryEntry, sequence } from "../domain/history.ts";
import { parseAttestation, parseControl, parseDocument, parseEvidence, parseProgram, type WriteInput } from "../domain/parse.ts";
import { replay } from "../domain/replay.ts";
import type {
  ChainVerification, HistoryChange, HistoryEntry, HistoryEntryContent, Instant,
  ProgramId, Projection, WriteReceipt,
} from "../domain/types.ts";
import { hashContent, verifyChain } from "./history.ts";

const TABLES = {
  program: "programs", control: "controls", evidence: "evidence", attestation: "attestations", document: "documents",
} as const;

const inSnapshot = <Value>(db: Db, read: () => Value): Value => {
  if (db.isTransaction) return read();
  db.exec("BEGIN");
  try {
    const value = read();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
};

const requireTransaction = (db: Db): void => {
  if (!db.isTransaction) throw new Error("History writes require the command's immediate transaction.");
};

const parseBody = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
};

export const loadHistory = (db: Db): readonly unknown[] => db.prepare("SELECT * FROM history ORDER BY seq").all().map((row) => ({
  seq: row.seq, at: row.at, actor: row.actor, reason: row.reason, entity: row.entity,
  entityId: row.entity_id, op: row.op, body: parseBody(row.body), prevHash: row.prev_hash, hash: row.hash,
}));

export const verifyDbChain = (db: Db, expectedHead?: unknown): ChainVerification => verifyChain(loadHistory(db), expectedHead);

const validatedHistory = (db: Db): readonly HistoryEntry[] => {
  const history = loadHistory(db);
  const verified = verifyChain(history);
  if (!verified.ok) throw failure("E_CHAIN", `History does not verify at entry ${verified.firstBadSeq}.`, "Keep the database unchanged and compare it with a saved export or backup.", { firstBadSeq: verified.firstBadSeq });
  return history.map(parseHistoryEntry);
};

export const loadProjection = (db: Db): Projection => inSnapshot(db, () => {
  const programs = db.prepare("SELECT * FROM programs ORDER BY id").all().map(parseProgram);
  const controls = db.prepare("SELECT * FROM controls ORDER BY id").all().map(parseControl);
  const evidence = db.prepare("SELECT * FROM evidence ORDER BY id").all().map(parseEvidence);
  const attestations = db.prepare("SELECT * FROM attestations ORDER BY id").all().map(parseAttestation);
  const documents = db.prepare("SELECT * FROM documents ORDER BY id").all().map(parseDocument);
  return {
    programs: new Map(programs.map((value) => [value.id, value])),
    controls: new Map(controls.map((value) => [value.id, value])),
    evidence: new Map(evidence.map((value) => [value.id, value])),
    attestations: new Map(attestations.map((value) => [value.id, value])),
    documents: new Map(documents.map((value) => [value.id, value])),
  };
});

const project = (db: Db, change: HistoryChange): void => {
  if (change.op === "retire") {
    db.prepare(`DELETE FROM ${TABLES[change.entity]} WHERE id = ?`).run(change.entityId);
    return;
  }
  switch (change.entity) {
    case "program": {
      const value = change.body;
      db.prepare("INSERT INTO programs (id, name, framework) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, framework=excluded.framework").run(value.id, value.name, value.framework);
      break;
    }
    case "control": {
      const value = change.body;
      db.prepare("INSERT INTO controls (id, program_id, ref, title, owner, cadence_days) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET program_id=excluded.program_id, ref=excluded.ref, title=excluded.title, owner=excluded.owner, cadence_days=excluded.cadence_days").run(value.id, value.programId, value.ref, value.title, value.owner, value.cadenceDays);
      break;
    }
    case "evidence": {
      const value = change.body;
      db.prepare("INSERT INTO evidence (id, control_id, kind, summary, page_id, page_version, page_sha256, collected_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET control_id=excluded.control_id, kind=excluded.kind, summary=excluded.summary, page_id=excluded.page_id, page_version=excluded.page_version, page_sha256=excluded.page_sha256, collected_at=excluded.collected_at, expires_at=excluded.expires_at").run(value.id, value.controlId, value.kind, value.summary, value.page?.pageId ?? null, value.page?.pageVersion ?? null, value.page?.pageSha256 ?? null, value.collectedAt, value.expiresAt);
      break;
    }
    case "attestation": {
      const value = change.body;
      db.prepare('INSERT INTO attestations (id, control_id, "by", statement, at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET control_id=excluded.control_id, "by"=excluded."by", statement=excluded.statement, at=excluded.at, expires_at=excluded.expires_at').run(value.id, value.controlId, value.by, value.statement, value.at, value.expiresAt);
      break;
    }
    case "document": {
      const value = change.body;
      db.prepare("INSERT INTO documents (id, program_id, title, page_id, page_version, page_sha256) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET program_id=excluded.program_id, title=excluded.title, page_id=excluded.page_id, page_version=excluded.page_version, page_sha256=excluded.page_sha256").run(value.id, value.programId, value.title, value.page.pageId, value.page.pageVersion, value.page.pageSha256);
      break;
    }
  }
};

const writeChange = (input: WriteInput, op: "create" | "update"): HistoryChange => {
  switch (input.entity) {
    case "program": return { entity: input.entity, entityId: input.body.id, op, body: input.body };
    case "control": return { entity: input.entity, entityId: input.body.id, op, body: input.body };
    case "evidence": return { entity: input.entity, entityId: input.body.id, op, body: input.body };
    case "attestation": return { entity: input.entity, entityId: input.body.id, op, body: input.body };
    case "document": return { entity: input.entity, entityId: input.body.id, op, body: input.body };
  }
};

export const append = (db: Db, input: WriteInput, now: Instant): WriteReceipt => {
  requireTransaction(db);
  const verified = verifyDbChain(db);
  if (!verified.ok) throw failure("E_CHAIN", `History does not verify at entry ${verified.firstBadSeq}.`, "Keep the database unchanged and compare it with a saved export or backup.", { firstBadSeq: verified.firstBadSeq });
  const exists = db.prepare(`SELECT id FROM ${TABLES[input.entity]} WHERE id = ?`).get(input.body.id) !== undefined;
  if (exists && input.entity !== "document") throw failure("E_EXISTS", "An entity with this identifier is already recorded.", "Use a new identifier for the new record.");
  const parent = input.entity === "program" ? null
    : input.entity === "control" || input.entity === "document" ? { table: "programs", id: input.body.programId, kind: "program" }
      : { table: "controls", id: input.body.controlId, kind: "control" };
  if (parent !== null && db.prepare(`SELECT id FROM ${parent.table} WHERE id = ?`).get(parent.id) === undefined) {
    throw failure("E_NOT_FOUND", `The parent ${parent.kind} was not found.`, `Add the ${parent.kind} first or use an existing ${parent.kind} identifier.`);
  }
  const change = writeChange(input, exists ? "update" : "create");
  const content: HistoryEntryContent = {
    ...change, seq: sequence(verified.head.kind === "empty" ? 1 : verified.head.seq + 1),
    at: now, actor: input.actor, reason: input.reason,
  };
  const hash = hashContent(content, verified.head.hash);
  db.prepare("INSERT INTO history (seq, at, actor, reason, entity, entity_id, op, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(content.seq, content.at, content.actor, content.reason, content.entity, content.entityId, content.op, canonical(content.body), verified.head.hash, hash);
  project(db, change);
  return { entity: input.entity, historySeq: content.seq, hash };
};

export const exportProgram = (db: Db, programId: ProgramId) => inSnapshot(db, () => {
  const projection = loadProjection(db);
  if (!projection.programs.has(programId)) throw failure("E_NOT_FOUND", "The program was not found.", "Use an existing program identifier or add the program first.");
  const history = validatedHistory(db);
  const verified = verifyChain(history);
  if (!verified.ok) throw new Error("A validated history failed verification.");
  const controls = [...projection.controls.values()].filter((value) => value.programId === programId);
  const ids = new Set(controls.map((value) => value.id));
  return {
    programId,
    programs: [...projection.programs.values()].filter((value) => value.id === programId),
    controls,
    evidence: [...projection.evidence.values()].filter((value) => ids.has(value.controlId)),
    attestations: [...projection.attestations.values()].filter((value) => ids.has(value.controlId)),
    documents: [...projection.documents.values()].filter((value) => value.programId === programId),
    history,
    chainHead: verified.head,
  };
});

export const rebuild = (db: Db) => {
  requireTransaction(db);
  const history = validatedHistory(db);
  const projection = replay(history);
  db.exec("DELETE FROM documents; DELETE FROM attestations; DELETE FROM evidence; DELETE FROM controls; DELETE FROM programs;");
  for (const value of projection.programs.values()) project(db, { entity: "program", entityId: value.id, op: "create", body: value });
  for (const value of projection.controls.values()) project(db, { entity: "control", entityId: value.id, op: "create", body: value });
  for (const value of projection.evidence.values()) project(db, { entity: "evidence", entityId: value.id, op: "create", body: value });
  for (const value of projection.attestations.values()) project(db, { entity: "attestation", entityId: value.id, op: "create", body: value });
  for (const value of projection.documents.values()) project(db, { entity: "document", entityId: value.id, op: "create", body: value });
  return { history: history.length, programs: projection.programs.size, controls: projection.controls.size, evidence: projection.evidence.size, attestations: projection.attestations.size, documents: projection.documents.size };
};
