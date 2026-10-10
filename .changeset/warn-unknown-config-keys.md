---
'tau': patch
---

Warn once per session about unknown keys in `tau.json` and `.pi/tau.json`, at any depth under
`profiles`, `tracker`, `browser`, and `tdd`, instead of failing. A newer Tau can then add a key
without breaking older checkouts that read the same user file. Wrong types and missing fields still
fail, but only the entry they are in: a bad `profiles.scout` blocks only `scout` launches, a bad
route turns routing off for its profile and keeps its `model`, and a bad `tracker.repositories`
entry fails only the repository it names.
