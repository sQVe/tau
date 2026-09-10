---
'tau': minor
---

Run configured commit preparation once per executed group after staging, then restage requested
files before checks and review. Preserve prior staging and working recovery data. Stop on ownership
conflicts or unassigned generated changes instead of accepting extra paths. Configured preparation
disables speculative reviews and later-group approve-all reuse. Recovery requires a supported local
POSIX checkout and covers up to 100 MiB of tracked and nonignored untracked working data. Git hooks
and post-commit guards remain enabled.
