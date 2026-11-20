---
'tau': patch
---

Keep a refused live ask recoverable when the record update after the refusal fails. The lead sees
the refusal and the ask ID. It can restore record access and call `architect ask` with that ID in
the same session, which marks the ask failed without resending the question. The failed record no
longer blocks the architect's final handover.
