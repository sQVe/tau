---
'tau': patch
---

A hidden `ask` whose launch reply is lost now settles from one fence outcome, `cancelled`, `gone`,
`adopted`, or `unresolved`, computed once and shared by every caller. The lead writes its ask record
as failed only for `cancelled` or `gone`, so a child that adopts after the last early read can still
save and return its answer. `adopted` waits on the child's process ID, and `unresolved` leaves the
record running with the unconfirmed-stop detail because the child may still adopt and answer. A
release or read failure is reported beside the outcome.

`open` uses the same outcome: `adopted` is a takeover, `cancelled` and `gone` report the launch
error, and `unresolved` reports the kept claim. The fence now waits for the takeover itself, so no
caller reads adoption or passes adoption and stop facts in.
