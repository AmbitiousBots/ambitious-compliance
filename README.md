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

All record-writing commands require `actor` and `reason` fields alongside the fields below. `actor` is 1 to 200 Unicode characters with no control characters (including newlines) and no leading or trailing whitespace; spaces inside the value are allowed. A value that breaks the rule is rejected with `E_INPUT_SCHEMA` and a hint that states the rule; nothing is trimmed. `reason` is non-empty text. Identifiers start with an ASCII letter or digit, contain only letters, digits, periods, underscores or hyphens, and have at most 128 characters. Times are ISO 8601 timestamps with a time zone and are normalized to UTC. Expiration must be after collection or attestation time.

Record text must be well-formed Unicode. Unpaired UTF-16 surrogates in record input return `E_INPUT_SCHEMA` before the database is opened. Valid Unicode text is stored unchanged.

| Command | Access | Input | Result in `data` |
|---|---|---|---|
| `program add` | write | `id`, `name`, `framework` | `entity`, `historySeq`, `hash` |
| `control add` | write | `id`, `programId`, `ref`, `title`, `owner`, positive integer `cadenceDays` | Write receipt |
| `evidence add` | write | `id`, `controlId`, `kind`, `summary`, `collectedAt`, `expiresAt`, optional `weight` (`official`, `draft` or `decision`; default `official`), optional `page` | Write receipt |
| `attest` | write | `id`, `controlId`, `by`, `statement`, `at`, `expiresAt` | Write receipt |
| `doc record` | write | `id`, `programId`, `title`, `page` | Write receipt; an existing document gets a new revision |
| `status` | read | `programId`, optional non-negative integer `withinDays` (default 30) | Control colors and reasons at the supplied clock, and the `withinDays` window used |
| `gaps` | read | `programId` | Controls with no current official evidence, even when an attestation supports their status or a draft or decision is on file |
| `expiring` | read | `programId`, optional non-negative integer `withinDays` (default 30) | Expiring official evidence and attestations with suggested task payloads |
| `verify-chain` | read | `{}`, an export's `data`, or a complete export envelope | `ok`, plus `head` or `firstBadSeq` |
| `doc check` | read | `docId`, `sha256` | A match or `E_DOC_CHANGED`; never changes the record |
| `export` | read | `programId` | Program projections, complete history and `chainHead` |
| `rebuild` | write | No input | Replayed projection counts |
| `selfcheck` | write | No input | Runtime, binary checksum, database integrity, migrations and problems |
| `commands` | none | No input | The command list, access modes and input requirements |

Analysis opens an existing database read-only and never migrates it. Run `selfcheck` first on a missing or older database. Verifying an exported bundle uses its contents without opening a database. A failed chain check returns `data.ok: false` with the first bad sequence; the outer envelope still describes a successfully completed analysis.

Record inputs also accept the corresponding database field names, such as `program_id`, `control_id`, `cadence_days`, `collected_at` and `expires_at`. A Page reference is `{"pageId":"page-example","version":1,"sha256":"<64 lowercase hexadecimal characters>"}`. The stored form uses `pageVersion` and `pageSha256`, which are also accepted as input. Flat `page_id`, `page_version` and `page_sha256` fields are accepted together instead of `page`. The module stores these references; it does not fetch, render or modify documents.

Duplicate adds return `E_EXISTS`. Repeating `doc record` appends another history row, including when its contents are unchanged. All existing controls are required. Evidence is current during `collectedAt <= now < expiresAt`; attestations are current during `at <= now < expiresAt`. Attestations are the only manual support; there is no free-standing status override.

### Evidence weight

Every evidence row has a `weight`, separate from the free-text `kind` label:

| `weight` | Meaning | Supports a control | Removes the control from `gaps` | Listed by `expiring` |
|---|---|---|---|---|
| `official` | The record itself | Yes, while current | Yes, while current | Yes |
| `draft` | A working version that is not final | No | No | No |
| `decision` | A recorded decision or intention | No | No | No |

`evidence add` without `weight` stores `official`, as version 0.1.0 did. Evidence recorded by version 0.1.0 has no `weight` in its history body or in `export`; it is read as `official`, and its history rows and hashes are unchanged. `kind` never affects weight: evidence with `kind` set to `draft` and no `weight` is official. Draft and decision rows are ordinary history rows: they are hash-chained, exported and replayed like every other row.

### Status colors

`status` reports what is on record at the supplied clock. A color is not an opinion on whether a control's underlying requirement is satisfied; the module records the register and nothing more.

| Color | Reason `kind` | What is on record |
|---|---|---|
| green | `current` | Current official evidence or a current attestation, with the longest-lasting one expiring after the expires-soon window |
| yellow | `expiring` | The longest-lasting current official evidence or attestation expires within the window; the reason carries the `withinDays` used |
| red | `documented_not_official` | Current draft or decision evidence is on file. Something is documented, but it is not official evidence |
| red | `documented_expired` | Draft or decision evidence that is past its `expiresAt`. Only a draft or decision was on file; no official evidence expired |
| red | `documented_future_dated` | Draft or decision evidence whose `collectedAt` is still in the future. No official evidence is scheduled |
| red | `expired` | Official evidence or an attestation that is past its `expiresAt` |
| red | `not_yet_collected`, `not_yet_attested` | Official evidence or an attestation dated in the future |
| red | `nothing_recorded` | No evidence or attestation of any kind |

Only current official evidence or a current attestation makes a control green or yellow. When draft or decision evidence is the only current record, the control stays red and each such row appears as a `documented_not_official` reason with its `evidenceId`, `weight` and `expiresAt`. A draft or decision row that has lapsed or is dated in the future keeps its `weight` in a `documented_expired` or `documented_future_dated` reason, so `expired` and `not_yet_collected` always refer to official evidence (or, for `expired`, an attestation). Draft and decision rows never extend, shorten or start the expires-soon window. The shared status type reserves `unknown`, but these required controls always produce red, yellow or green.

### Expires-soon window

The window is `withinDays`, a non-negative integer number of days, and defaults to 30 when omitted. It applies to `status` (yellow when `expiresAt - now` is at most `withinDays` days) and to `expiring`. Both commands return the `withinDays` they used, and each yellow `expiring` reason repeats it. Send `{"programId":"example","withinDays":90}` to use another window; `0` means nothing is yellow. A value that is not a non-negative safe integer returns `E_INPUT_SCHEMA`. A control's `cadenceDays` is recorded but does not change the window.

`expiring` returns only current official evidence and current attestations expiring within the window. Each `items[].task` can be passed to `ambitious-tasks add` and includes `title`, `list`, `due`, `labels`, `done_when` and `idem_key`. Evidence keys are `compliance:<id>:<normalized expiry>`; attestation keys add `attestation:` before the identifier to avoid collisions. The module does not invoke tasks or write its database.

## History and exports

History rows contain the sequence, time, actor, reason, entity, operation, body and preceding hash. SHA-256 covers the preceding hash followed by canonical JSON of the row content. A write takes SQLite's immediate write lock before reading the chain head and commits the new history row and its projection together. SQL triggers reject history updates, deletes and insert collisions, including replacement and upsert attempts. Schema version 2 adds the collision guard to existing schema version 1 databases. Schema version 3 adds the evidence `weight` column; existing evidence keeps an empty weight, which is read as `official`, and no history row is rewritten. After installing 0.1.1 over a 0.1.0 database, run `selfcheck` once: read commands return `E_MIGRATION` until `selfcheck` or a write command has applied the migration.

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

`npm run release:build` writes `release/ambitious-compliance-0.1.1.mjs` and `release/SHA256SUMS`. The bundled file runs with Node 24 alone. Development dependencies and migrations are embedded at build time; users do not run `npm install`. The kit's checksum-verifying installer can install that release. Release files are not committed.

The optional tasks integration check uses a checksum-verified `tasks-v0.1.0` release when available. It reports a clear skip when that release has not been published, while local payload shape tests still run. See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md) for contributing and responsible disclosure.

## Formal model

The rules of the version history (committed rows are never lost, the current state always matches the last history row, the hash chain always verifies) are checked for every interleaving of two concurrent writers by a TLA+ model in [`spec/`](spec/README.md). Run it with `bash spec/check.sh`. [`verify/formal/SKILL.md`](verify/formal/SKILL.md) tells an agent or a contributor when to rerun it and how to read a failure. The domain types the storage code uses are in [`src/domain/types.ts`](src/domain/types.ts).
