---
'tau': minor
---

Add a `stack` skill that detects, switches, restacks, and pushes stacked pull requests with
`gh stack`. In a stack, `pr-feedback` asks which PR to handle, switches to it, restacks the branches
above, and pushes the stack once. It compares failing checks with the trunk and the PRs below
instead of the parent branch. `update-branch` restacks with `gh stack rebase`, and `pr` adds new PRs
to the stack with `gh stack link`.
