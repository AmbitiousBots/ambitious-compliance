import type {
  Attestation, AttestationId, ComplianceDocument, Control, ControlId, DocumentId,
  Evidence, EvidenceId, HistoryEntry, Program, ProgramId, Projection,
} from "./types.ts";

export const replay = (history: readonly HistoryEntry[]): Projection => {
  const programs = new Map<ProgramId, Program>();
  const controls = new Map<ControlId, Control>();
  const evidence = new Map<EvidenceId, Evidence>();
  const attestations = new Map<AttestationId, Attestation>();
  const documents = new Map<DocumentId, ComplianceDocument>();
  for (const entry of history) {
    switch (entry.entity) {
      case "program": if (entry.op === "retire") programs.delete(entry.entityId); else programs.set(entry.entityId, entry.body); break;
      case "control": if (entry.op === "retire") controls.delete(entry.entityId); else controls.set(entry.entityId, entry.body); break;
      case "evidence": if (entry.op === "retire") evidence.delete(entry.entityId); else evidence.set(entry.entityId, entry.body); break;
      case "attestation": if (entry.op === "retire") attestations.delete(entry.entityId); else attestations.set(entry.entityId, entry.body); break;
      case "document": if (entry.op === "retire") documents.delete(entry.entityId); else documents.set(entry.entityId, entry.body); break;
    }
  }
  return { programs, controls, evidence, attestations, documents };
};
