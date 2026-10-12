---
'tau': minor
---

A code review after fixes now covers only the fix, the callers of the changed code, and the findings
it closes. The `code_review` tool saves a snapshot of the reviewed files with each capture, and a
new `fix` target diffs the current files against that snapshot. It returns the fix paths, and
returns `scope: "wholeTarget"` when the fix touches files its findings do not name. The code-review
skill then reviews the whole target again, as it does when you ask for a full review. Saved captures
move to version 2; a fix review refuses a version 1 capture. The manager sends all in-scope findings
back to the worker in one batch.
