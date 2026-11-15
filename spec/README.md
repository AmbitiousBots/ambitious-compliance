# Formal model of the version history

The compliance module keeps every change as a row in an append-only `history` table. Each row carries the hash of the row before it, so the rows form a chain, and the current-state tables (programs, controls, evidence, attestations, documents) are a projection of that history. Two processes can write to the same file at once: a person's command and a scheduled run, for example. This folder holds a small model of two such writers and checks, for every order in which their steps can happen, that the rules below are never broken. It was written before the storage code, so the code is written against rules that are already checked.

Run it from the repo root:

```sh
bash spec/check.sh
```

The script needs [mise](https://mise.jdx.dev) (it installs the pinned Java), `curl` and Node. It downloads TLC, the model checker for the TLA+ language, as `tla2tools.jar` from the address pinned in `.mise.toml`, keeps it in `~/.cache/ambitious/` and refuses a file whose SHA-256 differs from the pin. A run takes under a minute.

## `VersionHistory.tla`: the model

Two writers, two entities, two possible contents per entity, and a history of up to five rows. A writer does one write like this:

```text
idle -> Receive -> Begin -> AppendHistory -> UpdateProjection -> Commit -> Reply -> idle
                     \____________ Rollback (error or crash) ____________/
```

| Step in the model | What it stands for in the code |
|---|---|
| `Receive` | A write command (`program add`, `control add`, `evidence add`, `attest`, `doc record`) has parsed its input. Nothing is read from the database yet. |
| `Begin` | The write transaction starts and takes the database's write lock straight away (SQLite `BEGIN IMMEDIATE`), then reads the last history row's `seq` and `hash`. Only one writer can be past this step at a time. |
| `AppendHistory` | The new history row is inserted: `seq` is the last `seq` plus one, `prev_hash` is the last row's `hash`, and `hash` is computed from `prev_hash` and the row's content. |
| `UpdateProjection` | The entity's row in its current-state table is written, in the same transaction. |
| `Commit` | The transaction commits. From here on the row is permanent, and its `seq` and `hash` are what the command returns as `historySeq` and `hash`. The model remembers that pair as a receipt. |
| `Reply` | The command prints its result and exits. |
| `Rollback` | The transaction is abandoned at any point before `Commit`, because of an error or because the process died. The database is as it was at `Begin`. |
| `DeleteHistoryRow` | A `DELETE` on the history table. `HistoryIsProtected` stands for the triggers that abort every `UPDATE` and `DELETE` on that table, so in the model this step can never happen. |

The rules are checked on what a reader of the database can see: committed data only, never the half-finished work of an open transaction.

| Rule | In plain words | Harm if it breaks |
|---|---|---|
| `HistoryOnlyGrows` | Every receipt ever returned still points at its row: the row with that `seq` is still there and still has that `hash`. Because a hash covers everything before it, this means no committed row was removed, moved or replaced. | A change that was recorded, and that someone may have been shown, silently disappears from the audit trail. |
| `ProjectionMatchesLastEntry` | For every entity, the current-state row equals the content of the last history row for that entity, and there is no current-state row when the history has none. | `status`, `gaps` and `export` report a state that the history does not back, and `rebuild` would change the answers. |
| `ChainVerifies` | Reading the history from the first row: each `seq` is one more than the last, each `prev_hash` is the hash of the row before (the first row has the fixed starting value), and each `hash` is the hash of its own `prev_hash` and content. This is the check `verify-chain` runs. | `verify-chain` reports a broken chain although nobody tampered with the file, or two rows claim the same place in the chain. |

`TypeOK` is also checked: every value stays in its allowed set, and a writer is inside a transaction exactly when it holds the write lock. TLC also checks that no reachable state is stuck: a writer that dies never leaves the lock held.

The model checks about 359,000 distinct states.

### How the hash is modeled

SHA-256 is modeled as a function that gives different outputs for different inputs: the hash of a row is simply the pair of its `prev_hash` and its content, and the starting value is the empty pair. So in the model two rows have the same hash only when their whole chain up to that point is the same. Real SHA-256 collisions are assumed not to happen; the `UNIQUE` constraint on `hash` would turn one into a failed write.

### What the model leaves out

- A row's content is one value. It stands for everything the hash covers besides `seq` and the entity: `at`, `actor`, `reason`, `op` and `body`. The model does not know the difference between `create`, `update` and `retire`, and does not check which of them is allowed when.
- Cutting rows off the end of the file by going around the database (so the triggers never run) leaves a shorter chain that still verifies. Only someone who kept a receipt or an exported chain head can notice. Editing a row in place the same way is caught by `verify-chain`; that is covered by tests, not by this model.
- `rebuild`, the status rules, expiry and document hashes are not modeled.
- The bounds are two writers and five rows. The rules do not depend on the number of rows in any way the model can see, but that is an argument, not something TLC checked.

## `broken/`: showing that each rule can fail

Each file in `spec/broken/` is the model with one small, plausible mistake. `check.sh` requires each to break the rule listed for it in `broken/EXPECTED.json`, to use the same constants as the model, and to differ from the model in at most three lines. It also requires every rule in `VersionHistory.cfg` to have a variant that breaks it.

| Variant | The mistake | Rule it must break | Shortest path TLC finds |
|---|---|---|---|
| `DeleteAllowed` | The triggers on the history table are missing (`HistoryIsProtected` is false). | `HistoryOnlyGrows` | A write commits and returns a receipt; the row is deleted; the receipt points at nothing. |
| `ProjectionOutsideTransaction` | The current-state row is written after the transaction has committed, not inside it. | `ProjectionMatchesLastEntry` | A writer appends the history row and commits; before it writes the current-state row, a reader sees history that the current state does not show. If the writer dies here, it stays that way. |
| `HeadReadBeforeTransaction` | A writer reads the last row's `seq` and `hash` when it receives the command, before it holds the write lock. | `ChainVerifies` | Two writers read the same last row; the first commits; the second appends a row with the same `seq` and `prev_hash`. |

## What this constrains in the code

- One write is one transaction that starts by taking the write lock, and the last row is read inside it. `HeadReadBeforeTransaction` is what happens otherwise.
- The history row and the current-state row are written in that same transaction. `ProjectionOutsideTransaction` is what happens otherwise.
- The history table has triggers that abort `UPDATE` and `DELETE`. `DeleteAllowed` is what happens otherwise.
- The types in `src/domain/types.ts` name the same things: `HistoryEntry` (a row), `HistoryEntryContent` (what the hash covers), `PrevHash` and `GENESIS_PREV_HASH` (the starting value), `ChainHead` (what `Begin` reads), `WriteReceipt` (what `Commit` returns), `ChainVerification` (the result of `verify-chain`) and `Projection` (the current-state tables).
