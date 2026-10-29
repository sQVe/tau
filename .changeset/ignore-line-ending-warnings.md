---
'tau': patch
---

Review captures no longer fail when Git prints its line-ending conversion warning for a CRLF file
that `.gitattributes` normalizes. Other stderr output and failed Git commands still fail the
capture.
