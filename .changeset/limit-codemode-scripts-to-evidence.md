---
'tau': patch
---

Codemode scripts can no longer call `write`, `edit`, `commit`, or `run_tests`, in the manager or in
workers. The model still calls them directly. The codemode guidelines and the scout, reviewer, and
worker profiles now say to call `read` and `bash` directly for a single lookup, and to use codemode
only to batch several calls or filter output. Scripts print strings instead of result objects and
start with a 4000-token output limit.
