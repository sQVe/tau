---
'tau': patch
---

Run Git commands through one shared runner so inherited repository and index settings do not
redirect commits or draft-review diffs. Keep completed-commit reporting separate from staging and
rollback without changing commit results. Keep commit objects in the working repository when Pi
inherits `GIT_OBJECT_DIRECTORY` or `GIT_ALTERNATE_OBJECT_DIRECTORIES`.

Fix Git commands hanging after Git exits when a hook descendant keeps its output handles open.
