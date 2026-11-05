---
'tau': patch
---

Agents call a failing check, test, or tool run unrelated or pre-existing only after they reproduce
the same failure on the base or cite the log line that shows its cause. Until then they report it as
unexplained, and the PR step keeps it as a required action. Agents read the whole failure output,
not only its tail.
