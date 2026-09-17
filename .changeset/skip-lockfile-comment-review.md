---
'tau': patch
---

Leave lockfiles such as `pnpm-lock.yaml` and `Cargo.lock` out of commit comment review, so large
lockfiles no longer block commits. Commits that change only lockfiles skip review.
