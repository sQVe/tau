---
'tau': minor
---

`qa` workers read per-repository settings from `qa.repositories` in the user `tau.json`. When a
launch has no `url`, Tau runs the entry's `urlCommand` in the worktree and checks the address it
prints. The brief names the `testAccountCommand` the worker runs for the test account, and says
whether the worker may create data in the dev database. The `pr` skill now runs QA before its
preview for changes with user-visible behavior, and opens the PR as a draft when QA did not pass.
