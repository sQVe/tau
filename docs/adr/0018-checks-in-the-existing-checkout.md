# ADR 0018: Run staged checks in the existing checkout

- Status: Proposed
- Date: 2026-09-11

## Context

Temporary candidate checkouts cannot reuse workspace dependency links reliably. Those links can
resolve to working sources outside the candidate. Copying repositories and installing dependencies
for every check adds cost and requires knowledge of each repository's tools.

## Options considered

- Keep temporary checkouts and share dependencies. Workspace links can check the wrong sources.
- Copy repositories and install dependencies. Slow and dependent on repository-specific setup.
- Temporarily present staged files in the existing checkout. Keeps installed dependencies usable but
  requires verified recovery and stopped writers.

## Decision

Run checks in the existing checkout. Use the verified raw recovery rules from
[ADR 0017](./0017-verified-raw-recovery.md) before hiding working edits. Restore before any review
or approval. Run reviews serially so speculative review cannot observe a hidden checkout.

Keep original ignore exclusions during the window. Changing staged ignore rules must not remove
installed dependencies. Reject unsupported layouts and checker writes rather than overwrite work.
Keep pending recovery and stop further commits when restoration is uncertain.

This replaces temporary candidate checkouts and optional dependency sharing retained by
[ADR 0013](./0013-explicit-repository-commit-commands.md). Keep preparation ownership, message
validation, and the final-commit-only hook policy unchanged.

## Tradeoffs

Checks use existing dependencies without installing anything. Recovery costs storage, and retained
archives need manual inspection before removal. Reference-transaction hooks still run when recovery
refs change; writes during backup can prevent authorization.

Cancellation stops and awaits cooperative POSIX process groups before restoration. Detached writers,
ignored dependencies, and arbitrary external writes remain outside that guarantee. Interrupted or
ambiguous file changes require manual recovery rather than a merge or forced restoration.
