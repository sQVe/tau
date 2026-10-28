# ADR 0061: Keep Tau config in a user file and a trusted repository file

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0027 (Share one delegate model across bounded tool tasks)](./README.md#retired),
[ADR 0041 (Default the delegate to gpt-6-luna)](./README.md#retired),
[ADR 0044 (Restore gpt-5.6-luna as the delegate default)](./README.md#retired),
[ADR 0047 (Default bundled worker profiles to Opus 5.5)](./README.md#retired),
[ADR 0063 (Narrow allowed models from the user file to the repository file)](./README.md#retired),
[ADR 0071 (Set worker models in the user config)](./README.md#retired),
[ADR 0072 (Keep model defaults out of code)](./README.md#retired),
[ADR 0085 (Group per-repository settings in the user config)](./README.md#retired),
[ADR 0095 (Keep repository routing in tracker config)](./README.md#retired),
[ADR 0099 (Warn on unknown config keys and fail only the entry in use)](./README.md#retired),
[ADR 0110 (Keep QA settings in a per-feature repository map)](./README.md#retired), the config parts
of
[ADR 0111 (Request review bots from config and skip the preview for a named change)](./0111-request-review-bots-from-config-and-skip-named-changes-in-pr.md)
and
[ADR 0116 (Name the mutation command in the repository file)](./0116-name-the-mutation-command-in-the-repository-file.md)\
**Related**:
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md)

## Context

Tau needs settings that a user sets once for every repository, and settings that a repository checks
in. Pi already layers its own settings this way, with `~/.pi/agent/settings.json` and a
`.pi/settings.json` that Pi reads only in a trusted project.

Every Tau checkout reads the same user file, including older checkouts in other worktrees. A newer
Tau must be able to add a key without breaking an older one.

A trusted repository may run code, but other people write its checked-in config for every user of
the repository. Models cost the user money and receive the user's data. Commands from config run on
the user's machine. Routes decide where Tau writes. The user must own those choices.

## Decision

Tau reads `<agentDir>/tau.json` and, in a project Pi trusts, `<cwd>/.pi/tau.json`. Each feature owns
one top-level key and validates it where it reads it. The user file owns every model, route, and
command from user config. The repository file holds only what belongs with the code.

### Files and trust

- `<agentDir>` is Pi's `getAgentDir()`, and `.pi` is Pi's `CONFIG_DIR_NAME`.
- Built-in defaults apply first, then the user file, then the repository file.
- Tau skips the repository file of an untrusted project, and the status output names the file.
- A missing file contributes nothing.

### Who may set each key

| Key             | User file | Repository file | Rule                                                                |
| --------------- | --------- | --------------- | ------------------------------------------------------------------- |
| `tdd`           | yes       | yes             | Per field; a list replaces the earlier list                         |
| `allowedModels` | yes       | yes             | Each file may only remove models from the list before it            |
| `mutation`      | no        | yes             | `argv` is the mutation command, beside the script it runs           |
| `subagents`     | yes       | no              | `capacity`, the live workers at once: an integer from 1 to 256      |
| `profiles`      | yes       | no              | Worker models and model routes                                      |
| `browser`       | yes       | no              | `loginCommand`, which the manager asks the user to run              |
| `tracker`       | yes       | no              | `agentTeam`, and `repositories` with a Linear route per entry       |
| `qa`            | yes       | no              | `repositories` with URL and test-account commands, and `dataWrites` |
| `reviews`       | yes       | no              | `repositories` with the review bots per entry                       |
| `fullCheck`     | yes       | no              | `repositories` with the full check command per entry                |

A key in the wrong file is an error. The error names the file and the file the key belongs in.
`tdd.verificationArgv` must start with `vitest`, the only runner Tau supports.

### Per-repository settings

- A feature that needs per-repository settings keeps its own map, `<feature>.repositories`, keyed by
  `owner/name`.
- A checkout's own features find their repository from the `origin` remote. Only an `origin` on the
  GitHub host, `github.com`, names one. A repository with the same `owner/name` on another host
  never gets another repository's entry.
- `reviews` is the exception. Its entries are keyed by the PR's base repository, not by `origin`.
- `qa.repositories.<owner/name>.dataWrites` is a boolean that defaults to false.
- Tau never runs `testAccountCommand`. The brief tells the worker to run it, so the password stays
  out of the manager context.
- Matching ignores case. Two keys for one repository that differ only in case are an error.
- A `reviews` bot's `login` is its GitHub login. It matches without regard to case or a trailing
  `[bot]`. Its `comment` is the exact body of the review request.
- One helper finds the entry for every feature, so the matching rules cannot drift.

### Models

- Tau's code names no model. Each model comes from a call argument or from the user file.
- A worker launch uses the launch `model`, then `profiles.<name>.model`, then
  `profiles.default.model`. Without any of them, the launch fails and names
  `profiles.default.model`. Profile files may not set `model:`.
- A worker's model is chosen once at launch. The `subagent` tool's model line is fixed for the
  session, so the prompt cache holds. The manager guidance says to use the profile default unless
  the user asks for another model or a multi-model discussion.
- A profile may have a `route`. It has a `question`, two `labels` that each hold a `criterion` and a
  `model`, and a `classifier` as `provider/model-id`. An optional `confidence` sets the least
  confidence that keeps the classifier's label.
- A profile with a `route` still needs its own `profiles.<name>.model`. That model runs when the
  classifier gives no confident answer.
- Web answers use `pi-web-access`'s own `fetch.answerModel`, unless the caller passes one.
- `allowedModels` limits every model Tau selects or passes on. Each file that sets it may only
  remove models from the list before it. Tau refuses a model outside the list, names the list and
  its files, and never falls back to another model.

### Unknown, removed, and bad keys

- Tau ignores an unknown key at any depth. It warns once per session with the file and the full key
  path.
- A removed or renamed key fails the feature that owned it. The error names the replacement.
- A wrong type or a missing required field fails only the entry being read. A bad `profiles.scout`
  blocks only `scout` launches.
- The config has no version field. The user writes it by hand, and an older checkout cannot read a
  newer version anyway.

## Consequences

### Positive

- A user sets defaults once, and a repository overrides only what belongs to its code.
- A repository cannot choose a model, a route, or a user command for the user.
- A newer Tau adds keys without breaking older checkouts, and one bad entry blocks only its own
  work.
- Each error names the file and the field to fix.

### Negative

- A misspelled key only warns, so the feature runs without it until the user reads the warning.
- A new user must set a launch `model`, or write `profiles.default.model`, before a worker starts.
- Each per-repository feature repeats `owner/name` keys in its own map.
- A team cannot share QA, review, or check settings through the repository.
- Replacing a `tdd` list means copying the earlier value to extend it.

## Alternatives considered

### Reject unknown keys

Reject unknown keys inside each block, or at every depth. Rejected because each new key would break
every older checkout that shares the user file.

### Let the repository file set models or commands

Let a repository file set `profiles` or `fullCheck`. Rejected because other people write that file,
and the user pays for the models and runs the commands.

### XDG folder, root `tau.json`, or `package.json`

Rejected because the XDG folder ignores `PI_CODING_AGENT_DIR`, so separate Pi setups and the
integration tests would share one file, the reason
[ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md) rejected XDG for records. XDG suits
tools that run under several agents, and Tau runs only in Pi. A root file skips Pi's project trust,
and repositories in Go or Lua have no `package.json`.
