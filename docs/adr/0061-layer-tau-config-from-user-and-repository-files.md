# ADR 0061: Layer Tau config from user and repository files

- Status: Accepted
- Date: 2026-09-28

## Context

- Advisory TDD classifies edits and fingerprints inputs with globs hardcoded for TypeScript and
  JavaScript under `src/`, `apps/`, `packages/`, `functions/`, and `infra/` (ADR 0023). Grove keeps
  its code in `internal/**/*.go` and `cmd/**/*.go`, so hints and `run_tests` freshness see none of
  it. Other repositories want to exclude part of `src/`, such as `src/components/**`.
- Tau needs settings a user sets once for every repository, and settings a repository checks in that
  override them. TDD is the first consumer. The formatter table (ME-368), a bash allowlist, and
  model settings may follow.
- Pi layers its own settings the same way: `~/.pi/agent/settings.json`, overridden by
  `.pi/settings.json`. Pi's extension guide places project config at
  `<cwd>/<CONFIG_DIR_NAME>/<name>.json` and reads it only when `ctx.isProjectTrusted()` holds.
  pi-claude-bridge follows it with `<agentDir>/claude-bridge.json` and `.pi/claude-bridge.json`.
- `.tau/` holds state that stays out of version control, and Tau's own `.gitignore` ignores the
  whole folder.

## Options considered

- `$XDG_CONFIG_HOME/tau/` for the user file. It ignores `PI_CODING_AGENT_DIR`, so separate Pi setups
  and the integration tests would share one file, the reason ADR 0045 rejected XDG for records.
  Tools that run under several agents, such as ponytail, use XDG; Tau runs only in Pi.
- A root `tau.json` or `.tau/tdd.json` for the repository file. The first departs from Pi's
  extension convention and skips project trust. The second sits among ignored state and needs
  ignore-rule changes before Git tracks it.
- A `tau.tdd` block in `package.json`. Go and Lua repositories have none.
- A config-loading library such as cosmiconfig or lilconfig. Tau reads two fixed paths, and
  validation and error wording would still be ours. Many of them can load JS config, which runs
  repository code.
- `<agentDir>/tau.json` overridden by `.pi/tau.json`, as Pi and its extensions do. Choose this
  option.

## Decision

Read Tau config from `<agentDir>/tau.json` and `<cwd>/.pi/tau.json`. Built-in defaults apply first,
the user file overrides them, and the repository file overrides both. `<agentDir>` is Pi's
`getAgentDir()`, and `.pi` is Pi's `CONFIG_DIR_NAME`.

### Format and precedence

- Both files share one schema. Each consumer owns a top-level key. TDD owns `tdd`, which may set
  `productionGlobs`, `testGlobs`, `testSupportGlobs`, `excludedGlobs`, and `verificationArgv`.
- Precedence works per field. A list replaces the earlier one instead of extending it, so excluding
  `src/components/**` means listing the default exclusions too.
- `verificationArgv` must start with `vitest` until other runners exist (ME-353, ME-354).
- A missing file contributes nothing.

### Trust

Tau reads `.pi/tau.json` only when Pi trusts the project, as Pi does for `.pi/settings.json`. An
untrusted project's file is skipped, and the status output names it.

### Validation

- One loader reads and validates both files at the tool boundary. A pure function merges the layers,
  and the parsed values go into classification, fingerprints, and the runner.
- The schema rejects unknown keys inside `tdd`, so a misspelled field fails instead of being
  ignored. It ignores unknown top-level keys, because every Tau checkout reads the same user file
  and an older one must not reject a key a newer consumer added.
- Invalid JSON, a wrong type, an unknown `tdd` key, or an unreadable file is an error that names the
  file and the failing field. Tau never skips the broken layer or falls back to defaults.
- A config error pauses hints and appends the error once to the tool result. It never blocks an
  edit. `run_tests` fails with the error instead of running with another config.
- Config changes hints and test execution only. Commit checks stay unchanged.

### Status

Each `run_tests` result shows every effective value and the file, or built-in default, it came from.

### Future consumer: model selection

When model settings join this config, the precedence is: an explicit per-call override, then a
task-specific setting, then the shared delegate setting (ADR 0027), then the built-in default. The
user and repository layers decide the task and shared settings. An invalid setting or unavailable
model is an error and never falls through to another model. Model settings are not part of this
decision.

## Tradeoffs

- A user sets defaults once, and a repository overrides only what differs.
- Grove and other non-Node repositories can set their layout without editing Tau.
- The files sit where Pi users already look, and the repository file follows Pi's trust prompt.
- A typo fails loudly, and the error says which file to fix.
- Cost: replacing a whole list means copying the earlier value to extend it. The status output shows
  what applies.
- Cost: a misspelled top-level key, such as `tddd`, is ignored. The status output then shows only
  built-in defaults.
- Cost: in an untrusted project, the repository file has no effect beyond a note in the status
  output.
- Cost: a `verificationArgv` without `--reporter=json` makes every run fail as an unreadable report.
- Cost: changing either file starts a new observation and forgets RED in the current cycle.

## See also

- [ADR 0023: Use advisory TDD observations instead of edit permissions](./0023-advisory-tdd-observations.md)
- [ADR 0027: Share one delegate model across bounded tool tasks](./0027-share-one-delegate-model.md)
- [ADR 0045: Keep worker records per Tau checkout and worktree files in `.tau/`](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)
- [ADR 0057: Enforce pure decision modules from a registry](./0057-enforce-pure-decision-modules-from-a-registry.md)
