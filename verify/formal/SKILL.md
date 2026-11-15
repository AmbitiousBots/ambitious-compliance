---
name: verify-formal-compliance
description: Check committed history retention, projection replay and hash chaining against the two-writer TLA+ model. Use after changing write transactions, history inserts or triggers, projections, chain verification, rebuild, migrations or the formal model.
---

# Verify the history model

## What is verified

| Invariant | Promise | Consequence of a violation |
|---|---|---|
| `HistoryOnlyGrows` | Every returned history sequence and hash still identifies its committed row. | A previously recorded change disappears or is replaced. |
| `ProjectionMatchesLastEntry` | Each current record equals its last committed history value. | Analysis reports values unsupported by history. |
| `ChainVerifies` | Sequence numbers, previous hashes and content hashes agree. | A committed chain fails verification. |

TLA+ with the TLC model checker explores the ordering of two writers, including rollback during a write. The checked bounds are two writers, two entities, two possible contents and five history rows, with no step-count bound. Hashes are modeled as injective functions. SQLite is assumed to serialize immediate transactions and commit or roll back their changes together.

The model does not prove SQLite, SHA-256, operating-system durability or permissions. SQL conflict behavior, parsing, timestamps and migration upgrades are checked separately against the actual database and CLI. A complete chain cannot establish that an attacker has not rewritten the entire database. Comparing against a saved chain head detects a missing suffix; keep that head or an export separately when retention matters.

## Run

From a checkout with the pinned mise tools and `npm ci` complete, run:

```sh
npm run typecheck && npm run tlc && node --test test/storage.test.ts
```

`npm run tlc` uses the kit runner through `spec/check.sh`. It downloads and checksum-verifies the pinned TLC jar, runs with one worker, and checks the passing model plus every broken variant. `scripts/check-models.mjs` also checks that each invariant has a small broken variant with the same bounds and that the correct model explores more than 1,000 distinct states. The summary must end with all four models behaving as required and the model-structure check passing.

The storage tests exercise real SQLite transactions and triggers. They check duplicate saves, preserved prior document values, replacement and upsert rejection with recursive triggers disabled, raw-file alteration detection, projection rebuild, rollback and simultaneous writers.

## Covered code

Model baseline commit: `5f4d37d7690c7fce71d2c9b25835bf7cd576a121`.

Implementation checked against this model at commit `b5345adf8fa0cc2f7af3e7ce109e2274f2683057`. The complete release check passed, including 358,569 distinct states, all three expected counterexamples and all storage regressions.

| Model action or invariant | Implementation |
|---|---|
| `Receive` | `src/cli/main.ts` write commands call `parseWrite` in `src/domain/parse.ts`. `HistoryChange` in `src/domain/types.ts` ties entity kind to identifier and body. |
| `Begin`, `lock`, `head` | The vendored kit's `cli/run-cli` starts `BEGIN IMMEDIATE` before `src/db/store.ts` `append` calls `verifyDbChain` and reads the chain head. |
| `AppendHistory`, `RowFor`, `Hash` | `append` inserts one new history row. `src/db/history.ts` `hashContent` hashes the previous hash and canonical content. |
| `UpdateProjection` | `src/db/store.ts` `project` uses in-place projection upserts inside the same transaction. |
| `Commit`, `receipts` | The kit commits before emitting `WriteReceipt` from `append`. |
| `Rollback` | The kit rolls back an open transaction on error. The projection-failure regression verifies that a failed projection leaves no history row behind. |
| `HistoryIsProtected` | `migrations/0001_create_history.sql` rejects history updates and deletes. `0002_protect_history_inserts.sql` rejects an insertion that conflicts with an existing history sequence or hash, including replacement and upsert attempts. |
| `ChainVerifies` | `src/db/history.ts` `verifyChain` and `src/db/store.ts` `verifyDbChain` check canonical row hashes, sequence continuity and previous hashes. |
| `ProjectionMatchesLastEntry` | `src/domain/replay.ts` replays history; `src/db/store.ts` `rebuild` replaces projections in one transaction after validating the chain. Storage tests compare every current row with replayed history. |

Confirm this table against the implementation whenever covered files change. Record the checked implementation commit here after verification, and move it forward only after checking each mapping. Never infer that TLC verified TypeScript directly.

Everything from `Begin` through `Commit` represents one database transaction. Reading the head before taking the write lock, or moving projection writes outside that transaction, changes the modeled ordering and must be treated as a behavioral change.

## Read the result

Read results with the public pstack `/statechart` skill when available. It explains invariant failures as shortest paths in domain language. Its chart output is bounded; the full passing model is larger than its chart budget, so no full-state chart is expected.

The deliberately broken models demonstrate these paths:

- `DeleteAllowed` breaks `HistoryOnlyGrows`. A writer commits a row and returns its receipt, then a later operation deletes that row.
- `ProjectionOutsideTransaction` breaks `ProjectionMatchesLastEntry`. A writer inserts history and commits before updating the current record; a reader can see mismatched history and state.
- `HeadReadBeforeTransaction` breaks `ChainVerifies`. Two writers read the same head before acquiring the lock, then append from that stale head in successive transactions.

The correct model must pass. Each broken model must fail its named invariant; passing, failing a different invariant or failing to parse is an unsuccessful check. A failed run prints the TLC output. Find `Error: Invariant ... is violated` and read the numbered states in order. Each state header names the step that produced it; the final state shows the broken promise.

## Keep the model synchronized

Replay an unexpected failure against the actual code, one database operation per modeled step. If the code permits it, report the failure with the shortest path. If the code forbids a modeled step, identify the enforcing guard and correct the model without weakening the invariant.

When intentionally changing the protocol, update the model and each broken variant together. Every new invariant needs a deliberately broken variant and an explanation in `spec/broken/EXPECTED.json`. Keep tool URL and checksum pins together when changing TLC. Run the command above and update the implementation synchronization commit only after the model and code agree.
