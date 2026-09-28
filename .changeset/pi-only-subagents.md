---
'tau': minor
---

Run subagents only as Pi workers. Claude and GPT models still run as Pi workers through Pi's
providers. Send work for Claude Code or Codex to that agent's workspace with the handoff skill.

The `subagent` tool no longer takes `harness`, `nativeArguments`, or `permissions`. Replies always
need a `questionId`, and `subagent_status` no longer takes `submissionId` or `readOutput`. A profile
that sets `cli:` to anything other than `pi` now fails with a message that non-Pi workers are no
longer supported. Saved non-Pi tasks are skipped with the same message and do not block other tasks.
