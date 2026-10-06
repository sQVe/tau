# ADR 0020: Run staged checks in the existing checkout

**Date**: 2026-09-11\
**Status**: Superseded\
**Superseded by**:
[ADR 0026 (Let Git hooks own commit checks)](./0026-let-git-hooks-own-commit-checks.md)

## Context

Staged files are the files and content selected for the commit. A temporary checkout is a separate
directory containing that selected content. Installed workspace dependencies can still link back to
the original checkout. For example, an app's installed dependency can link to a sibling library's
source directory. Reusing that link in a temporary checkout checks the working library, not its
selected content.

## Decision

Run staged checks in the current checkout with its installed dependencies. This preserves dependency
links, but it temporarily changes visible files.

Save and verify a backup before temporarily hiding unrelated working edits and presenting the
content selected for the commit. Hiding those edits prevents them from affecting the check result.
Restore them before any review or approval.

If another process writes during checks and makes restoration unsafe, stop further commits and
retain the backup rather than overwrite work. Reject unsupported states before hiding edits, such as
Git submodules or working data exceeding the 100 MiB backup limit. Keep installed ignored
dependencies available, but do not claim to protect their contents.

This replaces temporary checkouts and dependency sharing from
[ADR 0015](./0015-explicit-repository-commit-commands.md), using the backup-before-hiding decision
in [ADR 0019](./0019-verified-raw-recovery.md). It changes where checks run, not which checks,
reviews, approvals, or Git hooks are required.

## Consequences

### Positive

- Checks avoid new installs.

### Negative

- Checks temporarily change what editors and other processes see.
- Backups need storage; interrupted checks or uncertain file changes may require manual recovery.

## Alternatives considered

### Share dependencies with a temporary checkout

Share dependencies with a temporary checkout. Rejected because links can resolve to the wrong
sources.

### Copy and reinstall

Copy the repository and install dependencies again. Rejected because it is slow and requires
repository-specific setup.
