---
'tau': patch
---

Pi workers now give a `blockerKind` with an incomplete report. A `time` blocker is accepted only in
the last tenth of the work window and is refused on every earlier attempt; other kinds keep the
existing early-report rule. Workers now measure remaining time on their own clock, so a worker
started after its parent no longer sees extra minutes.
