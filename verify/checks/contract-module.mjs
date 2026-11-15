#!/usr/bin/env node
import { Readable } from "node:stream";
import { parseArgs } from "@ambitious/kit/domain/args";

const { words, flags } = parseArgs(process.argv.slice(2));
const fixtures = {
  status: { programId: "contract-program" },
  gaps: { programId: "contract-program" },
  expiring: { programId: "contract-program", withinDays: 7 },
  export: { programId: "contract-program" },
  "doc check": { docId: "contract-document", sha256: "a".repeat(64) },
};
const fixture = fixtures[words.join(" ")];
if (fixture !== undefined && flags.in === null) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  Object.defineProperty(process, "stdin", { value: Readable.from([input === "{}" ? JSON.stringify(fixture) : input]) });
}
await import("../../dist/ambitious-compliance.mjs");
