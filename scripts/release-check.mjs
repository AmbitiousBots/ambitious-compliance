#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const USAGE = `Usage: node scripts/release-check.mjs

Runs every check a module release must pass, in order, and ends with one table.
Every step runs even when an earlier one failed, so one run shows everything
that is wrong. Needs the pinned tools: run "mise trust && mise install" and
"npm ci" first.

Exit code 0: every step passed. 1: at least one failed. 2: could not run.
`;

const repoRoot = join(import.meta.dirname, "..");

const STEPS = [
  ["typecheck", "TypeScript types are consistent"],
  ["lint", "lint and standalone documentation rules hold"],
  ["depcruise", "every import follows the directory rules"],
  ["test", "CLI, migration, concurrency and generated-clock behaviors pass"],
  ["contract", "the bundled module passes the shared contract"],
  ["tlc", "the history model passes and all broken variants fail as expected"],
  ["verify", "every user-visible feature passes in a fresh data directory"],
  ["release:build", "the single-file release and its checksum build"],
];

const pinnedEnvironment = () => {
  try {
    return JSON.parse(execFileSync("mise", ["env", "--json"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    process.stderr.write(
      `Cannot read the pinned tools from .mise.toml: ${String(error.stderr || error.message).trim()}\n` +
        `Install mise (https://mise.jdx.dev), then run "mise trust && mise install" in this repository.\n`,
    );
    return null;
  }
};

const table = (rows) => {
  const header = ["Step", "Result", "What it shows"];
  const cells = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...cells.map((line) => line[column].length)));
  const format = (line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [format(header), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(format)].join("\n");
};

const run = () => {
  const pinned = pinnedEnvironment();
  if (pinned === null) return 2;
  const env = { ...process.env, ...pinned };
  const results = STEPS.map(([script, shows]) => {
    process.stdout.write(`\n=== npm run ${script}\n`);
    const { status } = spawnSync("npm", ["run", "--silent", ...script.split(" ")], { cwd: repoRoot, stdio: "inherit", env });
    return { script, shows, passed: status === 0 };
  });
  const failed = results.filter(({ passed }) => !passed);
  process.stdout.write(`\n${table(results.map(({ script, shows, passed }) => [`npm run ${script}`, passed ? "pass" : "FAIL", shows]))}\n\n`);
  process.stdout.write(
    failed.length === 0
      ? `release check: ok. ${results.length} of ${results.length} steps passed.\n`
      : `release check: ${failed.length} of ${results.length} steps failed: ${failed.map(({ script }) => script).join(", ")}.\n`,
  );
  return failed.length === 0 ? 0 : 1;
};

if (process.argv.length > 2) {
  (process.argv[2] === "--help" ? process.stdout : process.stderr).write(USAGE);
  process.exitCode = process.argv[2] === "--help" ? 0 : 2;
} else {
  process.exitCode = run();
}
