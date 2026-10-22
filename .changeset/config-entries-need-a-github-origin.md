---
'tau': patch
---

A per-repository config entry, such as `fullCheck.repositories.<owner/name>`, now applies only when
the `origin` remote is on `github.com`. A repository with the same `owner/name` on another host, or
a local `file:` remote, gets no entry. The tracker lines and the full check say when `origin` is not
on `github.com`. An SSH Host alias that points to `github.com` still counts.
