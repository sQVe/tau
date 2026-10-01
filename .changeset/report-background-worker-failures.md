---
'tau': patch
---

Report background worker failures instead of dropping them. A failed stop, such as a failed timeout
notice, now appears in the worker's status. A failure to reattach saved workers at session start now
shows an error in the UI.
