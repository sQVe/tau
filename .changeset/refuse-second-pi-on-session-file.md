---
'tau': patch
---

Refuse a second Pi that opens a session file another Pi holds. The second Pi shows the holder's
terminal and exits before other Tau handlers run, so it no longer takes over the first Pi's inbox
label. `/resume` onto a held session file is cancelled.
