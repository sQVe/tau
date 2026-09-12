# ADR 0015: Explicit repository commit commands

- Status: Proposed
- Date: 2026-09-10

## Context

Repositories use different tools. Discovering commands through package manifests, package-manager
rules, or hook formats ties Tau to particular ecosystems and can select the wrong command. The
repository owner knows which commands to run.

Formatting hooks can rewrite approved content. The commit tool then undoes the commit, requiring
another check, review, and approval. Preparation before review avoids that retry. Checks must still
validate the staged content, not unrelated working changes.

## Options considered

- Discover commands from package scripts or hooks. Requires ecosystem-specific rules and can run
  unrelated actions.
- Let repository owners configure executable and argument arrays. Makes command selection explicit
  without requiring Tau to understand the build system.
- Keep preparation in hooks. Preserves the undo-and-retry cycle when hooks rewrite approved content.

## Decision

Repository owners choose commit commands in a version-controlled `tau.json` at the Git root. The
commit tool requires a Git repository; outside one, it rejects the call before running commands or
changing files. Nested directories do not define separate commit configuration.

Use optional `prepare` and `check` executable/argument arrays without an implicit shell. Explicit
arguments avoid shell quoting rules and ecosystem-specific command discovery. Do not infer commands
from package scripts, package managers, or Git hooks. Missing commands mean unavailable validation
or preparation, not permission to invent a fallback.

The commit tool owns command execution, not the agent. Working configuration selects preparation;
staged configuration selects checks. This prevents unrelated working changes from weakening
validation of the proposed commit. Invalid or unknown settings must fail rather than silently
disable a command through a typo. Reject the unshipped `fix` key with a migration error.

Keep human Git hooks independent. Configured commands do not replace review, approval, or the
post-commit content and path guards.

Limit this change to configuration. Retain once-per-call preparation before staging; moving it
requires a separate decision about generated and unrequested changes. Formatting on edit is also
separate. Reserve and reject `checkMessage` and `hooks` until their behavior is implemented. Their
later contract is optional message-check argv and `hooks: run|skip`, defaulting to `run`.

## Tradeoffs

- Owners must configure commands, but Tau does not need ecosystem-specific discovery rules.
- Preparation can still invalidate earlier TDD evidence and change unrequested working files. Those
  files stay outside the commit unless requested.
- Preparation must be safe to rerun; Tau does not undo its working changes.
- Command selection is ecosystem-neutral, but dependency sharing is not: existing optional
  `node_modules` sharing remains. General dependency setup is outside this decision.

## See also

- [Checks in the existing checkout](./0020-checks-in-the-existing-checkout.md) replaces temporary
  checkouts and dependency sharing.
