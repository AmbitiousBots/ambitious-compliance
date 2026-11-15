import { createHash } from "node:crypto";
import { canonical, parseChainHead, parseHistoryEntry, sequence } from "../domain/history.ts";
import {
  EMPTY_CHAIN_HEAD, isSha256Hex,
  type ChainHead, type ChainVerification, type HistoryEntryContent, type Sha256Hex,
} from "../domain/types.ts";

export const hashContent = (content: HistoryEntryContent, prevHash: string): Sha256Hex => {
  const hash = createHash("sha256").update(prevHash).update(canonical({
    seq: content.seq, at: content.at, actor: content.actor, reason: content.reason,
    entity: content.entity, entity_id: content.entityId, op: content.op, body: content.body,
  })).digest("hex");
  if (!isSha256Hex(hash)) throw new Error("SHA-256 did not return a hexadecimal digest.");
  return hash;
};

export const verifyChain = (history: readonly unknown[], expectedHead?: unknown): ChainVerification => {
  let head: ChainHead = EMPTY_CHAIN_HEAD;
  for (const [index, raw] of history.entries()) {
    const expectedSeq = sequence(index + 1);
    try {
      const entry = parseHistoryEntry(raw);
      if (entry.seq !== expectedSeq || entry.prevHash !== head.hash || entry.hash !== hashContent(entry, entry.prevHash)) return { ok: false, firstBadSeq: expectedSeq };
      head = { kind: "entry", seq: entry.seq, hash: entry.hash };
    } catch {
      return { ok: false, firstBadSeq: expectedSeq };
    }
  }
  if (expectedHead !== undefined) {
    const expected = parseChainHead(expectedHead);
    if (canonical(head) !== canonical(expected)) {
      return { ok: false, firstBadSeq: sequence(expected.kind === "entry" && expected.seq <= history.length ? expected.seq : history.length + 1) };
    }
  }
  return { ok: true, head };
};
