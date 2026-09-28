---
'tau': patch
---

Make the pr skill ask every question with `ask_user_question`, move an update's body to the template
when it does not follow it, keep scratch files out of `/tmp`, save real check output after the
task's changes are committed, and ignore GitHub's dropped trailing newlines when it verifies the
body. Areas a reviewer read shallowly no longer force a draft, and when the review is the only gap
the skill asks once, before the preview, whether to accept approved fixes, review again, or open as
draft. Code review reports shallow reads as notes apart from gaps. The body leaves reviewer notes to
the summary, and bot suggestions include bots the repository configures.
