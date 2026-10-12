---
'tau': minor
---

The slice flow now writes to Linear without asking you first. The slice skill creates and updates
the container and slices, and the `slice` tool's `apply` no longer asks to confirm its writes or its
moves back into plan order. Its `declined` status is gone. start-slice moves the slice to In
Progress and creates its agent tickets without a preview, and adds a later agent ticket inside the
slice's outcome the same way. finish-slice posts or updates its audit comment without a preview.
Each skill reports what it wrote. Filing other tickets, adding relations by hand, and cancelling
tickets still need your approval.
