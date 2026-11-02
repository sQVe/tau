---
'tau': minor
---

`draft_review` now opens tuicr in a new tab of the manager's hc space, and `collect` waits for `hc`
to report the tuicr terminal ended before reading comments. Review records move to format version 4
and save the hc address. Records from versions 1 to 3 are refused with a message that names the
staging directory, keeps the tuicr comments, and asks for a new review.
