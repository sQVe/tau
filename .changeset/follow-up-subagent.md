---
'tau': patch
---

Add the `subagent_follow_up` tool. It resumes an ended worker from its saved Pi session in a new
`hc` child with the saved loadout and package paths, a new assignment file, and a fresh deadline. It
refuses a missing session file, a session a running Tau worker uses, and an editing follow-up
without acceptance criteria.
