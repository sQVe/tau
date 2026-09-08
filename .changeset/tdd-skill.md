---
'tau': minor
---

Add the `tdd` skill, which explains the red-green-verified cycle that `run_tests` enforces and how
to recover a locked phase. The footer now shows the current phase and active behavior. It is set at
session start, after every `run_tests` call and `/tdd` command, and from the read the write guard
already makes, so a write that invalidates evidence corrects the footer on the next guarded call.
