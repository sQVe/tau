---
'tau': patch
---

Restore Pi's cached model catalog when checking worker launches, saved replays, and worker startup.
This avoids false model mismatches without enabling catalog network requests or relaxing model,
provider, or safety checks. Preserve the cancellation error when catalog restoration is interrupted.
