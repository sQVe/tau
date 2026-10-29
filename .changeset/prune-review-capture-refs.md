---
'tau': patch
---

`code_review` prepare now removes `refs/tau/review-captures/` refs that no capture needs, so
`git gc` can drop the objects of old reviews. It removes a ref when no worktree holds its review
directory, or when the directory has no `capture.json` and no write for a day. It keeps the ref of a
completed capture while its review directory exists, and of every review that a fix capture compares
against.
