import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import type { DocumentId, Projection, Sha256Hex } from "./types.ts";

export type ChainInput =
  | { readonly kind: "database" }
  | { readonly kind: "export"; readonly history: readonly unknown[]; readonly chainHead: unknown };

export const parseChainInput = (raw: unknown): ChainInput => {
  if (isRecord(raw) && Object.keys(raw).length === 0) return { kind: "database" };
  const value = isRecord(raw) && raw.ok === true && raw.module === "compliance" && raw.command === "export" ? raw.data : raw;
  if (!isRecord(value) || !Array.isArray(value.history) || !isRecord(value.chainHead)) {
    throw failure("E_INPUT_SCHEMA", "Chain verification needs an empty object or an exported history and chain head.", "Send {} to check the database, or pipe an export into verify-chain.");
  }
  return { kind: "export", history: value.history, chainHead: value.chainHead };
};

export const checkDocument = (projection: Projection, docId: DocumentId, sha256: Sha256Hex) => {
  const document = projection.documents.get(docId);
  if (document === undefined) {
    throw failure("E_NOT_FOUND", "The document is not recorded.", "Use doc record to record its Page reference first.");
  }
  if (document.page.pageSha256 !== sha256) {
    throw failure("E_DOC_CHANGED", "The supplied content hash differs from the recorded document.", "Review the Page change, then use doc record with its new version, hash, actor and reason.", {
      matches: false, document: docId, recordedSha256: document.page.pageSha256, givenSha256: sha256,
    });
  }
  return { matches: true, document: docId, sha256 };
};
