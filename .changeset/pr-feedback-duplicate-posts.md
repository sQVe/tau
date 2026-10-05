---
'tau': patch
---

`pr_feedback` no longer posts a reply or PR comment twice. When `gh` fails or Pi stops it during a
write, `posted.json` records the write as uncertain. A retry checks GitHub and posts the write only
when GitHub does not have it. `post` also reads `posted.json` again after the confirm, so a second
session that finished the same round makes it stop and ask you to read again.
