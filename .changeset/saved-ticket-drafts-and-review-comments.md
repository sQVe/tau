---
'tau': minor
---

The tracker skill keeps each ticket draft and its Linear identifier in `.tau/tickets/<id>`, which
the new `tracker_draft` tool prepares. A rerun updates the saved ticket after a preview of the
changed fields, instead of creating a duplicate. The code-review skill posts its report, without
asking, as one comment on the ticket under review, and a rerun updates that comment. A review with
no ticket keeps only its local report.
