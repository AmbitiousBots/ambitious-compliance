---
name: verify-formal-compliance
description: "Check the compliance module's version history rules (committed history rows are never lost, the current-state tables match the last history row, the hash chain verifies) against the TLA+ model of two concurrent writers. Use when a change touches how a write command opens its transaction, reads the last history row, inserts into history, writes a current-state table, the triggers on the history table, verify-chain, rebuild, or any file in spec/ or src/domain/."
---

# Formal verification for the compliance module

## What is verified

| Rule | In plain words | Harm if it breaks |
|---|---|---|
| `HistoryOnlyGrows` | Every `historySeq` and `hash` a write ever returned still points at that row. | A recorded change silently disappears from the audit trail. |
| `ProjectionMatchesLastEntry` | For every entity, the current-state row equals the content of its last history row. | `status`, `gaps` and `export` report a state the history does not back. |
| `ChainVerifies` | Each row's `seq` follows the last, its `prev_hash` is the hash of the row before, and its `hash` matches its content. | `verify-chain` fails although nobody tampered with the file. |

Tool: TLA+ with the TLC model checker, because the question is whether any order of steps of two writers, including errors and crashes in the middle of a write, can reach a bad state. Tests only try the orders someone thought of.

Bounds and assumptions: two writers, two entities, two contents per entity, at most five history rows, with no limit on the number of steps. SHA-256 is assumed never to give the same output for two different inputs. The database is assumed to give one writer at a time the write lock and to make a transaction all-or-nothing. `spec/README.md` lists what is left out.

## The one command

From the repo root:

```sh
bash spec/check.sh && npm ci && npx tsc --noEmit
```

`spec/check.sh` needs [mise](https://mise.jdx.dev), `curl` and Node. It installs the Java pinned in `.mise.toml`, downloads `tla2tools.jar` from the address pinned there into `~/.cache/ambitious/` and refuses it unless its SHA-256 matches the pin. It runs the model (must pass) and every variant in `spec/broken/` (each must break the rule named in `spec/broken/EXPECTED.json`). It takes under a minute and ends with a line that starts `OK:`.

## Covered code

Last confirmed in step with the code at commit `5f4d37d7690c7fce71d2c9b25835bf7cd576a121`. At that commit the storage code does not exist yet; the model describes the design in `spec/README.md` and the types in `src/domain/types.ts`.

| Model part | Code it describes |
|---|---|
| `Receive` | a write command (`program add`, `control add`, `evidence add`, `attest`, `doc record`) after it has parsed its input; `HistoryChange` |
| `Begin`, `lock`, `head` | the start of the write transaction, which takes the write lock at once, and the read of the last history row inside it; `ChainHead` |
| `AppendHistory`, `RowFor`, `Hash` | the insert into `history`; `HistoryEntry`, `HistoryEntryContent`, `PrevHash`, `GENESIS_PREV_HASH` |
| `UpdateProjection` | the write to the entity's current-state table in the same transaction; `Projection` |
| `Commit`, `receipts` | the commit, and the `{ entity, historySeq, hash }` the command returns; `WriteReceipt` |
| `Rollback` | any error or crash before the commit |
| `HistoryIsProtected`, `DeleteHistoryRow` | the triggers that abort `UPDATE` and `DELETE` on `history` |
| `ChainVerifies` | `verify-chain`; `ChainVerification` |
| `ProjectionMatchesLastEntry` | `rebuild` gives the same current-state tables as the ones already there |

Run `git log 5f4d37d7690c7fce71d2c9b25835bf7cd576a121..HEAD -- src spec migrations`. If it lists commits, read them against the table before you trust a pass. Move the commit above forward only after you have confirmed that every row still describes the code at the new commit.

One step in the model is one statement inside one transaction in the code, and everything from `Begin` to `Commit` is one transaction. If a write is ever split across transactions, or reads the last row before its transaction starts, the model no longer describes it; model the split before relying on a pass.

## Reading a result

If your agent setup has a `/statechart` skill for TLA+ models (one that runs the checker and reports each broken rule as its shortest path in plain words, and draws the states as a chart when the model passes), read every result with it. Refer to it by name; do not copy its commands here. Without it, read TLC's output directly as follows.

When a check fails, `spec/check.sh` prints TLC's full output. Find the line `Error: Invariant <Rule> is violated.`; the rule it names is the one that broke. Below it TLC prints the shortest path to the bad state as numbered states (shortened here to the last two):

```text
Error: Invariant ProjectionMatchesLastEntry is violated.
Error: The behavior up to this point is:
...
State 4: <AppendHistory(w1) line 67, col 3 to line 71, col 69 of module ProjectionOutsideTransaction>
/\ projection = (e1 :> None @@ e2 :> None)
/\ lock = w1
/\ history = << [ prev |-> <<>>,
     seq |-> 1,
     entity |-> e1,
     body |-> b1,
     hash |-> <<<<>>, [seq |-> 1, entity |-> e1, body |-> b1]>> ] >>
/\ receipts = {}
/\ pc = (w1 :> "to_commit" @@ w2 :> "idle")
...

State 5: <Commit(w1) line 80, col 3 to line 85, col 62 of module ProjectionOutsideTransaction>
/\ projection = (e1 :> None @@ e2 :> None)
/\ lock = None
/\ history = << [ prev |-> <<>>,
     seq |-> 1,
     ...
/\ receipts = {[seq |-> 1, hash |-> <<<<>>, [seq |-> 1, entity |-> e1, body |-> b1]>>]}
/\ pc = (w1 :> "to_project" @@ w2 :> "idle")
...
```

Each `State N` header names the step that led to that state and the writer that took it, and the lines under it give every variable after the step. Read down the list and compare each state with the one before: the variables that changed are what the step did. The last state breaks the rule. Write the path as one line per step before deciding anything. Here: writer 1 appends a history row for entity 1; it commits; the history now has a row for entity 1 but the current state has none.

To tell a path in the module's words:

- `history` is the history table, first row first. In a row, `prev` is `prev_hash`; a hash is written as the pair of the previous hash and the row's content, and `<<>>` is the starting value of an empty history.
- `projection` is the current-state tables: for each entity its current content, or `None` when it has no row.
- `lock` is the writer that holds the write lock, or `None`.
- `snapshot` is the database as it was when the open transaction began. While `lock` is not `None`, this is what readers see, and what `Rollback` goes back to.
- `pc` says what each writer does next: `to_begin`, `to_append`, `to_project`, `to_commit`, `to_reply`, or `idle`.
- `intent` is the change a writer was asked to make. `head` is the last row's `seq` and `hash` as that writer read them.
- `receipts` holds the `seq` and `hash` of every row whose write committed.

To run one model by hand and keep the output, from the repo root:

```sh
(cd spec/broken && mise exec -- java -cp ~/.cache/ambitious/tla2tools-*.jar tlc2.TLC -workers 1 -metadir "$(mktemp -d)" -noGenerateSpecTE -config ProjectionOutsideTransaction.cfg ProjectionOutsideTransaction.tla)
```

When the model passes, the `PASS` line gives the number of distinct states TLC checked. `spec/check.sh` fails if that number is too small for the model to be exploring anything.

## Real bug or modeling error

1. Replay the path against the real code, one statement per step, as a test with two database connections. If the code does the same, it is a real bug: report it with the path. Do not weaken the rule, and do not change product code unless asked.
2. If the code cannot take one of the steps, the model allows something the code forbids. Find the guard in the code, add it to the model, and say so in the pull request.
3. If a broken variant stops failing, or breaks a different rule, the model changed so that the rule can no longer catch that mistake. Treat that as a failure of the model.

## Changing things on purpose

- Change `spec/VersionHistory.tla` first, then make the same change in each file in `spec/broken/`, keeping only its own mistake. `check.sh` fails if a variant drifts further from the model, or uses other constants.
- A new rule needs a new broken variant that breaks it, an entry in `spec/broken/EXPECTED.json` and a row in `spec/README.md`. `check.sh` fails if a rule has no variant.
- To move to another TLC build, change `TLA2TOOLS_URL` and `TLA2TOOLS_SHA256` in `.mise.toml` together.
- Run the one command, then update the commit in "Covered code".
