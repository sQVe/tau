---
'tau': minor
---

Add Claude Code investigators and editing workers. Select `harness: claude` or use a profile with
`cli: claude`, and provide a Claude model. Workers share Tau's records, questions, nested
delegation, deadlines, and cancellation. Follow-ups can resume a completed worker's native
conversation after confirmed cleanup.

Claude workers require saved `bypassPermissions` settings with startup confirmation skipped, plus an
enabled CC Safety Net plugin that passes Tau's safety probe. Tau passes no permission flag. Native
delegation and questionnaires are unavailable; workers use Tau's parent-owned tools instead.

Worker status includes available native Claude token counts, not subscription allowance or invoiced
cost.
