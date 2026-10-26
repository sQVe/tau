---
'tau': patch
---

Read only the current session's worker records for the worker widget, status, replies, cancellation,
notices, and name allocation, so a waiting manager no longer uses a CPU core when many older records
exist. Delete a stopped worker's records 14 days after their last write, keeping running workers,
unconfirmed cleanups, and the predecessors that kept follow-ups use. Refuse a follow-up of a worker
last written more than 13 days ago.
