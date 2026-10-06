---
'tau': minor
---

Add a `pr` evidence action that gathers the publication target, saved review reuse and freshness,
and local check logs in one result. Report stale reviews and missing, malformed, or truncated
evidence as gaps. Use only the newest log per check file name. Match its saved HEAD, status, and
diff hashes; an identity mismatch prevents reuse but is not a gap. Use the read-only `checkHeader`
action to generate matching log headers, including for large branch diffs.
