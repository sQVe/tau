---
'tau': patch
---

Count only the deadline warning's timer in the worker deadline warning tests. Git arms a timer to
drain a child's streams when the child exits, and the worker scan runs git without the test awaiting
it, so a count of every pending timer failed the mutation dry run under load.
