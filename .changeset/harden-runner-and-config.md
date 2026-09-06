---
'tau': patch
---

Reject config globs that resolve outside the workspace, and harden the vitest runner so file-level
hook errors are reported, empty or dash-leading scoped paths cannot widen the run, and truncated
failure messages keep multi-byte characters intact.
