---
name: verify-compliance
description: Verify the Ambitious Compliance command-line module after a change. Build the binary, exercise every command against fresh local databases, check history and expiry behavior, and retain evidence for a pull request.
---

# Verify Ambitious Compliance

The module receives JSON on stdin or through `--in` and prints one JSON envelope. `verify/run` drives the built binary through this interface and checks database behavior and the formal history model.

## Launch

Install the pinned tools with [mise](https://mise.jdx.dev), install dependencies, and build the binary.

```sh
mise trust -q .
mise install -q
npm ci
npm run build
verify/run --doctor
```

There is no server. A ready checkout has the pinned Node runtime, installed dependencies and a valid feature map. `verify/run` builds the binary as its first feature. Build first when selecting only one feature.

## Doctor

```sh
verify/run --doctor
```

This read-only command checks the Node version, dependency directory and feature list. It creates no module database. For a complete check of the executable and a scratch database, run `verify/run --only selfcheck`.

## Drive

```sh
verify/run
verify/run --list
verify/run --only status --only gaps
```

`verify/features.json` maps every command and each cross-cutting promise to an executable check. The CLI tests pass fixed time and seed values, inspect envelopes and stored results, and isolate every test in a fresh directory. Storage tests additionally exercise migration upgrades, rejected history edits, raw-file alteration, rollback, reconstruction and simultaneous writers. Generated-clock tests exercise expiry boundaries.

The fixture adapter in `verify/checks/contract-module.mjs` imports the actual built bundle and runs all six kit contract checks unchanged. Kit 0.1.1 sends `{}` to every read command while expecting a missing-database error. Five commands require fields, so the adapter supplies valid sample query fields for exactly that input. It changes no output or exit code. Direct binary tests separately require `E_INPUT_SCHEMA` for invalid read input, `E_MIGRATION` for valid input without a database, and unchanged database bytes for populated analysis. The executable checksum is also checked directly against the built file.

`test/handoff.test.ts` always checks task payload fields and distinct stable keys. It checks acceptance and repeated handoff against `tasks-v0.1.0` when that GitHub release exists, after verifying the asset checksum. If the release is absent, that external check reports an explicit skip; an authentication or download error fails instead. This requires the GitHub CLI and repository access while the dependency repository is private.

To exercise the CLI manually, create a scratch home and keep fixed clock values.

```sh
scratch_home="$(mktemp -d)"
AMBITIOUS_HOME="$scratch_home" node dist/ambitious-compliance.mjs selfcheck --now 2026-01-01T00:00:00Z --seed 7
AMBITIOUS_HOME="$scratch_home" node dist/ambitious-compliance.mjs commands --now 2026-01-01T00:00:00Z --seed 7
rm -r "$scratch_home"
```

## Evidence

The runner prints a table with one row per feature and exits nonzero if any check fails. Paste the table and any dependency skip into a pull request. Full stdout, stderr, command and exit status are saved in a separate temporary evidence directory, whose location is printed after the table. Keep these logs until review is complete.

For the full release gate, run `npm run release:check`. It also checks types, lint, import boundaries, all tests, the contract, the history models and the bundled release checksum. Read formal results with the pstack `/statechart` skill as described in `verify/formal/SKILL.md`.

These checks use local scratch data. They do not prove installation on another computer or results against an organization's private program records.

## Cleanup

The runner and test helpers remove only the temporary data directories they created, including after failure. They retain the evidence directory. No process remains after a CLI invocation. Delete retained evidence only after review is complete.
