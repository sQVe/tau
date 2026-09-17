---
'tau': minor
---

Share foreground space roughly equally between the parent and workers by adjusting only unchanged
Tau-created splits. Keep replacement workers roughly equally sized after verified owned cleanup.
Group background workers into inspectable tabs without a fixed worker count. Preserve focus, manual
split ratios, and unrelated panes. Use a separate tab when the parent cannot share useful space.

Follow stable terminal identity across workspace moves for cancellation and owned cleanup. Refuse
missing or ambiguous ownership, and abandon placement when the inspected layout changes. Preserve
confirmed pane references when cancellation interrupts layout inspection.
