import { failure } from "@ambitious/kit/domain/failure";
import {
  DEFAULT_WITHIN_DAYS, evidenceWeight,
  type Attestation, type AttestationId, type Control, type ControlId, type Evidence, type EvidenceId, type Instant,
  type NonEmptyArray, type ProgramId, type ProgramStatus, type Projection, type RedReason, type Status, type Support,
} from "./types.ts";

const DAY_MS = 86_400_000;
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const isCurrentEvidence = (evidence: Evidence, now: Instant): boolean => evidence.collectedAt <= now && now < evidence.expiresAt;
export const isCurrentOfficialEvidence = (evidence: Evidence, now: Instant): boolean => evidenceWeight(evidence) === "official" && isCurrentEvidence(evidence, now);
export const isCurrentAttestation = (attestation: Attestation, now: Instant): boolean => attestation.at <= now && now < attestation.expiresAt;

const controlsFor = (projection: Projection, programId: ProgramId): readonly Control[] => {
  if (!projection.programs.has(programId)) {
    throw failure("E_NOT_FOUND", "The program does not exist.", "Add the program first or use an existing program identifier.");
  }
  return [...projection.controls.values()].filter((control) => control.programId === programId).sort((left, right) => compareText(left.id, right.id));
};

const evidenceSupport = (evidence: Evidence): Support => ({ kind: "evidence", evidenceId: evidence.id, expiresAt: evidence.expiresAt });
const attestationSupport = (attestation: Attestation): Support => ({ kind: "attestation", attestationId: attestation.id, expiresAt: attestation.expiresAt });
const supportId = (support: Support): string => support.kind === "evidence" ? support.evidenceId : support.attestationId;

const evidenceReasons = (evidence: readonly Evidence[], now: Instant): readonly RedReason[] => evidence.map((item): RedReason => {
  const weight = evidenceWeight(item);
  if (weight === "official") {
    return item.collectedAt > now
      ? { kind: "not_yet_collected", evidenceId: item.id, collectedAt: item.collectedAt }
      : { kind: "expired", support: evidenceSupport(item) };
  }
  if (item.collectedAt > now) return { kind: "documented_future_dated", evidenceId: item.id, weight, collectedAt: item.collectedAt };
  return { kind: now < item.expiresAt ? "documented_not_official" : "documented_expired", evidenceId: item.id, weight, expiresAt: item.expiresAt };
});

const nonEmptyReasons = (reasons: readonly RedReason[]): NonEmptyArray<RedReason> => {
  const [first, ...rest] = reasons;
  return first === undefined ? [{ kind: "nothing_recorded" }] : [first, ...rest];
};

const controlStatus = (evidence: readonly Evidence[], attestations: readonly Attestation[], now: Instant, withinDays: number): Status => {
  const support = [
    ...evidence.filter((item) => isCurrentOfficialEvidence(item, now)).map(evidenceSupport),
    ...attestations.filter((item) => isCurrentAttestation(item, now)).map(attestationSupport),
  ].sort((left, right) => compareText(right.expiresAt, left.expiresAt) || compareText(left.kind, right.kind) || compareText(supportId(left), supportId(right)))[0];
  if (support !== undefined) {
    return Date.parse(support.expiresAt) - Date.parse(now) <= withinDays * DAY_MS
      ? { color: "yellow", reasons: [{ kind: "expiring", support, withinDays }] }
      : { color: "green", reasons: [{ kind: "current", support }] };
  }
  const reasons: readonly RedReason[] = [
    ...evidenceReasons(evidence, now),
    ...attestations.map((item): RedReason => item.at > now
      ? { kind: "not_yet_attested", attestationId: item.id, at: item.at }
      : { kind: "expired", support: attestationSupport(item) }),
  ];
  return { color: "red", reasons: nonEmptyReasons(reasons) };
};

const evidenceFor = (projection: Projection, controlId: ControlId): readonly Evidence[] => [...projection.evidence.values()]
  .filter((item) => item.controlId === controlId).sort((left, right) => compareText(left.id, right.id));

const attestationsFor = (projection: Projection, controlId: ControlId): readonly Attestation[] => [...projection.attestations.values()]
  .filter((item) => item.controlId === controlId).sort((left, right) => compareText(left.id, right.id));

export const programStatus = (projection: Projection, programId: ProgramId, now: Instant, withinDays: number = DEFAULT_WITHIN_DAYS): ProgramStatus => ({
  programId,
  now,
  withinDays,
  controls: controlsFor(projection, programId).map((control) => ({
    controlId: control.id,
    status: controlStatus(evidenceFor(projection, control.id), attestationsFor(projection, control.id), now, withinDays),
  })),
});

export type ProgramGaps = {
  readonly programId: ProgramId;
  readonly now: Instant;
  readonly controls: readonly { readonly controlId: ControlId; readonly reasons: NonEmptyArray<RedReason> }[];
};

export const programGaps = (projection: Projection, programId: ProgramId, now: Instant): ProgramGaps => ({
  programId,
  now,
  controls: controlsFor(projection, programId).flatMap((control) => {
    const evidence = evidenceFor(projection, control.id);
    return evidence.some((item) => isCurrentOfficialEvidence(item, now)) ? [] : [{ controlId: control.id, reasons: nonEmptyReasons(evidenceReasons(evidence, now)) }];
  }),
});

export type SuggestedTask = {
  readonly title: string;
  readonly list: "compliance";
  readonly due: Instant;
  readonly labels: readonly string[];
  readonly done_when: string;
  readonly idem_key: string;
};

export type ExpiringItem = {
  readonly controlId: ControlId;
  readonly expiresAt: Instant;
  readonly task: SuggestedTask;
} & (
  | { readonly kind: "evidence"; readonly id: EvidenceId }
  | { readonly kind: "attestation"; readonly id: AttestationId }
);

export type ProgramExpiring = {
  readonly programId: ProgramId;
  readonly now: Instant;
  readonly withinDays: number;
  readonly items: readonly ExpiringItem[];
};

const suggestedTask = (kind: "evidence" | "attestation", id: EvidenceId | AttestationId, expiresAt: Instant, control: Control): SuggestedTask => ({
  title: `Renew ${kind} ${id}`,
  list: "compliance",
  due: expiresAt,
  labels: ["compliance", `program:${control.programId}`, `control:${control.id}`],
  done_when: kind === "evidence"
    ? `Record current evidence for control ${control.id} before ${expiresAt}.`
    : `Record a current attestation for control ${control.id} before ${expiresAt}.`,
  idem_key: kind === "evidence" ? `compliance:${id}:${expiresAt}` : `compliance:attestation:${id}:${expiresAt}`,
});

export const programExpiring = (projection: Projection, programId: ProgramId, now: Instant, withinDays: number = DEFAULT_WITHIN_DAYS): ProgramExpiring => {
  const horizon = withinDays * DAY_MS;
  const expiresWithin = (expiresAt: Instant): boolean => Date.parse(expiresAt) - Date.parse(now) <= horizon;
  const items: ExpiringItem[] = controlsFor(projection, programId).flatMap((control): ExpiringItem[] => [
    ...evidenceFor(projection, control.id).filter((item) => isCurrentOfficialEvidence(item, now) && expiresWithin(item.expiresAt)).map((item): ExpiringItem => ({
      kind: "evidence", id: item.id, controlId: control.id, expiresAt: item.expiresAt,
      task: suggestedTask("evidence", item.id, item.expiresAt, control),
    })),
    ...attestationsFor(projection, control.id).filter((item) => isCurrentAttestation(item, now) && expiresWithin(item.expiresAt)).map((item): ExpiringItem => ({
      kind: "attestation", id: item.id, controlId: control.id, expiresAt: item.expiresAt,
      task: suggestedTask("attestation", item.id, item.expiresAt, control),
    })),
  ]);
  items.sort((left, right) => compareText(left.expiresAt, right.expiresAt) || compareText(left.controlId, right.controlId) || compareText(left.kind, right.kind) || compareText(left.id, right.id));
  return { programId, now, withinDays, items };
};
