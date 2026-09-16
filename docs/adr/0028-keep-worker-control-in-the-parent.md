# ADR 0028: Keep worker control in the parent

- Status: Proposed
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

Adapt profile discovery and fresh lineage-only session seeding from
[pi-interactive-subagents at c3e8b53](https://github.com/amosblomqvist/pi-interactive-subagents/tree/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7).
Keep its [MIT notice](../../src/extensions/subagents/LICENSE). Replace tmux orchestration and
transient completion signals with herdr identity checks and validated, non-replacing records. Do not
port native continuation or restricted extension startup.

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
