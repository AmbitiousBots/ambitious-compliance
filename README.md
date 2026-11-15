# ambitious-compliance

The compliance module tracks controls, evidence and attestations for a small business in one SQLite file, with an append-only, hash-chained version history so every change has an actor, a reason and a verifiable record. It uses no git storage. Documents are kept in Grok Bot Pages, and the module stores their references and content hashes. It is a command-line tool with JSON in and JSON out and no UI.

The module follows the shared module contract, [MODULE_CONTRACT.md](https://github.com/AmbitiousBots/ambitious-kit/blob/main/MODULE_CONTRACT.md) in ambitious-kit: one command-line binary, JSON in and a JSON envelope out, one SQLite file, deterministic with `--now` and `--seed`, no network except keyed AI calls.

Part of [Ambitious](https://ambitiousbots.com). Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
