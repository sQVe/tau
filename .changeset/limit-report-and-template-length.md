---
'tau': patch
---

`subagent_report` refuses a summary over 3,000 characters and asks the worker to save the details to
a file and resend a shorter summary. The worker profiles give the same limit. Ticket templates aim
for about 250 words with details in linked files, the PR fallback template states its 100 to 150
word target, and the manager prompt asks for replies that lead with the answer and aim for about 150
words.
