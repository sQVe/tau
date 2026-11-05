---
'tau': patch
---

A worker that waits for an answer now stops waiting only when the inbox delivers a valid answer file
for its open question, or when a user message arrives. A handover or another inbox message no longer
ends the wait. A resumed worker whose open question already has a saved answer continues, and its
continuation prompt names the answer file.
