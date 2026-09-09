---
'tau': minor
---

Replace Pi's terminal footer with one line showing the directory, branch, dirty marker, cost,
context usage, model, and thinking level. The right group truncates first on narrow terminals. Use a
muted Latte palette with a dim gray directory, teal branch, and unchanged terminal background. Strip
terminal controls from displayed names. Extension statuses no longer appear in the footer. An ochre
open-lock glyph after the branch shows an explicitly disabled TDD gate or unreadable gate state. Use
`run_tests` or `/tdd status` for detailed TDD feedback.
