---
'tau': patch
---

A subagent launch no longer sends the text of a file outside `.tau/slices/` to the route classifier
when the ticket path in the brief is a symlink or sits below a symlinked directory. The launch reads
a ticket only when its real path is inside the outermost `.tau/slices` directory of the path, and
only from the file it checked.
