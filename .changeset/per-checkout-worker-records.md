---
'tau': minor
---

Keep worker records per Tau checkout in `<agentDir>/tau/<checkout>/workers/`, so a record written by
one checkout never breaks another checkout's launch, history, or status. Tau no longer reads records
in `<agentDir>/tau/workers/` and leaves them in place.

Non-Pi workers now report to `<cwd>/.tau/workers/<taskId>/report.md`. The `subagent` tool no longer
takes `reportDirectory`. Tau writes `.tau/.gitignore` with `*` so `.tau/` stays out of Git in any
repository.
