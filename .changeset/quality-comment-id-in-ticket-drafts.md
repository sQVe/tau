---
'tau': minor
---

The ticket draft record `draft.json` is now version 2 and adds `qualityCommentId` beside
`reviewCommentId`. Tau still reads a version 1 record, as version 2 with `qualityCommentId` null.
