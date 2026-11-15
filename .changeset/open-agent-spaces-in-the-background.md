---
'tau': patch
---

Spaces and tabs that agents open now stay in the background. The `handover` tool's `start` action
and the worktree skill pass `focus: false` to Herdr, so the user keeps the shown space, the selected
tab, and keyboard focus. This needs Herdr 0.1.16 or later.
