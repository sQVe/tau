---
'tau': patch
---

After a review of your own branch or PR, `code-review`, `pr`, and `start-slice` fix the supported,
in-scope findings with `triage-findings` without asking. They still ask about findings that change
scope, product behavior, or policy. Someone else's PR and a read-only review stay review-only. `pr`
fixes the in-scope causes of failing checks, accepts checked fixes without asking for another
review, and rebases a branch locally with a notice. A force-push still needs preview approval.
`code-review` retries a worker once after a launch that failed before any model call. Worktree,
handoff, slice, and start-slice ask fewer questions when an approved task, ticket, or earlier
agreement already answers them.
