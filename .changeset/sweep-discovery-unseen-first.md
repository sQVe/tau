---
'tau': patch
---

The improvement sweep now reads session transcripts it has not seen before it retries unresolved
ones. A transcript that never resolves no longer uses the sweep budget ahead of new transcripts, so
new tasks are still discovered.
