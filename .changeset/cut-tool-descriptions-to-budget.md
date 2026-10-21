---
'tau': patch
---

The `pr_feedback`, `code_review`, `stack`, `full_check`, `mutation_check`, and `tracker_evidence`
tool descriptions now fit their budgets. They keep every action and the result fields callers act
on, and drop internals and error lists. The commit tool guidelines no longer repeat the
sensitive-path rule the tool enforces. The manager session is about 11,000 characters smaller.
