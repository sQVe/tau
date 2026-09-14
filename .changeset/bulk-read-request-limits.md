---
'tau': patch
---

Reject bulk-read requests above the delegate's context-based limit, which reserves the output
allowance and ignores skipped binary files, before calling the provider, while keeping read trimming
enabled. Explicitly allow one retry for delegate requests and disable prompt-cache retention where
the provider supports it.
