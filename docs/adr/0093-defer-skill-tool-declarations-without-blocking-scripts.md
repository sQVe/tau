# ADR 0093: Defer skill tool declarations without blocking scripts

**Date**: 2026-10-06\
**Status**: Accepted\
**Supersedes**: [ADR 0083 (Turn on skill tools when the skill runs, and confirm outside writes)](./0083-turn-on-skill-tools-when-the-skill-runs-and-confirm-outside-writes.md),
activation only

## Context

Skill text can remain in context after Pi reloads or resumes, while the active tool list resets.
Reading another checkout's copy of a skill also misses activation tied to the loaded file's path.
Scripts then cannot call inactive direct tools, even though the skill tells them to do so.

Declaring every skill tool in every session would spend context on tools the session does not use.
Tool availability must not depend on how the skill started.

## Decision

Register skill tools with `exposure: 'deferred'`, so scripts can reach them without activation. Pi
omits deferred tools from the codemode description and from model declarations until activated. Keep
command and loaded-file read activation to declare tools for direct model calls.

This replaces only ADR 0083's activation policy. Writes outside the worktree remain guarded by
`ctx.ui.confirm` inside the tools, with the existing exception for GitHub bot writes. Availability
through scripts does not bypass those checks.

When a failed codemode result names a missing skill tool, append the skill command and explain that
a session started with `--tools` must include the tool in that list.

## Consequences

### Positive

- Scripts can call registered skill tools after reload or resume, after any skill read, or without
  activation.
- Sessions omit unused skill tool declarations and codemode listings.
- Missing-tool errors give a recovery action without replacing the original error.

### Negative

- A script can call a skill tool before the skill runs; write safety remains the tool's
  responsibility.
- Explicit `--tools` allowlists can still exclude a tool and need a session configuration change.

## Alternatives considered

### Restore active tools and match reads by skill name

Restore active tools after reload and recognize other copies of SKILL.md by skill name. Rejected
because this adds more mechanisms and still misses paths that do not activate the skill.

### Use codemode exposure

Register skill tools with `exposure: 'codemode'`. Rejected because this lists every skill tool in
the codemode description in every session.
