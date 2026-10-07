---
'tau': minor
---

Skills now create and keep stacks with `gh stack`. The stack skill has one stack check that
`start-slice`, `update-branch`, and `pr` run before they create, rebase, or push a branch. A failed
check stops the skill instead of counting as no stack. `start-slice` can start a slice on a blocker
with an open PR, and `update-branch` never runs a plain `git rebase` on a stacked branch. The `pr`
tool's `base` now wins over an open PR's base, so `pr` moves an existing PR onto its stack parent.
