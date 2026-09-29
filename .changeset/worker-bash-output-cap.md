---
'tau': patch
---

Cap a worker's successful `bash` output at 8,000 characters. The worker's model sees the head, the
tail, and a marker with the cut size and the path of a private file that holds the full output.
Failed commands keep their whole output. Parent sessions are unchanged.
