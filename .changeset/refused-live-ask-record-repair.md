---
'tau': patch
---

Keep a refused live ask recoverable when the record update after the refusal fails. The lead sees
the refusal and the ask ID. It can restore record access and call `architect ask` with that ID in
the same session, which marks the ask failed without resending the question. If the ask lock is
held, the repair stops before waiting and asks the lead to retry the same ID after the lock
releases. A repair that still fails reports the failure without claiming the ask is still sending.
The failed record no longer blocks the architect's final handover.
