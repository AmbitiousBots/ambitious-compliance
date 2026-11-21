declare const brand: unique symbol;

type Brand<Base, Name extends string> = Base & { readonly [brand]: Name };

export type NonEmptyArray<T> = readonly [T, ...T[]];

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type ProgramId = Brand<string, "ProgramId">;
export type ControlId = Brand<string, "ControlId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type AttestationId = Brand<string, "AttestationId">;
export type DocumentId = Brand<string, "DocumentId">;
export type Actor = Brand<string, "Actor">;
export type Instant = Brand<string, "Instant">;
export type Days = Brand<number, "Days">;
export type HistorySeq = Brand<number, "HistorySeq">;
export type Sha256Hex = Brand<string, "Sha256Hex">;
export type PageId = Brand<string, "PageId">;
export type PageVersion = Brand<number, "PageVersion">;

export const ID_LIMIT = 128;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isId = (raw: string): boolean => raw.length <= ID_LIMIT && ID_PATTERN.test(raw);

export const isProgramId = (raw: string): raw is ProgramId => isId(raw);
export const isControlId = (raw: string): raw is ControlId => isId(raw);
export const isEvidenceId = (raw: string): raw is EvidenceId => isId(raw);
export const isAttestationId = (raw: string): raw is AttestationId => isId(raw);
export const isDocumentId = (raw: string): raw is DocumentId => isId(raw);
export const ACTOR_LIMIT = 200;
export const ACTOR_RULE = `1 to ${ACTOR_LIMIT} Unicode characters with no control characters (including newlines) and no leading or trailing whitespace; spaces inside the value are allowed`;

const CONTROL_CHARACTER = /\p{Cc}|[\u2028\u2029]/u;

export const isWriteActor = (raw: string): raw is Actor =>
  raw.isWellFormed() && raw !== "" && raw === raw.trim() && !CONTROL_CHARACTER.test(raw) && raw.length <= ACTOR_LIMIT * 2 && Array.from(raw).length <= ACTOR_LIMIT;

export const isLegacyActor = (raw: string): raw is Actor => raw.isWellFormed() && raw.trim() !== "" && raw.length <= ID_LIMIT;

// WHY: history committed under the earlier actor rule must keep verifying, so a recorded actor may satisfy either rule.
export const isRecordedActor = (raw: string): raw is Actor => isWriteActor(raw) || isLegacyActor(raw);
export const isInstant = (raw: string): raw is Instant => INSTANT_PATTERN.test(raw);
export const isDays = (raw: number): raw is Days => Number.isSafeInteger(raw) && raw >= 1;
export const isHistorySeq = (raw: number): raw is HistorySeq => Number.isSafeInteger(raw) && raw >= 1;
export const isSha256Hex = (raw: string): raw is Sha256Hex => SHA256_PATTERN.test(raw);
export const isPageId = (raw: string): raw is PageId => raw.isWellFormed() && raw.trim() !== "" && raw.length <= ID_LIMIT;
export const isPageVersion = (raw: number): raw is PageVersion => Number.isSafeInteger(raw) && raw >= 1;

export type PageRef = {
  readonly pageId: PageId;
  readonly pageVersion: PageVersion;
  readonly pageSha256: Sha256Hex;
};

export type Program = {
  readonly id: ProgramId;
  readonly name: string;
  readonly framework: string;
};

export type Control = {
  readonly id: ControlId;
  readonly programId: ProgramId;
  readonly ref: string;
  readonly title: string;
  readonly owner: string;
  readonly cadenceDays: Days;
};

export const EVIDENCE_WEIGHTS = ["official", "draft", "decision"] as const;

export type EvidenceWeight = (typeof EVIDENCE_WEIGHTS)[number];

export const isEvidenceWeight = (raw: string): raw is EvidenceWeight => EVIDENCE_WEIGHTS.some((weight) => weight === raw);

export type Evidence = {
  readonly id: EvidenceId;
  readonly controlId: ControlId;
  readonly kind: string;
  // WHY: optional because bodies hashed before the field existed must keep their exact content; evidenceWeight reads absent as official.
  readonly weight?: EvidenceWeight;
  readonly summary: string;
  readonly page: PageRef | null;
  readonly collectedAt: Instant;
  readonly expiresAt: Instant;
};

export const evidenceWeight = (evidence: Evidence): EvidenceWeight => evidence.weight ?? "official";

export type Attestation = {
  readonly id: AttestationId;
  readonly controlId: ControlId;
  readonly by: Actor;
  readonly statement: string;
  readonly at: Instant;
  readonly expiresAt: Instant;
};

export type ComplianceDocument = {
  readonly id: DocumentId;
  readonly programId: ProgramId;
  readonly title: string;
  readonly page: PageRef;
};

export type EntityByKind = {
  readonly program: Program;
  readonly control: Control;
  readonly evidence: Evidence;
  readonly attestation: Attestation;
  readonly document: ComplianceDocument;
};

export const ENTITY_KINDS = ["program", "control", "evidence", "attestation", "document"] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number] & keyof EntityByKind;

export type EntityId<Kind extends EntityKind = EntityKind> = EntityByKind[Kind]["id"];

export const HISTORY_OPS = ["create", "update", "retire"] as const;

export type HistoryOp = (typeof HISTORY_OPS)[number];

export type RetiredBody = { readonly [field: string]: never };

type ChangeOf<Kind extends EntityKind> = Kind extends EntityKind
  ?
      | {
          readonly entity: Kind;
          readonly entityId: EntityId<Kind>;
          readonly op: "create" | "update";
          readonly body: EntityByKind[Kind];
        }
      | {
          readonly entity: Kind;
          readonly entityId: EntityId<Kind>;
          readonly op: "retire";
          readonly body: RetiredBody;
        }
  : never;

export type HistoryChange = ChangeOf<EntityKind>;

export const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000" as const;

export type GenesisPrevHash = typeof GENESIS_PREV_HASH;

export type PrevHash = Sha256Hex | GenesisPrevHash;

export type HistoryEntryContent = HistoryChange & {
  readonly seq: HistorySeq;
  readonly at: Instant;
  readonly actor: Actor;
  readonly reason: string;
};

export type HistoryEntry = HistoryEntryContent & {
  readonly prevHash: PrevHash;
  readonly hash: Sha256Hex;
};

export type ChainHead =
  | { readonly kind: "empty"; readonly hash: GenesisPrevHash }
  | { readonly kind: "entry"; readonly seq: HistorySeq; readonly hash: Sha256Hex };

export const EMPTY_CHAIN_HEAD: ChainHead = { kind: "empty", hash: GENESIS_PREV_HASH };

export type WriteReceipt = {
  readonly entity: EntityKind;
  readonly historySeq: HistorySeq;
  readonly hash: Sha256Hex;
};

export type ChainVerification =
  | { readonly ok: true; readonly head: ChainHead }
  | { readonly ok: false; readonly firstBadSeq: HistorySeq };

export type Projection = {
  readonly programs: ReadonlyMap<ProgramId, Program>;
  readonly controls: ReadonlyMap<ControlId, Control>;
  readonly evidence: ReadonlyMap<EvidenceId, Evidence>;
  readonly attestations: ReadonlyMap<AttestationId, Attestation>;
  readonly documents: ReadonlyMap<DocumentId, ComplianceDocument>;
};

export type DocumentCheck =
  | { readonly matches: true; readonly document: DocumentId; readonly sha256: Sha256Hex }
  | {
      readonly matches: false;
      readonly document: DocumentId;
      readonly recordedSha256: Sha256Hex;
      readonly givenSha256: Sha256Hex;
    };

export type Support =
  | { readonly kind: "evidence"; readonly evidenceId: EvidenceId; readonly expiresAt: Instant }
  | { readonly kind: "attestation"; readonly attestationId: AttestationId; readonly expiresAt: Instant };

export type GreenReason = { readonly kind: "current"; readonly support: Support };

export type YellowReason = {
  readonly kind: "expiring";
  readonly support: Support;
  readonly withinDays: number;
};

export type RedReason =
  | { readonly kind: "nothing_recorded" }
  | { readonly kind: "expired"; readonly support: Support }
  | { readonly kind: "not_yet_collected"; readonly evidenceId: EvidenceId; readonly collectedAt: Instant }
  | { readonly kind: "not_yet_attested"; readonly attestationId: AttestationId; readonly at: Instant }
  | {
      readonly kind: "documented_not_official";
      readonly evidenceId: EvidenceId;
      readonly weight: Exclude<EvidenceWeight, "official">;
      readonly expiresAt: Instant;
    };

export type UnknownReason = { readonly kind: "nothing_recorded" };

export const STATUS_COLORS = ["green", "yellow", "red", "unknown"] as const;

export type StatusColor = (typeof STATUS_COLORS)[number];

type ReasonByColor = {
  readonly green: GreenReason;
  readonly yellow: YellowReason;
  readonly red: RedReason;
  readonly unknown: UnknownReason;
};

type StatusOf<Color extends StatusColor> = Color extends StatusColor
  ? { readonly color: Color; readonly reasons: NonEmptyArray<ReasonByColor[Color]> }
  : never;

export type Status = StatusOf<StatusColor>;

export type ControlStatus = {
  readonly controlId: ControlId;
  readonly status: Status;
};

export const DEFAULT_WITHIN_DAYS = 30;

export type ProgramStatus = {
  readonly programId: ProgramId;
  readonly now: Instant;
  readonly withinDays: number;
  readonly controls: readonly ControlStatus[];
};
