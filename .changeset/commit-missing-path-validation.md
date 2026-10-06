---
'tau': patch
---

Commit staged renames when a group lists both the old and new paths. Reject all unknown paths before
staging and list them in one error. Continue to accept deleted files that Git tracks.
