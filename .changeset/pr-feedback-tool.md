---
'tau': minor
---

`pr-feedback` reads review threads and comments, and posts replies, through a new `pr_feedback`
tool. The tool returns unresolved threads, review summaries, and conversation comments as data. It
posts replies, resolves threads, and posts one PR comment from a reply file. It posts nothing when a
person commented since the read, or when the PR head is not the one the round expects. Replies to a
person post only after you confirm the exact text in Pi. When a round has a reply to a person, it
posts nothing if you decline or there is no UI. Replies to bots post without a confirm. A retry
posts only the missing writes.
