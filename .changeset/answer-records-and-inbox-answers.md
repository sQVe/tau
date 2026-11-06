---
'tau': patch
---

Worker answers can be saved as immutable answer records beside the assignment. The inbox carries a
second message family, `answer`, in envelope and receipt version 2. Handovers are still written at
version 1, so a receiver on the earlier inbox reads them. The inbox can check a receiver's lease
before a send, and a send can refuse a lease that now names another session.

Managers answer a worker question with the `subagent_answer` tool instead of `hc send`. A running
manager must run `/reload` to get the tool. It saves the answer file, leaves `assignment.json`
unchanged, and queues one `answer` message to the worker's inbox. It refuses a worker without a live
inbox lease before it saves anything. A second call for an open question resends the saved answer.
