---
'tau': patch
---

Run a leased inbox receiver in every Tau session. Each session advertises its Pi session ID on
`tau.inbox`, scans for version 1 envelopes, shows each valid handover once as a displayed message,
and removes the label only after the saved message entry proves the receipt. Invalid envelopes show
one notice and stay queued for another session.
