---
'tau': patch
---

Send handovers through the inbox instead of `hc send`. The `handover` tool's `send` action now
returns `{ status: 'queued', terminal, messageId }` and types nothing into the receiver. A receiver
that is not listening is refused with an error that names `handover start`. The handover skill ends
the turn after `queued` and tells the user about a refusal.
