---
'tau': minor
---

A confident Jev pick now runs the worker on the routed model. A pick below the confidence cutoff, or
a failed classification, runs on the profile model. The `canary` route setting is gone: Tau no
longer reads it, so a route that still sets it gets the unknown-key warning and still loads. Task
records move to version 13 and no longer save a canary flag. Version 12 and 11 records stay
readable.
