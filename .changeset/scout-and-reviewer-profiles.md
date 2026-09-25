---
---

Rename the built-in `investigator` subagent profile to `scout` and add a read-only `reviewer`
profile. Saved `investigator-*` workers stay readable. The scout no longer edits files, and the
worker profile drops rules its contract already sets.
