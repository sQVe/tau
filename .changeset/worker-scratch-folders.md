---
'tau': patch
---

Give each worker launch and follow-up a scratch folder outside `/tmp`, set as `TMPDIR`, `TMP`, and
`TEMP`. A failed or cancelled launch removes its folder. Remove the scratch folders of ended workers
and package snapshots that no running worker uses after 24 hours. Each worker scan and each launch
runs the sweep.
