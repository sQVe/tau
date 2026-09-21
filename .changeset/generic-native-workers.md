---
'tau': minor
---

Replace the Claude execution bridge with one generic herdr workflow for non-Pi workers. Native
configuration needs explicit user approval. Native controls remain in force, but Tau does not verify
their enforcement or the model used. Completed report files provide durable handover; plain-text
delivery does not imply task acceptance.

Keep Pi's safety checks, questions, reports, nesting, and native follow-ups. Saved Pi worker records
now require the current shape: an explicit `pi` harness, provider fingerprint version 2, the
`noExtensions` audit field, and tree ancestry. Records from an earlier saved format, including
retired Claude records, are not read, migrated, or continued; start a fresh task. Native waits keep
their original deadline, and uncertain delivery or cleanup never triggers an automatic retry.
