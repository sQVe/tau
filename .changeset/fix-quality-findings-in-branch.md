---
'tau': patch
---

Triage now fixes supported structure findings on the user's own work in the branch without asking,
when behavior stays the same, every caller is in the repository, and checks cover the change. It
asks once, in one batched question that recommends fixing in the branch, only when the fixes would
grow the change a lot, need a design decision, have uncertain behavior, or touch another stack
slice. It recommends a follow-up ticket only when code outside the repository uses the changed
contract. The `restructure` label now marks such large or risky fixes instead of any edit outside
the target.
