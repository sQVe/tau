---
'tau': minor
---

A route in `tau.json` can set `confidence`, the lowest Jev confidence from 0 to 1 that counts as a
pick. Without it, the cutoff is 0.7. A value outside 0 to 1, or not a number, turns routing off for
that profile only. Task records move to version 12 and save the cutoff the pick used. Version 11
records stay readable.
