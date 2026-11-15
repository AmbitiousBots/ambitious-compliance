# ambitious-compliance

The compliance module tracks controls, evidence and attestations for a small business in one SQLite file, with an append-only, hash-chained version history so every change has an actor, a reason and a verifiable record. It uses no git storage. Documents are kept in Grok Bot Pages, and the module stores their references and content hashes. It is a command-line tool with JSON in and JSON out and no UI.

The module follows the shared module contract, [MODULE_CONTRACT.md](https://github.com/AmbitiousBots/ambitious-kit/blob/main/MODULE_CONTRACT.md) in ambitious-kit: one command-line binary, JSON in and a JSON envelope out, one SQLite file, deterministic with `--now` and `--seed`, no network except keyed AI calls.

Part of [Ambitious](https://ambitiousbots.com). Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Formal model

The rules of the version history (committed rows are never lost, the current state always matches the last history row, the hash chain always verifies) are checked for every interleaving of two concurrent writers by a TLA+ model in [`spec/`](spec/README.md). Run it with `bash spec/check.sh`. [`verify/formal/SKILL.md`](verify/formal/SKILL.md) tells an agent or a contributor when to rerun it and how to read a failure. The domain types the storage code will build on are in [`src/domain/types.ts`](src/domain/types.ts).
