---
'tau': minor
---

Give editing workers the complete outcome: acceptance criteria, the assignment baseline, editing
ownership of a worktree the parent gives to one editor, and the Changes, Evidence, Decisions, and
Concerns handoff. Pi and generic herdr workers receive the same contract, while investigators keep
their read-only boundary.

Saved handoffs ask for a content reference captured at check time: a saved full diff plus hashes of
relevant untracked files, alongside the assignment baseline. A separate output path names the check
result, and the worker states when the current work cannot be compared to that reference. Status
marks which handoff section headings a saved report is missing, so older or incomplete reports stay
honest without reading evidence strings.

Wake the parent manager for terminal worker notices, including success, failure, incomplete, and
undelivered outcomes, so an idle manager reacts without a new user prompt. Question notices keep
steering.

Treat a saved report as the worker handoff. Its reported checks are reusable evidence for the work
state they name; repeat a check only for a concrete reason. Review still reads the diff, and
accepting evidence is not accepting correctness.

Run one full suite: a repository full check satisfies full verification, so do not repeat the suite
only for bookkeeping.
