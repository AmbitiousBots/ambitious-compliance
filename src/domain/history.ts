import { failure } from "@ambitious/kit/domain/failure";
import { isRecord, type JsonValue } from "@ambitious/kit/domain/json";
import { parseAttestation, parseControl, parseDocument, parseEvidence, parseInstant, parseProgram } from "./parse.ts";
import {
  EMPTY_CHAIN_HEAD, GENESIS_PREV_HASH, isActor, isAttestationId, isControlId, isDocumentId,
  isEvidenceId, isHistorySeq, isProgramId, isSha256Hex,
  type ChainHead, type HistoryChange, type HistoryEntry, type HistorySeq,
} from "./types.ts";

const invalid = () => failure("E_INPUT_SCHEMA", "A history entry is not valid.", "Supply an unchanged export from this module.");

export const canonical = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) throw invalid();
  return `{${Object.keys(value).sort().map((key) => {
    const item = value[key];
    if (item === undefined) throw invalid();
    return `${JSON.stringify(key)}:${canonical(item)}`;
  }).join(",")}}`;
};

export const sequence = (raw: number): HistorySeq => {
  if (!isHistorySeq(raw)) throw invalid();
  return raw;
};

const parseChange = (raw: Readonly<Record<string, unknown>>): HistoryChange => {
  const { entity, entityId, op, body } = raw;
  if (typeof entityId !== "string") throw invalid();
  if (op === "retire") {
    if (!isRecord(body) || Object.keys(body).length !== 0) throw invalid();
    switch (entity) {
      case "program": if (isProgramId(entityId)) return { entity, entityId, op, body: {} }; break;
      case "control": if (isControlId(entityId)) return { entity, entityId, op, body: {} }; break;
      case "evidence": if (isEvidenceId(entityId)) return { entity, entityId, op, body: {} }; break;
      case "attestation": if (isAttestationId(entityId)) return { entity, entityId, op, body: {} }; break;
      case "document": if (isDocumentId(entityId)) return { entity, entityId, op, body: {} }; break;
    }
    throw invalid();
  }
  if (op !== "create" && op !== "update") throw invalid();
  switch (entity) {
    case "program": { const parsed = parseProgram(body); if (parsed.id !== entityId) throw invalid(); return { entity, entityId: parsed.id, op, body: parsed }; }
    case "control": { const parsed = parseControl(body); if (parsed.id !== entityId) throw invalid(); return { entity, entityId: parsed.id, op, body: parsed }; }
    case "evidence": { const parsed = parseEvidence(body); if (parsed.id !== entityId) throw invalid(); return { entity, entityId: parsed.id, op, body: parsed }; }
    case "attestation": { const parsed = parseAttestation(body); if (parsed.id !== entityId) throw invalid(); return { entity, entityId: parsed.id, op, body: parsed }; }
    case "document": { const parsed = parseDocument(body); if (parsed.id !== entityId) throw invalid(); return { entity, entityId: parsed.id, op, body: parsed }; }
    default: throw invalid();
  }
};

const jsonValue = (raw: unknown): JsonValue => {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw)) return raw.map(jsonValue);
  if (!isRecord(raw)) throw invalid();
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, jsonValue(value)]));
};

export const parseHistoryEntry = (raw: unknown): HistoryEntry => {
  if (!isRecord(raw)) throw invalid();
  const { seq, at, actor, reason, prevHash, hash } = raw;
  if (Object.keys(raw).sort().join(",") !== "actor,at,body,entity,entityId,hash,op,prevHash,reason,seq") throw invalid();
  if (typeof seq !== "number" || !isHistorySeq(seq) || typeof actor !== "string" || !isActor(actor)) throw invalid();
  if (typeof reason !== "string" || !reason.isWellFormed() || reason.trim() === "") throw invalid();
  if (typeof prevHash !== "string" || !isSha256Hex(prevHash) || typeof hash !== "string" || !isSha256Hex(hash)) throw invalid();
  const instant = parseInstant(at);
  if (instant !== at) throw invalid();
  const change = parseChange(raw);
  if (canonical(jsonValue(raw.body)) !== canonical(change.body)) throw invalid();
  return { ...change, seq, at: instant, actor, reason, prevHash, hash };
};

export const parseChainHead = (raw: unknown): ChainHead => {
  if (!isRecord(raw)) throw invalid();
  if (raw.kind === "empty" && raw.hash === GENESIS_PREV_HASH && Object.keys(raw).sort().join(",") === "hash,kind") return EMPTY_CHAIN_HEAD;
  if (raw.kind === "entry" && typeof raw.seq === "number" && isHistorySeq(raw.seq) && typeof raw.hash === "string" && isSha256Hex(raw.hash) && Object.keys(raw).sort().join(",") === "hash,kind,seq") {
    return { kind: "entry", seq: raw.seq, hash: raw.hash };
  }
  throw invalid();
};
