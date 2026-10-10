---
'tau': minor
---

Agents can now cancel a Linear ticket after you approve a preview that shows the cancellation. The
tracker skill uses the team's state of type `canceled`. It refuses a completed ticket and a ticket
whose pull request merged. After a plan run, the slice skill asks which dropped slices to cancel,
instead of telling you to cancel them by hand. The `slice` tool's `dropped` list leaves out slices
that are already canceled.
