---
'tau': minor
---

`full_check` and `mutation_check` now lock one checkout by default, so checks in different worktrees
of one repository run at the same time. Two checks in one checkout still run one at a time. Set
`fullCheck.lockScope` to `"repository"` in `.pi/tau.json` to keep one lock across all checkouts of
the repository, such as when checks share Docker ports. With the default scope, the tools no longer
need an `owner/name` origin.
