---
'tau': minor
---

Run each Pi worker as its pane's own process instead of typing Pi into a shell. A Pi worker that
finishes, is cancelled, or times out no longer leaves its pane or an empty "Tau workers" tab behind.
Pi workers started by an earlier Tau cannot be reattached; start a fresh task instead.
