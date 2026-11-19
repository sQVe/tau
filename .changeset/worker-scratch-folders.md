---
'tau': patch
---

Give each worker launch and follow-up a scratch folder outside `/tmp`, set as `TMPDIR`, `TMP`, and
`TEMP`. A failed or cancelled launch removes its folder.
