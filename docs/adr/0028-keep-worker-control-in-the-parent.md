# ADR 0028: Keep worker control in the parent

**Date**: 2026-09-16\
**Status**: Accepted; settings reproduction, evidence-only recovery, foreground placement
rebalancing, and cancellation-during-placement rules superseded by
[ADR 0043 (Own only the worker guarantees herdr lacks)](./0043-own-only-the-worker-guarantees-herdr-lacks.md).
Herdr owns layout after placement. The manual cleanup cost is superseded by
[ADR 0059 (Run each Pi worker as its pane's own process)](./0059-run-each-pi-worker-as-its-panes-own-process.md).

## Context

Worker timeouts must work on Linux and macOS while the parent Pi runs. The user chose trusted
full-tool workers with CC Safety Net, not separate permission classes or process containment.

## Decision

Keep worker control in the parent Pi process. Adapting the upstream profiles and sessions while
keeping control in the parent fits the required lifetime without a separate service.

Use one monotonic deadline, including bounded cleanup attempts. Recovery reads durable evidence
without implying that an absent parent enforced a deadline.

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

## Consequences

### Positive

- Saved handovers and native references remain available after parent exit.

### Negative

- Failed cleanup can require manual action. Detached descendants are not contained.
- Trusted workers can modify files directly. Receipt validation is not tamper-proof storage.
- Provider credentials or settings changing between resolution and startup can cause refusal.
- macOS runtime behavior remains untested here; portable primitives do not establish a runtime
  result.

## Alternatives considered

### Independent supervisor

Run an independent supervisor. Rejected because this would add recovery and process ownership rules
for a lifetime the user does not require.

### Upstream restricted extension loadouts

Retain upstream restricted extension loadouts. Rejected because this could remove the user's safety
integration and would restore the discarded isolation model.
