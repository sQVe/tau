---
'tau': minor
---

Add `--auto-approve-commits` for unattended Pi runs. Commit confirmation is skipped, including when
no UI is available. Checks and comment review still apply. Reviews needing a human waiver return an
error instead of opening a dialog. Normal runs still require confirmation.
