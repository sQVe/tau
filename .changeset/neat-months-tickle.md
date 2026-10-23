---
'tau': patch
---

Recover full-check locks held by zombie-only command groups. Keep locks for permission-denied
command groups even when the process table omits them. Share process lifecycle ownership across
checks, workers, reviews, and command runners so they use the same liveness and stopping rules. Do
not start a full check cancelled while acquiring its lock. Release that lock so the next check can
proceed. Count separately captured stdout as activity so a command producing output is not stopped
as idle.

Refuse already-cancelled QA URL commands before spawning a shell. Handle spawn errors when
cancellation occurs during startup so a missing shell cannot crash the session.
