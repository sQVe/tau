---
'tau': patch
---

Name subagent panes after their profile when it is named `worker`, `scout`, or `reviewer`, so
reviewers show as `reviewer-*` instead of `scout-*`. This includes user or project profiles that
override one of those names. Other custom profiles keep the role prefix. Saved `scout-*` and
`investigator-*` workers stay readable.
