---
'tau': patch
---

Remove the `subagent_history` tool and the `/subagents` command. Subagents now tracks only workers
launched by the current session, live or stopped. Follow-ups refuse workers from other sessions,
including forks. The worker widget, status, replies, cancellation, and reattachment after the same
session restarts remain available. Task records older than the current format are skipped without
upgrades or changes to their saved files.
