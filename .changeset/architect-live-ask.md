---
'tau': patch
---

Let `architect` `ask` queue the question in the inbox of a live architect in this checkout. The
architect answers with `architect` `answer` and the ask ID, and the answer reaches only the lead
session that asked. An `unknown` ask retries with `askId` and the same message ID. The architect
saves a question only while it holds the lock the lead saw. It cannot send its final handover while
an ask is open. A close waits up to 10 seconds for an answer that is still sending, then tells the
lead to ask again about each ask that is still open.
