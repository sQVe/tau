# ADR 0093: Enable skill tools from session start

**Date**: 2026-10-06\
**Status**: Accepted\
**Supersedes**: [ADR 0083 (Turn on skill tools when the skill runs, and confirm outside writes)](./0083-turn-on-skill-tools-when-the-skill-runs-and-confirm-outside-writes.md),
activation only

## Context

Tool availability must not depend on how a skill started. A skill can run through a command, a file
read, or text kept after reload or resume. Activation tied to a command or one file path misses
other entry paths.

The Claude bridge keeps the running query's tool list. Codemode fixes a script's callable tools when
the script starts. Turning a tool on during either operation is too late. Workers also use a startup
allowlist, so activation cannot add a tool that the worker never registered.

## Decision

Register skill tools as active direct tools from session start, with every skill tool available to
managers and only loaded skills' tools added to workers. This makes availability independent of
provider snapshots and skill entry paths.

A shared map links skill names to registered tools. Workers derive skill names from their saved
SKILL.md paths and use the same tool list for launch and runtime checks. The saved loadout format
stays unchanged.

This replaces only ADR 0083's activation policy. Its confirm rule still holds, with the existing
exception for GitHub bot writes. A step that needs the user's confirmation refuses in a worker, even
though a worker's pane has UI, before any remote write or local record change. The user does not
watch a worker's pane, so a confirm there could approve a write that nobody saw.

## Consequences

### Positive

- Managers can call skill tools directly or from scripts on their first request, without a skill
  command or read.
- Workers can call loaded skills' tools from their first request without gaining other skill tools.
- Reload and resume need no skill-tool activation state to restore.

### Negative

- Every manager request carries the five skill tool declarations, even when it uses no skill.
- A tool can run before its skill. Tools must enforce write confirmation themselves.

## Alternatives considered

### Turn tools on when the skill runs

Keep command-time and file-read activation. Rejected because bridge queries and running scripts keep
earlier tool snapshots. Other skill entry paths silently miss activation.

### Use deferred exposure

Register skill tools with `exposure: 'deferred'`. Rejected because scripts can reach them, but
direct calls on the bridge still miss them until the next user message.

### Refresh the bridge's query tools

Change the bridge to refresh its tools during a query. Rejected because this is outside Tau and does
not cover scripts or worker startup allowlists.
