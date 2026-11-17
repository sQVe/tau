---
'tau': patch
---

The `pr-feedback` skill reads `pr evidence` for each manual verification item after a rebase, and
reruns a stale item or reports it as not run before recommending merge. A review that did not
complete, or whose state is failed or contradictory, is now unknown and reported as a limitation
instead of clean.
