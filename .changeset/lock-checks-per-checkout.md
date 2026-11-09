---
'tau': minor
---

`full_check` and `mutation_check` now lock one checkout by default, so checks in different worktrees
of one repository run at the same time. Two checks in one checkout still run one at a time. Set
`fullCheck.repositories.<owner/name>.lockScope` to `"repository"` in the user's
`<agent directory>/tau.json` to keep one lock across all checkouts of that repository, such as when
checks share Docker ports. The user file gives every worktree the same scope, whatever its branch.
Without a matching entry or an `owner/name` origin, the tools use the checkout scope.
