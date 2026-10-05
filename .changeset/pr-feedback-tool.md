---
'tau': minor
---

`pr-feedback` reads review threads and comments, and posts replies, through a new `pr_feedback`
tool. The tool returns unresolved threads, review summaries, and conversation comments as data. It
posts replies, resolves threads, and posts one PR comment from a reply file. It posts nothing when a
person commented or the PR head moved since the read. Replies to a person post only after you
confirm the exact text in Pi, and nothing posts when you decline or when there is no UI. Replies to
bots post without a confirm. A retry posts only the missing writes.
