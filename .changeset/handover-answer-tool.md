---
'tau': patch
---

Give every lead session a `handover_answer` tool. It answers a handover question this session
received, by its question ID, and sends one answer to the asker. It reports `queued`, `refused` with
a reason, or `unknown` where a retry with the same answer is safe. It refuses a question this
session never received before it sends anything.
