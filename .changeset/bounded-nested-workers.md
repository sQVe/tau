---
'tau': minor
---

Allow nested Pi workers with exact inherited model and safety settings. Root workers and descendants
share one saved capacity cap, with immediate full or busy refusal instead of a queue. Waiting and
uncertain work retain capacity until cleanup is confirmed. Preserve child results without bypassing
pending parent clarifications.
