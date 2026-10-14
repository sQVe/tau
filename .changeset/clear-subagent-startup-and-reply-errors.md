---
'tau': patch
---

The passive-wait guard no longer refuses a command whose heredoc body or quoted text contains a long
`sleep`. A real long `sleep` while a worker runs is still refused. A worker that fails before
readiness now saves its error, and the launch error includes it. When Tau was updated on disk after
the session loaded it, the launch error says to restart the session. A second, different reply to a
worker question now says the question already has an answer and to use `subagent_follow_up` after
the worker stops.
