---
'tau': patch
---

`pr_feedback read` checks `gh` auth first. It returns the PR's state, base and head branches, head
repository and owner, fork fields, and `mergeable`, read again up to three times while it is
`UNKNOWN`. It refuses when the PR is no longer open after one of those reads, and refuses with a
read-again error when any other field changes during them.

`pr_feedback checks` adds `trunkMatches` to each failing GitHub Actions check: the latest five trunk
runs of its workflow where a job with the same name failed. The trunk is the PR's base branch, or
the optional `trunk` parameter for a stack. A trunk read that fails becomes a gap on the check. The
pr-feedback skill uses these matches and `read`'s PR fields, and no longer runs `gh pr view`.

A failed-log excerpt that cuts a long line now reports `omittedCharacters`, and every cut excerpt
carries the command that reads the full log. Returned commands quote each argument a shell would
split, such as a workflow name with a space.
