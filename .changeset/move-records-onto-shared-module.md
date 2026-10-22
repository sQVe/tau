---
'tau': patch
---

The slice, start, ticket draft, `pr_feedback`, and full check records now share one read path and
one atomic write path. These error texts changed:

- A `pr_feedback` record that is not JSON, has the wrong shape, or is newer than Tau reads names the
  record: `Malformed replies record <path>: ...`, `Malformed posted record <path>: ...`,
  `Malformed pull request record <path>: ...`, and
  `Replies record <path> has a newer format than this Tau reads. Update Tau, then restart the session.`
  (also `Posted record`, `Pull request record`). Before, the texts started with `Malformed <path>:`
  or `<path> has a newer format ...`.
- A repository that fails to parse in `pull-request.json` now reads
  `Malformed pull request record <path>: ...`, where it read `Malformed <path>: ...`.
- Saving a record now refuses a symlink with `Refusing to write through a symlink: <path>`. The
  `pr_feedback` and full check records and `draft.json` did not refuse symlinks before.
- A failed full check record save no longer leaves a `.tmp` file.
