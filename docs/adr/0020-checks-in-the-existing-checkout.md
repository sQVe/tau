# ADR 0020: Run staged checks in the existing checkout

- Status: Proposed
- Date: 2026-09-11

## Context

Staged files are the files and content selected for the commit. A temporary checkout is a separate
directory containing that selected content. Installed workspace dependencies can still link back to
the original checkout. For example, an app's installed dependency can link to a sibling library's
source directory. Reusing that link in a temporary checkout checks the working library, not its
selected content.

## Options considered

- Share dependencies with a temporary checkout. Links can resolve to the wrong sources.
- Copy the repository and install dependencies again. Slow, and requires repository-specific setup.
- Check in the current checkout. Preserves dependency links but temporarily changes visible files.

## Decision

Run staged checks in the current checkout with its installed dependencies. Save and verify a backup
before temporarily hiding unrelated working edits and presenting the content selected for the
commit. Hiding those edits prevents them from affecting the check result. Restore them before any
review or approval.

If another process writes during checks and makes restoration unsafe, stop further commits and
retain the backup rather than overwrite work. Reject unsupported states before hiding edits, such as
Git submodules or working data exceeding the 100 MiB backup limit. Keep installed ignored
dependencies available, but do not claim to protect their contents.

This replaces temporary checkouts and dependency sharing from
[ADR 0015](./0015-explicit-repository-commit-commands.md), using the backup-before-hiding decision
in [ADR 0019](./0019-verified-raw-recovery.md). It changes where checks run, not which checks,
reviews, approvals, or Git hooks are required.

## Tradeoffs

Checks avoid new installs, but temporarily change what editors and other processes see. Backups need
storage; interrupted checks or uncertain file changes may require manual recovery.
