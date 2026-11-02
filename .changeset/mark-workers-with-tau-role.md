---
'tau': patch
---

Tau detects a worker process from `TAU_ROLE=worker` instead of from the task record folder. The
record folder path stays in `TAU_WORKER_RECORD`, so a process with only the folder set runs as a
manager.
