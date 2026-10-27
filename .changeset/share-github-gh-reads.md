---
'tau': patch
---

`stack`, `pr_feedback`, and `pr` now run gh through the shared GitHub module, which owns the
non-throwing gh run, the checked JSON read, and the 100-result guard for `gh pr list`.
