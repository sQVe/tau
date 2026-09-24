---
'tau': minor
---

The same parent Pi session can reattach to workers after a restart when herdr confirms their saved
identity. Reattached workers keep their original deadline. Cancellation can also use saved ownership
when reattachment fails, without sending input to a changed worker. Earlier task records with
controller-instance ownership are skipped as retired.

Expired saved tasks get one cleanup attempt using their original cancellation budget, without
extending worker work.

Reattachment respects the parent's live-worker cap, and shutdown stops workers whose reattachment
checks are still pending. Workers waiting for a reply survive a parent crash until the original
deadline, while a clean parent close still ends the wait.
