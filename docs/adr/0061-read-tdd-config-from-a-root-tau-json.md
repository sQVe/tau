# ADR 0061: Read TDD config from a root `tau.json`

- Status: Accepted
- Date: 2026-09-28

## Context

- Advisory TDD classifies edits and fingerprints inputs with globs hardcoded for TypeScript and
  JavaScript under `src/`, `apps/`, `packages/`, `functions/`, and `infra/` (ADR 0023). Grove keeps
  its code in `internal/**/*.go` and `cmd/**/*.go`, so hints and `run_tests` freshness see none of
  it. Other repositories want to exclude part of `src/`, such as `src/components/**`.
- The config is written by the repository's owners and belongs in version control. `.tau/` holds
  state such as `.tau/state.json`, which stays out of version control, and Tau's own `.gitignore`
  ignores the whole folder.
- TDD is the first consumer. The formatter table (ME-368), a bash allowlist, and model settings may
  follow.

## Options considered

- `.tau/tdd.json`. Repositories that ignore `.tau/` would have to switch to `.tau/*` and add
  `!.tau/tdd.json` before Git tracks the file, and checked-in config would sit beside state that
  must never be checked in.
- A `tau.tdd` block in `package.json`. Grove and other Go or Lua repositories have no
  `package.json`, and adding one only for Tau is worse than a dedicated file.
- A root `tau.json` with a `tdd` block. It is visible, easy to check in, and works in any language.
  The next consumer adds a sibling key instead of a new file. Choose this option.

## Decision

Read an optional `tau.json` at the root of the working directory, and use only its `tdd` block.

### Format

- `tdd` may set `productionGlobs`, `testGlobs`, `testSupportGlobs`, `excludedGlobs`, and
  `verificationArgv`, the values the code already used.
- Each field that is set replaces its default. Fields that are not set keep their defaults. Lists do
  not merge, so excluding `src/components/**` means listing the default exclusions too.
- `verificationArgv` must start with `vitest` until other runners exist (ME-353, ME-354).
- A missing file means built-in defaults.

### Validation

- One loader reads and validates the file at the tool boundary and passes the parsed values into
  classification, fingerprints, and the runner. The pure code never reads the file.
- The schema rejects unknown keys at every level, so a misspelled field fails instead of being
  ignored.
- Invalid JSON, a wrong type, an unknown key, or an unreadable file is an error that names the file
  and the failing field. Tau never falls back to defaults or to the last valid config.
- A config error pauses hints and appends the error once to the tool result. It never blocks an
  edit. `run_tests` fails with the error instead of running with another config.
- Config changes hints and test execution only. Commit checks stay unchanged.

### Status

Each `run_tests` result shows the config source, or built-in defaults, and every effective value.

### Future consumer: model selection

When model settings move into `tau.json`, the precedence is: an explicit per-call override, then a
task-specific setting, then the shared delegate setting (ADR 0027), then the built-in default. An
invalid setting or unavailable model is an error and never falls through to another model. Model
settings are not part of this decision.

## Tradeoffs

- Grove and other non-Node repositories can set their source and test layout without editing Tau.
- Checking the config in needs no ignore-rule changes.
- A typo fails loudly, and the error says where to look.
- Cost: replacing a whole list means copying defaults to extend it. The effective config in
  `run_tests` output shows what applies.
- Cost: `tau.json` adds a file at the repository root, and each later consumer widens its schema.
- Cost: a `verificationArgv` without `--reporter=json` makes every run fail as an unreadable report.
- Cost: changing `tau.json` starts a new observation and forgets RED in the current cycle.

## See also

- [ADR 0023: Use advisory TDD observations instead of edit permissions](./0023-advisory-tdd-observations.md)
- [ADR 0027: Share one delegate model across bounded tool tasks](./0027-share-one-delegate-model.md)
- [ADR 0045: Keep worker records per Tau checkout and worktree files in `.tau/`](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)
- [ADR 0055: Record Tau coding conventions in `AGENTS.md`](./0055-record-tau-coding-conventions-in-agents-md.md)
