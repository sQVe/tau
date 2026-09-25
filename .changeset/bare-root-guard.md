---
'tau': patch
---

Keep agents from working in a bare repository root. The system prompt points them to the worktree
and handoff skills, and `write`, `edit`, `subagent`, and `subagent_follow_up` are refused there.
