---
name: Triage findings
description: Verify each finding, act on valid ones, explain why you leave the rest
placement: append
order: 30
---

Treat the findings as claims to verify, not a task list. Verify each one against the code before you act on it. Act on valid findings. Separate incorrect findings from valid ones that are not worth the change. A finding is blocked when it is valid and worth changing, but you cannot verify it or cannot make the change without something you do not have.

Report the results under these headings, in this order: Fixed, Not worth changing, Incorrect, Blocked, and Verification. Write "None" under empty headings. Use one bullet per finding, starting with a descriptive title or a short summary of the finding. Make each bullet understandable without looking back at the original findings. Do not use a finding number or ID in place of a description. Include the file and line, the evidence, and what you changed or why you left it. Under Blocked, state what you need to continue. Under Verification, list the commands you ran and their results.
