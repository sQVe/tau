# ADR 0023: Use advisory TDD observations instead of edit permissions

- Status: Accepted
- Date: 2026-09-13
- Supersedes: [ADR 0012](./0012-shared-tdd-state.md)

## Context

ABU-364 replaces blocking TDD enforcement. Formatting could invalidate saved evidence and require
focused renewal even after the full suite passed. Shared permission state also required disk
schemas, migration, and cross-process locks. That machinery could control edits but could not judge
whether a failing assertion proved useful behavior.

## Options considered

- Keep the gate and improve evidence renewal. This retains permission failures unrelated to actual
  test outcomes and the shared-state machinery needed to resolve them.
- Persist reminders instead of permissions. This removes blocking but keeps synchronization and
  migration costs for advice that does not need to survive a session.
- Keep session-local observations and short hints. This preserves test feedback without making
  historical RED evidence a condition for editing or accepting a full-suite pass.

## Decision

Use nonblocking TDD hints backed by session-local observations, not saved edit permissions. The
project owner approved this design for ABU-364. Remove the guard, permission state, and `/tdd`
switches. Keep runner outcomes and commit checks, requested-file safeguards, review, and approval
independent of hints.

Track one active behavior and the latest run. A full pass starts the next cycle without requiring
prior RED or focused renewal after formatting. Deduplicate hints by meaningful transitions, not
individual edits. Do not persist reminder history.

Keep content fingerprints over the existing source, test, and configuration coverage. Compare at
bounded checkpoints rather than adding watchers or an mtime cache. If inputs change or cannot be
read, report stale or unknown freshness without discarding the runner's actual outcome. Order runs
and observation checkpoints within the session; do not coordinate permission state across processes.

## Tradeoffs

- Edits cannot fail because TDD evidence is absent, stale, or unreadable.
- Runner results remain useful even when freshness cannot be established.
- Cost: one active behavior forgets RED when work switches to another behavior or session.
- Cost: fingerprints detect external changes only at checkpoints. They are not atomic snapshots.
- Cost: hints cannot enforce test quality or prove that every change had a failing test first.
- Commit safety still depends on staged-candidate checks and explicit approval, not TDD history.
