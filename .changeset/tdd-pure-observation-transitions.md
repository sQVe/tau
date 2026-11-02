---
'tau': patch
---

TDD hints no longer go missing after a session reset that happens while an edit is being checked. A
test run that went stale now stays stale until the next run, even when reading its inputs fails for
a while.
