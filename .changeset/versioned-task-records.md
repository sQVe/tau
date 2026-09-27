---
'tau': patch
---

Save worker task records with a format version that no longer names the worker kind. Tasks saved in
the previous format stay readable. A task saved by a newer Tau is skipped with a notice to restart
the session, and it still blocks a second follow-up of the same source.
