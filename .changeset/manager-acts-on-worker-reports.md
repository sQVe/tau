---
'tau': patch
---

Tell the manager to act on a worker report without waiting for the user. It sends in-scope reviewer
findings on a delegated change back to the worker, unless a skill it follows requires approval
first. After any report, it starts the next step it owns. It asks only when that step needs a
decision it cannot make, and it reports and stops when the work is done.
