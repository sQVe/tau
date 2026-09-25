# ADR 0045: Keep worker records per Tau checkout and worktree files in `.tau/`

- Status: Accepted
- Date: 2026-09-24
- Supersedes: the report area rules in [ADR 0033](./0033-use-one-generic-native-worker-workflow.md)
  and [ADR 0037](./0037-launch-native-workers-without-parent-approval.md)

## Context

Every Tau checkout reads and writes the same `~/.pi/agent/tau/workers/`. Dev checkouts load their
own Tau through a project `.pi/settings.json`, and several branches change the record format at the
same time. On 2026-09-24, `abu-400` saved records with a field that main rejects. One such record
stopped launches, `subagent_history`, and status in every workspace.

Tau's other files have no fixed home. Non-Pi workers write reports to a folder the caller chooses.
Handoff briefs, which we keep, sit in `~/.cache/tau/handoffs/`. Leftover `.tau/` folders from older
Tau versions exist in some worktrees, and only Tau's own `.gitignore` ignores them.

[ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md) says which records Tau keeps. It
does not say where.

## Options considered

- Keep one shared folder and version the record format. Each branch must remember to bump the
  version, and parallel branches pick the same next number. Skipping unreadable records hides the
  failure but still drops the other branch's workers from history.
- Key records by Git branch. The branch of a checkout can change, and `npm:` or `git:` installs have
  no branch.
- Key records by the Tau checkout that wrote them. Branches never share records, and nothing needs a
  manual bump. Choose this option.

For the record root:

- `~/.local/state/tau/` follows XDG for state files. It ignores `PI_CODING_AGENT_DIR`, so separate
  Pi agent directories, such as `~/.pi/agent-work` and the integration tests' temporary ones, would
  share records.
- `<agentDir>/tau/`, where `agentDir` is Pi's `getAgentDir()`, follows `PI_CODING_AGENT_DIR`. Pi
  keeps its own sessions in the same directory. Choose this option.

## Decision

Tau keeps its files in two homes. Worker records live under Pi's agent directory, in a folder per
Tau checkout. Files about one worktree live in that worktree's `.tau/`.

### Worker records

Store records and Pi worker transcripts in `<agentDir>/tau/<checkout>/workers/<taskId>/`. Launch,
history, status, and follow-up read only the current checkout's folder.

Derive `<checkout>` from the realpath of the Tau package root that holds the loaded extension
module. Name the folder `<basename>-<hash>`, where the hash is the first 8 hex digits of the SHA-256
of that realpath. The `main` checkout keeps one folder because its path does not change when it
pulls or switches commits. The hash separates two checkouts with the same basename and keeps the new
folders apart from the old `workers/` folder.

Leave records in `<agentDir>/tau/workers/` in place. Tau does not read, migrate, or delete them.

### Worktree files

A `.tau/` folder sits at the root of the directory Tau works in, normally the worktree root. It
holds two things:

- `.tau/workers/<taskId>/report.md`: the report of a non-Pi worker, at a fixed path under the
  worker's cwd. Tau creates the folder before launch. The `subagent` tool no longer takes
  `reportDirectory`.
- `.tau/handoffs/`: the messages this worktree's agent sends with the handoff skill. Messages are
  one-way. Replies went to the sender's pane, and when that pane had closed, the receiver guessed
  another pane in the workspace. One reply reached an unrelated session and took the place of its
  user's message. Most handoffs need no reply.

Before writing into `.tau/`, Tau and the handoff skill make sure `.tau/.gitignore` has a `*` line,
and add it when missing. Tau refuses a `.tau/` or `.tau/workers/` that is a symbolic link, so it
never writes outside the worktree. The folder stays out of Git in any repository, without edits to
the repository's `.gitignore`, `.git/info/exclude`, or the user's global excludes. Tau writes
nothing else in a worktree and nothing under `~/.cache/tau/`.

### Non-Pi worker sandboxes

Non-Pi workers write reports under their cwd today, and `.tau/workers/<taskId>/` is also under their
cwd. A harness that allows writes inside its cwd can therefore write the report. Codex's
`workspace-write` mode allows writes in cwd and mounts `.git` read-only, which does not cover
`.tau/`. Codex in an untrusted directory defaults to read-only and cannot write any report, as
today. Using the worker's cwd, not the Git top level, keeps the report inside the sandbox when the
worker starts in a subdirectory.

## Tradeoffs

- A record written by one checkout can never break another checkout's launch, history, or status.
- No one has to remember a format version.
- Separate Pi agent directories keep separate records.
- Reports and handoffs stay next to the work they describe, and none of them show in `git status`.
- Cost: workers launched from a dev checkout do not appear in main's `subagent_history`. Main could
  not read them anyway.
- Cost: moving or renaming a checkout starts an empty history. Its old records stay on disk unread.
- Cost: the key separates checkouts, not versions. An `npm:` or `git:` install keeps one path across
  updates, so it still depends on skipping unreadable records after a format change.
- Cost: `<agentDir>` mixes Tau's state with Pi's configuration and ignores XDG.
- Cost: a harness running read-only, or one that later protects `.tau/`, cannot write its report.
  The worker then fails as it would with no report today.
- Cost: a worker started in a subdirectory leaves its report in that subdirectory's `.tau/`, not at
  the worktree root.

## See also

- [ADR 0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md)
- [ADR 0037: Launch native workers without parent approval](./0037-launch-native-workers-without-parent-approval.md)
- [ADR 0043: Own only the worker guarantees herdr lacks](./0043-own-only-the-worker-guarantees-herdr-lacks.md)
- [Codex sandbox](https://github.com/openai/codex/blob/13c42a077c88a0d04ae7680a9891d2daf4558577/docs/sandbox.md)
  and [issue 14338](https://github.com/openai/codex/issues/14338) on the read-only `.git` mount
