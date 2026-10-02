---
'tau': patch
---

Check that a plan is ready before an implementation handoff or a worktree for one. The handoff skill
defines ready: the goal, the scope and what it excludes, the acceptance criteria, and every choice
that changes the result are in the ticket or approved by the user, and its blockers are merged. When
something is open, the sender asks its user and sends nothing, unless the user asks for a
planning-only handoff that lists the open questions. Each implementation handoff carries a plan
status of "agreed, nothing open", and the receiver asks its user before editing if the ticket
conflicts with the message. The worktree skill creates a worktree only when the user asks for one.
