---
'tau': patch
---

Recover full-check locks held by zombie-only command groups. Share process lifecycle ownership
across checks, workers, reviews, and command runners so they use the same liveness and stopping
rules. Do not start a full check cancelled while acquiring its lock. Release that lock so the next
check can proceed.

Refuse already-cancelled QA URL commands before spawning a shell. Handle spawn errors when
cancellation occurs during startup so a missing shell cannot crash the session.
