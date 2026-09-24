---
'tau': minor
---

The same parent Pi session can reattach to workers after a restart when herdr confirms their saved
identity. Reattached workers keep their original deadline. Cancellation can also use saved ownership
when reattachment fails, without sending input to a changed worker. Earlier task records with
controller-instance ownership are skipped as retired.

Expired saved tasks get one cleanup attempt using their original cancellation budget, without
extending worker work.
