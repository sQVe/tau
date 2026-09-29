---
'tau': patch
---

Accept a worker's time blocker in the last 90 seconds of any window, and warn the worker once when
that point arrives. When a worker's final turn ends in an error or abort, skip the report reminder
and show the error as `failure` in the parent's status and notice.
