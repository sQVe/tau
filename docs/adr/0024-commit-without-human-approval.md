# ADR 0024: Commit through Git hooks, without approval or Tau checks

**Date**: 2026-09-15\
**Status**: Accepted\
**Supersedes**: [ADR 0011 (Commit preapproval at startup)](./README.md#retired),
[ADR 0015 (Explicit repository commit commands)](./README.md#retired),
[ADR 0016 (Prepare each commit with separate staging)](./README.md#retired),
[ADR 0017 (Ask before adding generated files)](./README.md#retired),
[ADR 0018 (Repository owners choose commit checks and hooks)](./README.md#retired),
[ADR 0019 (Verify backups before hiding working edits)](./README.md#retired),
[ADR 0020 (Run staged checks in the existing checkout)](./README.md#retired),
[ADR 0021 (Prune recovery snapshots after verified restoration)](./README.md#retired),
[ADR 0025 (Use Git hooks without preparation)](./README.md#retired),
[ADR 0026 (Let Git hooks own commit checks)](./README.md#retired),
[ADR 0038 (Block commits only on comment inaccuracies)](./README.md#retired),
[ADR 0042 (Remove commit comment review)](./README.md#retired),
[ADR 0049 (Treat the bash commit guard as guidance)](./README.md#retired)\
**Related**: [ADR 0108 (Make Linear writes on the user's own work without asking)](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)

## Context

Agents commit through Tau's `commit` tool. Earlier versions of the tool asked a person to approve
each commit, ran Tau's own preparation and check commands, hid working edits behind recovery
archives, and asked a model to review comments before Git ran. Each layer added a second policy
beside the repository's Git hooks and a failure path that only Tau had.

Unattended workers have no person to approve a screen. A terminal UI does not prove that a person is
present. Repository owners already express commit policy in Git hooks, and human commits use the
same hooks.

Agents also run `git commit` through bash by habit. A guard that steers them to the tool should not
block commands that only mention a commit in data, such as a `gh pr create` body.

## Decision

Tau commits through installed Git hooks on the real index, with no human approval, no Tau-run
project checks, and no model review. The hooks run the repository's checks, so Tau and human commits
pass the same hook policy. Every failure returns one error and one retry path.

Commits stay in the local repository. They are outside the approval rule in ADR 0108 for writes that
other people see.

### Request checks

Before Git commits, Tau checks each group's message, its paths, and which group owns each path. Each
group also checks that no unrelated path is staged and that a fixup target is an ancestor of HEAD.
Tau runs no other checks of its own.

### Staging and hooks

- Stage the requested files directly on the real index. Do not copy or hide working files, and do
  not create recovery archives.
- Refuse the call when a path the call did not request is already staged.
- Keep requested paths that were staged before the call staged. On failure, restore their earlier
  index entries, and unstage only the paths that the call staged.
- Run commit groups in order, because an earlier hook may change what a later group sees. Stop at
  the first failed group, and report the commits already made. A group with no staged changes fails.
- Never bypass hooks. Tau does not read commit policy from `tau.json`.
- Report each path that a hook changed or added, and any message change that a hook made. Warn when
  a commit includes a sensitive path. Never undo a successful commit.
- On hook failure, return the hook output without terminal control sequences or lint-staged progress
  lines. Leave staging alone when HEAD changed during the call.

### Failures reach the agent

A failed hook or message check returns a tool error. The agent fixes the request and makes a new
call. There is no approval overlay, message editor, startup flag, or review waiver.

### Comments

The tool makes no model call. Wrong comments are left to code review and pull request review. The
comment rules live in the coding instructions and the `prune-comments` skill, not in the commit
tool.

### Bash guard

The bash guard steers agents to the `commit` tool. It is guidance, not a security boundary.

- Block `git commit` and other subcommands that start with `commit`, such as `commit-tree`. Block it
  where the shell runs it directly, and in text that a shell or Git runs as code.
- Let quoted words, comments, and heredoc bodies pass as data, unless the command runs git or a
  shell. If any part of a command runs a shell, check every part.
- When a command does not parse, match the stricter regex. It matches `git` and `commit` in one
  statement, so it also blocks mentions in quoted text.
- Accept known bypasses, such as variable indirection (`c=commit; git $c`) and commands that run Git
  through another interpreter.
- Some false positives remain, such as `git log --grep commit` and `git log --format='git commit'`.

## Consequences

### Positive

- Repository owners keep one commit policy for Tau and for people.
- Workers never wait for approval, and every failure reaches the agent as a tool error.
- Successful formatter hooks do not cost another call.
- Commits make no model call.

### Negative

- Users do not inspect or edit a commit before it lands.
- Hooks run in the same checkout, so they see unrelated working edits. Concurrent staging of the
  same requested paths is not supported.
- Hooks can add changes to a commit. Tau reports them but does not block them.
- Inaccurate comments can land until review catches them.
- An agent that tries to evade the bash guard can commit without the tool.

## Alternatives considered

### Approval with a startup flag

Ask a person to approve each commit, and let a launcher flag skip the prompt for workers. Rejected
because it keeps two execution paths and needs launcher setup for unattended work.

### Tau-owned preparation and checks

Run configured preparation and check commands in a temporary index, with verified backups of hidden
working edits. Rejected because it duplicates Git hooks, and the backup and restore rules grew
larger than the commit itself.

### Model review of comments before hooks

Block commits on a model's comment findings, with bounded retries. Rejected because it blocked
checked, passing commits over comment wording, and code review already catches wrong comments.

### Reject hook rewrites

Fail the call when a hook changes the committed content. Rejected because it treats successful
formatting as failure.

### Guard as a security boundary

Parse every shell form that can run `git commit`. Rejected because the shell offers too many forms,
and the guard only needs to stop accidental use.
