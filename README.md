# ambitious-compliance

The compliance module tracks controls, evidence and attestations for a small business in one SQLite file, with an append-only, hash-chained version history so every change has an actor, a reason and a verifiable record. It uses no git storage. Documents are kept in Grok Bot Pages, and the module stores their references and content hashes. It is a command-line tool with JSON in and JSON out and no UI.

The module follows the shared module contract, [MODULE_CONTRACT.md](https://github.com/AmbitiousBots/ambitious-kit/blob/main/MODULE_CONTRACT.md) in ambitious-kit: one command-line binary, JSON in and a JSON envelope out, one SQLite file, deterministic with `--now` and `--seed`, no network except keyed AI calls.

Part of [Ambitious](https://ambitiousbots.com). Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Run locally

Install [mise](https://mise.jdx.dev), then build with the pinned toolchain.

```sh
mise trust -q .
mise install -q
mise exec -- npm ci
mise exec -- npm run build
export AMBITIOUS_HOME="$(mktemp -d)"
node dist/ambitious-compliance.mjs selfcheck --now 2026-01-01T00:00:00Z --seed 7
printf '%s\n' '{"id":"example","name":"Example program","framework":"custom","actor":"operator","reason":"Start tracking"}' | node dist/ambitious-compliance.mjs program add --now 2026-01-01T00:00:00Z --seed 7
printf '%s\n' '{"programId":"example"}' | node dist/ambitious-compliance.mjs export --now 2026-01-01T00:00:00Z --seed 7 | node dist/ambitious-compliance.mjs verify-chain --now 2026-01-01T00:00:00Z --seed 7
```

`--in` takes a JSON file path, not inline JSON. Use stdin as above for inline input. Every command accepts `--db`, `--now`, `--seed` and `--json`; output is always JSON. The envelope has `ok`, `schemaVersion`, `module`, `command`, `data`, `errors` and `meta`. `meta` echoes the normalized UTC clock, seed and binary version. Success exits 0, caller errors exit 1, and internal or database errors exit 2.

Data lives in `$AMBITIOUS_HOME/compliance/compliance.sqlite`. `AMBITIOUS_HOME` defaults to `/workspace/ambitious` on a Grok Bot computer; set it to a directory of your choice elsewhere. `--db` overrides the database path. The bot's private data directory, `/home/box/agent-data`, is refused, including paths reached through symbolic links. The module makes no network calls and requires no API keys.

## Commands

All record-writing commands require non-empty `actor` and `reason` fields alongside the fields below. Identifiers start with an ASCII letter or digit, contain only letters, digits, periods, underscores or hyphens, and have at most 128 characters. Times are ISO 8601 timestamps with a time zone and are normalized to UTC. Expiration must be after collection or attestation time.

| Command | Access | Input | Result in `data` |
|---|---|---|---|
| `program add` | write | `id`, `name`, `framework` | `entity`, `historySeq`, `hash` |
| `control add` | write | `id`, `programId`, `ref`, `title`, `owner`, positive integer `cadenceDays` | Write receipt |
| `evidence add` | write | `id`, `controlId`, `kind`, `summary`, `collectedAt`, `expiresAt`, optional `page` | Write receipt |
| `attest` | write | `id`, `controlId`, `by`, `statement`, `at`, `expiresAt` | Write receipt |
| `doc record` | write | `id`, `programId`, `title`, `page` | Write receipt; an existing document gets a new revision |
| `status` | read | `programId` | Control colors and reasons at the supplied clock |
| `gaps` | read | `programId` | Controls with no current evidence, even when an attestation supports their status |
| `expiring` | read | `programId`, non-negative integer `withinDays` | Expiring evidence and attestations with suggested task payloads |
| `verify-chain` | read | `{}`, an export's `data`, or a complete export envelope | `ok`, plus `head` or `firstBadSeq` |
| `doc check` | read | `docId`, `sha256` | A match or `E_DOC_CHANGED`; never changes the record |
| `export` | read | `programId` | Program projections, complete history and `chainHead` |
| `rebuild` | write | No input | Replayed projection counts |
| `selfcheck` | write | No input | Runtime, binary checksum, database integrity, migrations and problems |
| `commands` | none | No input | The command list, access modes and input requirements |

Analysis opens an existing database read-only and never migrates it. Run `selfcheck` first on a missing or older database. Verifying an exported bundle uses its contents without opening a database. A failed chain check returns `data.ok: false` with the first bad sequence; the outer envelope still describes a successfully completed analysis.

Record inputs also accept the corresponding database field names, such as `program_id`, `control_id`, `cadence_days`, `collected_at` and `expires_at`. A Page reference is `{"pageId":"page-example","version":1,"sha256":"<64 lowercase hexadecimal characters>"}`. The stored form uses `pageVersion` and `pageSha256`, which are also accepted as input. Flat `page_id`, `page_version` and `page_sha256` fields are accepted together instead of `page`. The module stores these references; it does not fetch, render or modify documents.

Duplicate adds return `E_EXISTS`. Repeating `doc record` appends another history row, including when its contents are unchanged. All existing controls are required. Evidence counts only during `collectedAt <= now < expiresAt`; attestations count only during `at <= now < expiresAt`. A control is red without current support, yellow when its longest-lasting current support expires within one quarter of its cadence, and green otherwise. The shared status type reserves `unknown`, but these required controls always produce red, yellow or green. Attestations are the only manual support; there is no free-standing status override.

`expiring` returns only current records expiring within the requested horizon. Each `items[].task` can be passed to `ambitious-tasks add` and includes `title`, `list`, `due`, `labels`, `done_when` and `idem_key`. Evidence keys are `compliance:<id>:<normalized expiry>`; attestation keys add `attestation:` before the identifier to avoid collisions. The module does not invoke tasks or write its database.

## History and exports

History rows contain the sequence, time, actor, reason, entity, operation, body and preceding hash. SHA-256 covers the preceding hash followed by canonical JSON of the row content. A write takes SQLite's immediate write lock before reading the chain head and commits the new history row and its projection together. SQL triggers reject history updates, deletes and insert collisions, including replacement and upsert attempts. Schema version 2 adds the collision guard to existing schema version 1 databases.

`rebuild` verifies the history before replaying projections and preserves the history itself. It cannot repair a damaged chain. `export` filters projections to the requested program but includes the complete module history, including other programs, because a filtered chain could not be verified. Treat an export as containing records from the whole database.

The hash chain detects modified entries and missing interior entries. A saved chain head also detects a missing tail. It is not a signature or an external trust anchor; someone who can rewrite the entire file and all hashes can create another internally consistent chain. Keep trusted exports or backups when comparison with an earlier state is needed.

## Errors

Shared error codes and envelope rules are defined in the [module contract](https://github.com/AmbitiousBots/ambitious-kit/blob/kit-v0.1.1/MODULE_CONTRACT.md). Module-specific errors are below.

| Code | Exit | Meaning | Typical hint |
|---|---|---|---|
| `E_EXISTS` | 1 | An add reused an existing identifier | Use a new identifier |
| `E_NOT_FOUND` | 1 | A program, parent control or document does not exist | Add its parent first or use an existing identifier |
| `E_DOC_CHANGED` | 1 | The supplied hash differs from the recorded Page hash | Review the change before recording a new revision |
| `E_CHAIN` | 1 | A write, export or rebuild found invalid history | Preserve the database and compare it with a trusted export or backup |

## Verify and build a release

```sh
mise exec -- npm outdated
mise exec -- npm audit
mise exec -- npm run release:check
mise exec -- verify/run
```

`release:check` runs type checking, lint, standalone documentation checks, dependency boundaries, unit and property tests, the module contract checks, TLA+/TLC, feature verification and the release build. `verify/run` checks the features in [verify/features.json](verify/features.json) using temporary data directories. It never needs real organization records.

`npm run release:build` writes `release/ambitious-compliance-0.1.0.mjs` and `release/SHA256SUMS`. The bundled file runs with Node 24 alone. Development dependencies and migrations are embedded at build time; users do not run `npm install`. The kit's checksum-verifying installer can install that release. Release files are not committed.

The optional tasks integration check uses a checksum-verified `tasks-v0.1.0` release when available. It reports a clear skip when that release has not been published, while local payload shape tests still run. See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md) for contributing and responsible disclosure.

## Formal model

The rules of the version history (committed rows are never lost, the current state always matches the last history row, the hash chain always verifies) are checked for every interleaving of two concurrent writers by a TLA+ model in [`spec/`](spec/README.md). Run it with `bash spec/check.sh`. [`verify/formal/SKILL.md`](verify/formal/SKILL.md) tells an agent or a contributor when to rerun it and how to read a failure. The domain types the storage code uses are in [`src/domain/types.ts`](src/domain/types.ts).
