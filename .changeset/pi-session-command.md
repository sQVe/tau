---
'tau': patch
---

Add `pnpm pi-session`, which runs one headless Pi session that loads a Tau checkout, sends one
prompt, waits for the workers it launched, and saves the event log. The finish-slice skill now tells
the manager to run each manual check itself and never hand it to the user.
