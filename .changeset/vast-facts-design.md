---
'tau': patch
---

Run Git commands through one shared runner so inherited repository and index settings do not
redirect commits or draft-review diffs. Keep completed-commit reporting separate from staging and
rollback without changing commit results.

Fix Git commands hanging after Git exits when a hook descendant keeps its output handles open.
