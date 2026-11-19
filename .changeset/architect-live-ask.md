---
'tau': patch
---

Let `architect` `ask` queue the question in the inbox of a live architect in this checkout. The
architect answers with `architect` `answer` and the ask ID, and the answer reaches only the lead
session that asked. An `unknown` ask retries with `askId` and the same message ID. The architect
saves a question only while it holds the lock the lead saw, and it checks this at the moment the
message is published. It cannot send its final handover while an ask is open. A close waits up to 10
seconds for answers and saves that are still in flight. It sends an answer with an unknown outcome
once more, then tells the lead to ask again about each ask that is still open. A refused resend
keeps an unknown ask open, because the first copy may still be saved.
