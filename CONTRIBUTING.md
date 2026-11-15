# Contributing

Ambitious Compliance records programs, controls, evidence, attestations and document references through a JSON command line. Contributions should preserve the module's deterministic output and append-only history.

Discuss a new behavior in an issue before a large change. For a bug fix, include a small reproduction using invented records. Do not include credentials, private documents or database copies from real organizations.

## Local development

Install [mise](https://mise.jdx.dev), which manages the tool versions in `.mise.toml`, then run these commands from the repository root.

```sh
mise trust -q .
mise install -q
mise exec -- npm ci
mise exec -- npm run release:check
mise exec -- verify/run
```

The kit packages are checksum-verified release archives in `vendor/`. Runtime releases bundle them into one file. The tests use temporary databases and fixed clocks. The optional integration test downloads a checksum-verified tasks release; it reports a skip while that release is unavailable.

## Changes and review

Keep input parsing in `src/cli/`, pure behavior in `src/domain/`, SQLite access in `src/db/`, and any network adapters in `src/ai/`. This module currently makes no network calls. Follow [AGENTS.md](AGENTS.md) and the linked module contract in [README.md](README.md).

Start with types and API behavior, then run lint and dependency checks before the behavioral tests. A storage change must preserve earlier history values, transaction atomicity and projection replay. Released migrations are immutable; add a forward migration and a test that preserves existing rows. A change to ordering or transactions must also be checked against the TLA+ model.

Keep tests focused on results a caller can observe. Update the command documentation and `verify/features.json` when behavior changes. Run `npm outdated` and `npm audit` before a pull request, and explain any retained version in the pull request's Decisions section.

Use the pull request template to state the user benefit, changes, actual verification output and design decisions. Contributions are licensed under the repository's [Apache License 2.0](LICENSE).
