---
'tau': patch
---

`pr_feedback` no longer posts a reply or PR comment twice in two cases. First, when `gh` fails or Pi
stops it during a write, `posted.json` records the write as uncertain. A retry checks GitHub for a
new comment with the same text, and posts the write only when GitHub does not have it. Second,
`post` reads `posted.json` again after the confirm. When another session finished the same round
during the confirm, `post` posts nothing and asks you to read again. Two sessions that post at the
same moment can still both post.
