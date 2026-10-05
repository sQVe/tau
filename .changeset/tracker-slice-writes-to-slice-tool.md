---
'tau': patch
---

`tracker` no longer gives manual commands to create slices, add or remove their dependencies, or
reorder them. It sends those writes to the `slice` tool, and containers and slices get no labels. It
keeps its commands for bugs, human tickets, agent tickets, dependencies outside the container, and
the In Progress move.
