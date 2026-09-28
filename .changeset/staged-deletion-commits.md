---
'tau': patch
---

Commit an already-staged deletion in its group instead of failing at `git add`. A failed group no
longer unstages changes that were staged before the call; it restores their earlier staging.
