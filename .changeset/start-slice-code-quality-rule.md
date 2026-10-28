---
'tau': patch
---

The start-slice skill no longer asks whether to run code-quality. It runs code-quality when the
slice diff changes at least 100 lines of source code, and skips it for docs, config, or test only
diffs and for mechanical changes such as renames. It tells the user "ran code-quality" or "skipped:
<reason>", and the user can still ask for a run after a skip.
