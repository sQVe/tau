---
'tau': minor
---

`pr_feedback` gets a read-only `checks` action. It returns each check of a pull request with its
name, workflow, bucket, state, and link. For each failing or cancelled GitHub Actions job, it adds
the end of the failed-step log. It returns a gap for each piece of evidence it could not read, such
as a failed `gh` command, a link that is not a GitHub Actions job, or an empty log. A gap never
counts as a passing check.
