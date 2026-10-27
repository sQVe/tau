# ADR 0043: Run subagents as Pi workers with a thin task layer over herdr

**Date**: 2026-09-24\
**Status**: Accepted\
**Supersedes**: [ADR 0028 (Keep worker control in the parent)](./README.md#retired),
[ADR 0029 (Version worker provider fingerprints)](./README.md#retired),
[ADR 0030 (Claim native follow-ups before opening)](./README.md#retired),
[ADR 0031 (Reserve worker capacity under one tree lock)](./README.md#retired),
[ADR 0032 (Run Claude workers through a parent-owned channel)](./README.md#retired),
[ADR 0033 (Use one generic native worker workflow)](./README.md#retired),
[ADR 0037 (Launch native workers without parent approval)](./README.md#retired),
[ADR 0040 (Release undispatched follow-up claims after confirmed cleanup)](./README.md#retired),
[ADR 0045 (Keep worker records per Tau checkout and worktree files in `.tau/`)](./README.md#retired),
[ADR 0050 (Split worker control into a coordinator and one controller per worker)](./README.md#retired),
[ADR 0054 (Show one foreground worker per parent)](./README.md#retired),
[ADR 0058 (Run subagents only as Pi workers)](./README.md#retired),
[ADR 0059 (Run each Pi worker as its pane's own process)](./README.md#retired)\
**Related**: [ADR 0036 (Allowlist worker content and label states from one table)](./0036-allowlist-worker-content-and-label-states-from-one-table.md),
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0064 (Deliver worker replies through records)](./0064-deliver-worker-replies-through-records.md),
[ADR 0067 (Give workers only their profile's tools and skills)](./0067-give-workers-only-their-profile-tools-and-skills.md),
[ADR 0071 (Set worker models in the user config)](./0071-set-worker-models-in-the-user-config.md),
[ADR 0097 (Track only the current session's workers)](./0097-track-only-the-current-sessions-workers.md),
[ADR 0102 (Require acceptance criteria on editing worker launches)](./0102-require-acceptance-criteria-on-editing-worker-launches.md)

## Context

A parent Pi session starts workers to investigate, edit, and review. Herdr already launches agents,
delivers text, reports live state and session identity, and splits and closes panes. It cannot say
that a task finished, carry a structured question to the parent, enforce a deadline, stop an agent,
or choose placement.

Tau first owned much more: replay of the parent's runtime settings, nested workers, a cross-process
capacity lock, follow-up claim files, a generic workflow for Claude Code and Codex, and workers
typed into an interactive shell. Session logs showed that these guarantees caused most failures.
Settings replay refused workers on the user's default provider. Ownership kept in parent memory was
lost on restart. Shell-typed workers left panes open, and stop keys did not stop Pi. Non-Pi workers
needed a second lifecycle with weaker guarantees.

## Decision

Tau-owned subagents run only as Pi workers. Tau owns only what herdr lacks: task records, a
completion report, structured questions, one deadline per task, stopping, placement, and the widget.
One lifecycle with few guarantees removes most refusal and cleanup paths and keeps the report
contract.

### Workers are Pi processes

- A worker's model is a Pi `provider/id`. Work for Claude Code, Codex, or another agent goes to that
  agent's workspace through a handover, which is not a subagent.
- A profile with a `cli:` value other than `pi` is invalid.
- Every worker uses the trusted full-tool permission, with CC Safety Net loaded. Roles describe the
  assigned work, not security boundaries.

### Settings

Start each worker with explicit settings: the requested or profile model as `provider/id`, and the
user's saved Pi configuration. Do not reconstruct or fingerprint the parent's runtime settings. The
worker refuses to start when its model does not resolve or CC Safety Net is not loaded. It never
falls back to another model.

### Nesting and capacity

Workers do not launch workers; they ask the parent. Each parent caps its own live workers in
process. There is no cross-process lock or durable reservation.

### Process and pane

- Create each worker with herdr `layout.apply` and a single-pane root. The root's command is the
  absolute `pi` executable, and its cwd and environment go in the same request. Never pass `tab_id`,
  because herdr would replace that tab.
- The worker environment is the parent's environment without `PWD` and `OLDPWD`, plus
  `TAU_WORKER_RECORD`. Herdr then sets the pane's own `HERDR_*` identity.
- The pane lives as long as its Pi process. A finished worker exits by itself. To cancel or enforce
  the deadline, the parent checks the terminal, process identity, and Pi session in herdr, then
  closes the pane. It never types into a worker.

### Placement

- Editing workers default to foreground. Investigation workers default to background.
- A parent shows at most one foreground worker. Further launches go to the background worker tab,
  even when they ask for foreground.
- A foreground worker splits beside the parent when both panes stay useful. A zoomed or too small
  parent pane sends it to a background tab instead.
- Placement is serialized. Herdr owns the layout after placement, and Tau does not rebalance it.
- The launch result reports the placement used, and the reason when it differs from the request.

### Ownership, cleanup, and follow-ups

- Ownership is saved in the task record. A restarted parent session reattaches to a live worker
  after herdr reports the recorded session identity. One controller acts per task.
- When cleanup cannot be confirmed, show the worker as needing manual cleanup and free its capacity.
- A follow-up needs a saved report on its source task, confirmed cleanup of that task, and no
  successor. A successor that Tau confirmed stopped before dispatch does not count. Herdr must also
  show no live agent on the saved session. The single controller serializes these checks, so there
  are no claim files.
- A follow-up resumes the predecessor's Pi session file. That file stays in the predecessor's task
  directory, and the follow-up's record names it.

### Where records live

Store task records and worker transcripts in `<agentDir>/tau/<checkout>/workers/<taskId>/`.
`<agentDir>` is Pi's agent directory, so it follows `PI_CODING_AGENT_DIR`. `<checkout>` is the
basename of the Tau package root, a dash, and the first 8 hex digits of the SHA-256 of its realpath.
Each checkout reads only its own folder, so a branch that changes the record format cannot break
`main`. Tau does not read, migrate, or delete records in the older `<agentDir>/tau/workers/` folder.

## Consequences

### Positive

- Most logged launch refusals and lost-ownership failures go away.
- A finished or stopped worker leaves no pane behind, whatever the user's shell is.
- Users see one worker pane at a time, and the launch result says where the worker is.
- Cancellation and replies survive a parent restart in the same session.

### Negative

- A worker does not inherit runtime-only parent settings, such as a `--model` flag.
- An unconfirmed worker may keep running outside the cap until the user stops it.
- A Pi process started by hand on a saved session can race a follow-up.
- Delegation from a worker goes through the parent.
- Herdr has no CLI for `layout.apply`, so Tau uses its socket, and a new tab can flash during
  placement.
- Moving or renaming a Tau checkout starts with no records.

## Alternatives considered

### Keep the earlier guarantees

Keep settings replay, nesting, claim files, and the capacity lock, and fix defects as they appear.
Rejected because each fix added states, and most logged failures came from the guarantees.

### Raw herdr agents

Start agents with herdr alone. Rejected because they have no deadline, report, or widget.

### A generic workflow for non-Pi agents

Run Claude Code and Codex as subagents through one generic herdr workflow. Rejected because it needs
a second lifecycle with weaker guarantees, and a handover already reaches those agents.

### Workers typed into an interactive shell

Type a `pi` command into a new pane's shell. Rejected because launch and stop then depend on the
user's shell setup, which Tau does not control.

### One shared record folder with a version

Keep one record folder for every checkout and rely on format versions. Rejected because parallel
branches change the format at the same time and break each other's launches.

### Records keyed by Git branch

Key records by Git branch. Rejected because the branch of a checkout can change, and `npm:` or
`git:` installs have no branch.

### A state folder under XDG

Use `~/.local/state/tau/` as the record root. Rejected because it ignores `PI_CODING_AGENT_DIR`, so
separate Pi agent directories would share records.
