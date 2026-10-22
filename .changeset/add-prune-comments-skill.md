---
'tau': minor
---

New `/prune-comments` skill deletes comments that do not name a wrong change a reader would make. A
fresh worker judges the comments of a branch diff or named files. The skill only deletes; it never
rewords or adds a comment.

The `/pr` skill runs `/prune-comments` on the branch diff instead of judging comments itself. A
failed run is a gap in the session report and does not block the PR.
