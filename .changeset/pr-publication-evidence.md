---
'tau': minor
---

Add a `pr` evidence action that gathers the publication target, saved review reuse and freshness,
and local check logs in one result. Report missing, stale, malformed, and truncated evidence as
gaps. Match check logs against their saved HEAD, status, and diff hashes. Use the read-only
`checkHeader` action to generate matching log headers, including for large branch diffs.
