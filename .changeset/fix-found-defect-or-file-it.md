---
'tau': patch
---

Add a workflow rule to fix a found defect at its cause in its own space, or file a bug ticket when
it cannot be fixed now. A failing check gets its cause fixed, or a bug ticket when the fix cannot
happen now, never a skipped check or a resource cap that hides the cause. The fix-bug skill files
that ticket through the `tracker` skill and needs none for a defect it fixes, unless the user asks.
