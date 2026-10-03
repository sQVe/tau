---
'tau': patch
---

Make the handoff, worktree, and commit skills clearer and shorter. The handoff skill now reads the
manager pane and asks the user when the manager pane is not at its shell prompt. After a stalled
send, it reads the receiver once and never sends again. If the message did not show, it reports
uncertain delivery and stops. It reports any other send error and stops. The commit skill unstages
only staging that the agent or the user created.
