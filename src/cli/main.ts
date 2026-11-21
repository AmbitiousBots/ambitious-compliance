import { readCommand, writeCommand, type Command } from "@ambitious/kit/cli/command";
import { embedded } from "@ambitious/kit/cli/embedded";
import { runCli } from "@ambitious/kit/cli/run-cli";
import { verifyChain } from "../db/history.ts";
import { append, exportProgram, loadProjection, rebuild, verifyDbChain } from "../db/store.ts";
import { programExpiring, programGaps, programStatus } from "../domain/analysis.ts";
import { checkDocument, parseChainInput } from "../domain/check.ts";
import { parseDocumentQuery, parseInstant, parseProgramQuery, parseWindowQuery, parseWrite } from "../domain/parse.ts";
import type { EntityKind } from "../domain/types.ts";

const add = (entity: EntityKind): Command => writeCommand({
  input: (raw) => parseWrite(raw, entity),
  run: ({ db, input, clock }) => append(db, input, parseInstant(clock.now().toISOString())),
});

const chainCommand: Command = {
  access: "read",
  takesInput: true,
  parse: (raw) => {
    const input = parseChainInput(raw);
    return ({ openDb }) => input.kind === "export"
      ? verifyChain(input.history, input.chainHead)
      : verifyDbChain(openDb());
  },
};

await runCli({
  ...embedded(),
  schemaVersion: 1,
  commands: {
    "program add": add("program"),
    "control add": add("control"),
    "evidence add": add("evidence"),
    attest: add("attestation"),
    "doc record": add("document"),
    status: readCommand({
      input: parseWindowQuery,
      run: ({ db, input, clock }) => programStatus(loadProjection(db), input.programId, parseInstant(clock.now().toISOString()), input.withinDays),
    }),
    gaps: readCommand({
      input: parseProgramQuery,
      run: ({ db, input, clock }) => programGaps(loadProjection(db), input.programId, parseInstant(clock.now().toISOString())),
    }),
    expiring: readCommand({
      input: parseWindowQuery,
      run: ({ db, input, clock }) => programExpiring(loadProjection(db), input.programId, parseInstant(clock.now().toISOString()), input.withinDays),
    }),
    "verify-chain": chainCommand,
    "doc check": readCommand({
      input: parseDocumentQuery,
      run: ({ db, input }) => checkDocument(loadProjection(db), input.docId, input.sha256),
    }),
    export: readCommand({ input: parseProgramQuery, run: ({ db, input }) => exportProgram(db, input.programId) }),
    rebuild: writeCommand({ run: ({ db }) => rebuild(db) }),
  },
});
