---
'tau': patch
---

`tracker` no longer gives manual commands to create slices, add or remove their dependencies, or
reorder them. It sends every write to a container and its slices to the `slice` tool. It keeps its
commands for bugs, human tickets, agent tickets, title or body updates, and the In Progress move.
