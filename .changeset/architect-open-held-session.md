---
'tau': patch
---

Refuse `architect open` while another live Pi holds the recorded session. `open` reads the session
lock before it launches a resume, names the holding terminal and pid, and starts no pane. End that
Pi once it is idle, then call `architect open` again.
