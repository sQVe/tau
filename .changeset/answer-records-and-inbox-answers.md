---
'tau': patch
---

Worker answers can be saved as immutable answer records beside the assignment. The inbox carries a
second message family, `answer`, in envelope and receipt version 2, and still reads version 1
handovers. The inbox can check a receiver's lease before a send, and a send can refuse a lease that
now names another session.
