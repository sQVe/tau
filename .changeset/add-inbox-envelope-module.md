---
'tau': patch
---

Add a shared inbox record and send path. A session can queue one handover envelope for another
terminal with a live inbox lease by writing a versioned envelope under its own `.tau/inbox/` and
setting one `tau.inbox.<messageId>` label. Refusals and an over-limit envelope queue nothing. A
label write failure reports that the label may or may not be set and is not retried.
