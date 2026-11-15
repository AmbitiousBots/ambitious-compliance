import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import {
  isActor,
  isAttestationId,
  isControlId,
  isDays,
  isDocumentId,
  isEvidenceId,
  isInstant,
  isPageId,
  isPageVersion,
  isProgramId,
  isSha256Hex,
  type Actor,
  type Attestation,
  type ComplianceDocument,
  type Control,
  type DocumentId,
  type EntityByKind,
  type EntityKind,
  type Evidence,
  type Instant,
  type PageRef,
  type Program,
  type ProgramId,
  type Sha256Hex,
} from "./types.ts";

type WriteOf<Kind extends EntityKind> = Kind extends EntityKind
  ? { readonly entity: Kind; readonly body: EntityByKind[Kind]; readonly actor: Actor; readonly reason: string }
  : never;

export type WriteInput = WriteOf<EntityKind>;

const invalid = (field: string, expected: string): never => {
  throw failure("E_INPUT_SCHEMA", `The ${field} field is not valid.`, `Provide ${expected} for ${field}.`);
};

const record = (raw: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(raw)) return invalid("input", "one JSON object");
  return raw;
};

const fields = (raw: unknown, names: readonly string[]): Readonly<Record<string, unknown>> => {
  const value = record(raw);
  const allowed = new Set([...names, "actor", "reason"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return invalid("input", "only the documented fields");
  return value;
};

const text = (raw: unknown, field: string): string => {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 65_536) {
    return invalid(field, "non-empty text of at most 65536 characters");
  }
  return raw;
};

const brandedText = <Value extends string>(raw: unknown, field: string, check: (value: string) => value is Value): Value => {
  const value = text(raw, field);
  if (!check(value)) return invalid(field, "a valid identifier or value in the documented format");
  return value;
};

const brandedNumber = <Value extends number>(raw: unknown, field: string, check: (value: number) => value is Value): Value => {
  if (typeof raw !== "number" || !check(raw)) return invalid(field, "a positive safe integer");
  return raw;
};

const alias = (value: Readonly<Record<string, unknown>>, first: string, second: string): unknown => {
  if (value[first] !== undefined && value[second] !== undefined && value[first] !== value[second]) {
    return invalid(first, `one value using either ${first} or ${second}`);
  }
  return value[first] ?? value[second];
};

const INSTANT_INPUT = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export const parseInstant = (raw: unknown, field = "time"): Instant => {
  if (typeof raw !== "string") return invalid(field, "an ISO 8601 timestamp with a time zone");
  const match = INSTANT_INPUT.exec(raw);
  const date = match?.[1];
  if (date === undefined) return invalid(field, "an ISO 8601 timestamp with a time zone");
  const civil = Date.parse(`${date}T00:00:00.000Z`);
  const epoch = Date.parse(raw);
  if (!Number.isFinite(civil) || !Number.isFinite(epoch) || new Date(civil).toISOString().slice(0, 10) !== date) {
    return invalid(field, "a real calendar date and time");
  }
  const normalized = new Date(epoch).toISOString();
  if (!isInstant(normalized)) return invalid(field, "a timestamp whose UTC year has four digits");
  return normalized;
};

const expiration = (raw: unknown, start: Instant): Instant => {
  const expires = parseInstant(raw, "expiresAt");
  if (expires <= start) return invalid("expiresAt", "a time after the collection or attestation time");
  return expires;
};

const parsePage = (raw: unknown): PageRef => {
  const value = fields(raw, ["pageId", "pageVersion", "pageSha256", "version", "sha256"]);
  return {
    pageId: brandedText(value.pageId, "pageId", isPageId),
    pageVersion: brandedNumber(alias(value, "pageVersion", "version"), "pageVersion", isPageVersion),
    pageSha256: brandedText(alias(value, "pageSha256", "sha256"), "pageSha256", isSha256Hex),
  };
};

const pageValue = (value: Readonly<Record<string, unknown>>): PageRef | null => {
  const flatPresent = ["page_id", "page_version", "page_sha256"].some((field) => value[field] !== undefined && value[field] !== null);
  if (value.page !== undefined && value.page !== null) {
    if (flatPresent) return invalid("page", "either a page object or flat Page fields, but not both");
    return parsePage(value.page);
  }
  if (!flatPresent) return null;
  return parsePage({ pageId: value.page_id, pageVersion: value.page_version, pageSha256: value.page_sha256 });
};

const PAGE_FIELDS = ["page", "page_id", "page_version", "page_sha256"] as const;

export const parseProgram = (raw: unknown): Program => {
  const value = fields(raw, ["id", "name", "framework"]);
  return {
    id: brandedText(value.id, "id", isProgramId),
    name: text(value.name, "name"),
    framework: text(value.framework, "framework"),
  };
};

export const parseControl = (raw: unknown): Control => {
  const value = fields(raw, ["id", "programId", "program_id", "ref", "title", "owner", "cadenceDays", "cadence_days"]);
  return {
    id: brandedText(value.id, "id", isControlId),
    programId: brandedText(alias(value, "programId", "program_id"), "programId", isProgramId),
    ref: text(value.ref, "ref"),
    title: text(value.title, "title"),
    owner: text(value.owner, "owner"),
    cadenceDays: brandedNumber(alias(value, "cadenceDays", "cadence_days"), "cadenceDays", isDays),
  };
};

export const parseEvidence = (raw: unknown): Evidence => {
  const value = fields(raw, ["id", "controlId", "control_id", "kind", "summary", "collectedAt", "collected_at", "expiresAt", "expires_at", ...PAGE_FIELDS]);
  const collectedAt = parseInstant(alias(value, "collectedAt", "collected_at"), "collectedAt");
  return {
    id: brandedText(value.id, "id", isEvidenceId),
    controlId: brandedText(alias(value, "controlId", "control_id"), "controlId", isControlId),
    kind: text(value.kind, "kind"),
    summary: text(value.summary, "summary"),
    page: pageValue(value),
    collectedAt,
    expiresAt: expiration(alias(value, "expiresAt", "expires_at"), collectedAt),
  };
};

export const parseAttestation = (raw: unknown): Attestation => {
  const value = fields(raw, ["id", "controlId", "control_id", "by", "statement", "at", "expiresAt", "expires_at"]);
  const at = parseInstant(value.at, "at");
  return {
    id: brandedText(value.id, "id", isAttestationId),
    controlId: brandedText(alias(value, "controlId", "control_id"), "controlId", isControlId),
    by: brandedText(value.by, "by", isActor),
    statement: text(value.statement, "statement"),
    at,
    expiresAt: expiration(alias(value, "expiresAt", "expires_at"), at),
  };
};

export const parseDocument = (raw: unknown): ComplianceDocument => {
  const value = fields(raw, ["id", "programId", "program_id", "title", ...PAGE_FIELDS]);
  const page = pageValue(value);
  if (page === null) return invalid("page", "a Page identifier, version and SHA-256");
  return {
    id: brandedText(value.id, "id", isDocumentId),
    programId: brandedText(alias(value, "programId", "program_id"), "programId", isProgramId),
    title: text(value.title, "title"),
    page,
  };
};

export const parseWrite = (raw: unknown, entity: EntityKind): WriteInput => {
  const value = record(raw);
  const metadata = { actor: brandedText(value.actor, "actor", isActor), reason: text(value.reason, "reason") };
  switch (entity) {
    case "program": return { entity, body: parseProgram(raw), ...metadata };
    case "control": return { entity, body: parseControl(raw), ...metadata };
    case "evidence": return { entity, body: parseEvidence(raw), ...metadata };
    case "attestation": return { entity, body: parseAttestation(raw), ...metadata };
    case "document": return { entity, body: parseDocument(raw), ...metadata };
  }
};

export const parseProgramQuery = (raw: unknown): { readonly programId: ProgramId } => {
  const value = fields(raw, ["programId", "program_id"]);
  return { programId: brandedText(alias(value, "programId", "program_id"), "programId", isProgramId) };
};

export const parseExpiringQuery = (raw: unknown): { readonly programId: ProgramId; readonly withinDays: number } => {
  const value = fields(raw, ["programId", "program_id", "withinDays", "within_days"]);
  const withinDays = alias(value, "withinDays", "within_days");
  if (typeof withinDays !== "number" || !Number.isSafeInteger(withinDays) || withinDays < 0) {
    return invalid("withinDays", "a non-negative safe integer");
  }
  return { programId: brandedText(alias(value, "programId", "program_id"), "programId", isProgramId), withinDays };
};

export const parseDocumentQuery = (raw: unknown): { readonly docId: DocumentId; readonly sha256: Sha256Hex } => {
  const value = fields(raw, ["docId", "doc_id", "sha256"]);
  return {
    docId: brandedText(alias(value, "docId", "doc_id"), "docId", isDocumentId),
    sha256: brandedText(value.sha256, "sha256", isSha256Hex),
  };
};
