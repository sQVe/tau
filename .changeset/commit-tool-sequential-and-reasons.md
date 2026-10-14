---
'tau': patch
---

The `commit` tool now runs alone, after the other tool calls of its turn, so a Git command in the
same turn no longer fails it on `index.lock`. A rejected subject now lists the allowed types and the
scope characters. A rejected sensitive path names the pattern it matched. The `fixup` schema states
that an amend needs a `body`.
