# ADR 0028: Keep worker control in the parent

- Status: Accepted; settings reproduction and evidence-only recovery rules superseded by
  [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)
- Date: 2026-09-16

## Context

Worker timeouts must work on Linux and macOS while the parent Pi runs. The user chose trusted
full-tool workers with CC Safety Net, not separate permission classes or process containment.

## Options considered

- Adapt the upstream profiles and sessions, but keep control in the parent. This fits the required
  lifetime without a separate service.
- Run an independent supervisor. This would add recovery and process ownership rules for a lifetime
  the user does not require.
- Retain upstream restricted extension loadouts. This could remove the user's safety integration and
  would restore the discarded isolation model.

## Decision

Keep worker control in the parent Pi process. Use one monotonic deadline, including bounded cleanup
attempts. Recovery reads durable evidence without implying that an absent parent enforced a
deadline.

### Upstream adaptation

Adapt profile discovery and fresh lineage-only session seeding from
[pi-interactive-subagents at c3e8b53](https://github.com/amosblomqvist/pi-interactive-subagents/tree/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7).
Replace tmux orchestration and transient completion signals with herdr identity checks and
validated, non-replacing records. Do not port native continuation or restricted extension startup.

### Foreground placement

Replace upstream's window-wide `even-horizontal` rebalance with size-aware herdr placement. Track
only Tau-created foreground splits and adjust their unchanged ratios for roughly equal parent and
worker areas. Use native relative pane resizing, not layout replacement or cached split paths.
Discard a group's ratio ownership after unexplained layout changes. Retain surviving splits only
when a confirmed owned close matches the expected sibling collapse in live geometry. Preserve manual
ratios and unrelated topology, and use owned background tabs when useful space runs out.

### Cancellation during placement

Record confirmed terminal identity before cosmetic layout inspection. Cancellation during that
inspection releases placement ownership without claiming that an unverified worker stopped.

### Geometry and rechecks

Reserve room for pane chrome, and refuse areas too small for a useful tab. Track terminal identity
separately from its changing workspace-qualified pane ID. Recheck layout before each placement or
resize, and identity before input or closure. Herdr does not provide atomic compare-and-mutate
operations, so concurrent changes can still require manual cleanup. Never retry uncertain mutations
or restore a saved layout.

### Worker roles and settings

Worker roles describe assigned work, not security boundaries. Retain CC Safety Net and required
provider integrations. Refuse settings that cannot be reproduced rather than silently choosing a
model, provider, or unrestricted configuration.

## Tradeoffs

- Saved handovers and native references remain available after parent exit.
- Cost: failed cleanup can require manual action. Detached descendants are not contained.
- Cost: trusted workers can modify files directly. Receipt validation is not tamper-proof storage.
- Cost: provider credentials or settings changing between resolution and startup can cause refusal.
- Cost: macOS runtime behavior remains untested here; portable primitives do not establish a runtime
  result.
