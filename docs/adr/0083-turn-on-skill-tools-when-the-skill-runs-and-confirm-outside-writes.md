# ADR 0083: Turn on skill tools when the skill runs, and confirm outside writes

**Date**: 2026-10-03\
**Status**: Accepted\
**Related**: [ADR 0004 (Skill authoring style)](./0004-skill-authoring-style.md),
[ADR 0010 (Documentation scope)](./0010-documentation-scope.md),
[ADR 0077 (Keep a skill authoring guide in docs)](./0077-keep-a-skill-authoring-guide-in-docs.md),
[ADR 0086 (Post to GitHub bots without a confirm)](./0086-post-to-github-bots-without-a-confirm.md)

## Context

Skills such as `slice` run shell blocks with several commands to write to Linear and to set up
scratch directories. Shell in a skill has no tests, and each copy drifts on its own.

A tested tool can own those mechanics. Every active tool adds its description to each model request,
so a tool that only one skill uses costs context in every session.

An active tool can be called at any point, not only after the skill's preview. A skill's text alone
cannot stop a write to Linear or GitHub that the user never approved.

## Decision

A tool that serves one skill stays inactive until that skill runs. Before any write outside the
worktree, the tool itself asks the user with `ctx.ui.confirm`. Keeping the tool inactive until its
skill runs means only sessions that run the skill pay for the tool. Asking inside the tool means the
approval holds on every path that reaches the tool.

### Activation

- The tool's extension registers it with `defaultActive: false`.
- Tau's skill extension maps each skill name to its tools in code.
- Running `/<name>`, or a `read` of the skill's `SKILL.md`, turns the tools on for the next model
  request.

### Skill and tool

- A skill links its tool or template at the step that uses it.
- The tool's description holds its call contract: parameters, results, and errors. The skill says
  when to call the tool and what to do with the result, and does not repeat the contract.

### Writes outside the worktree

- A write outside the worktree is a write to Linear, GitHub, or any file outside the checkout.
- The tool shows the writes it plans and asks with `ctx.ui.confirm`.
- The tool writes nothing when the user declines, or when the session has no UI.

### Documentation

`docs/` also holds `tool-authoring.md`, a guide with a checklist for tool authors. This amends the
list of what `docs/` holds in ADR 0010. The skill guide links it and states no tool rules.

## Consequences

### Positive

- Sessions that never run a skill pay nothing for its tools.
- A write outside the worktree needs the user's yes, even when the model skips a step of the skill.

### Negative

- Typing `/skill:<name>` directly does not turn the tools on. Only `/<name>` does.
- Reading `SKILL.md` through `bulk_read` or `bash` does not turn the tools on.
- A session started with `--tools`, such as a Tau worker, treats that list as an allowlist. A skill
  tool there is either absent or active from the start.
- A session without UI, such as a worker, cannot make writes outside the worktree through these
  tools.

## Alternatives considered

### Shell blocks in the skills

Keep the shell blocks in the skills. Rejected because they stay untested, and the copies drift.

### Always-active skill tools

Register each skill's tool as always active. Rejected because every session pays for its
description, and the model can call it outside the skill.

### Approval through the skill's preview step

Rely on the skill's preview step for approval of writes outside the worktree. Rejected because a
model that skips the step would write without approval.
