# ADR 0033: Use one generic native worker workflow

- Status: Accepted; parent-user approval rules superseded by
  [ADR 0037](./0037-launch-native-workers-without-parent-approval.md); report area rule superseded
  by [ADR 0045](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md); the saved Pi
  record shape (fingerprints, `noExtensions`, tree ancestry) superseded by
  [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)
- Date: 2026-09-19
- Supersedes: [ADR 0032](./0032-run-claude-workers-through-a-parent-owned-channel.md)

## Context

Pi exposes structured worker controls through its SDK. Other interactive harnesses do not share that
interface. Reproducing Pi's guarantees through a separate hook and tool bridge for each harness
would make Tau responsible for unrelated permission systems and native session formats.

The user chose native safety controls for non-Pi workers. Herdr provides shared terminal operations,
but it cannot certify native permissions, model selection, task acceptance, or conversation replay.

## Options considered

- Keep the Claude bridge and add harness-specific adapters. This preserves deeper integration for
  Claude, but makes each new harness another permission and lifecycle implementation to maintain.
- Use one herdr workflow for every non-Pi kind and state its weaker guarantees. This keeps Tau's
  ownership rules shared without treating unrelated native controls as equivalent to Pi's SDK.

## Decision

Use one generic herdr workflow for all supported non-Pi kinds. Keep Pi's structured controls and
verified safety integration separate.

Treat native launch arguments as a literal list, not shell code or profile authority. Leave native
defaults, integrations, and approval dialogs intact. Refuse requests for stronger guarantees rather
than silently downgrade them. Record model requests without claiming that Tau verified the model
used. Do not add per-harness argument translators, settings mergers, hook bridges, transcript
parsers, or cancellation-key tables.

Keep task identity, scope, deadlines, admission, placement, and cleanup decisions in the existing
parent controller. Native text delivery is an observation, not Pi acceptance or acknowledgement.
Uncertain delivery does not authorize a retry. Native approval waits consume the original deadline
and capacity.

Require a task-specific completed report in an existing writable area inside cwd. Save an immutable
parent receipt after bounded file validation. This separates explicit handover from idle state,
terminal text, or process exit without depending on a native transcript format.

Retired Claude records and ancestry are not read, migrated, or continued. Saved Pi worker records
must carry the current shape: an explicit `pi` harness, provider fingerprint version 2, the
`noExtensions` audit field, and tree ancestry. An unsupported old record fails validation; Tau does
not reconstruct missing fields or read an older credential-sensitive fingerprint. Defer non-Pi
native continuation because opaque native references do not prove that an unchanged configuration
can be reproduced. A new contract requires a fresh task.

## Tradeoffs

- One controller owns capacity and deadlines across Pi and native workers.
- Existing native integrations stay under user control.
- Cost: native permissions and model selection remain unverified by Tau.
- Cost: non-Pi workers have no Tau nesting channel or structured question acknowledgement.
- Cost: terminal interrupts are best-effort, not containment. Uncertain cleanup requires manual
  inspection. Tau does not promise enforcement after parent exit.
- Cost: reports require an existing writable area and leave task files there. A saved receipt proves
  delivery, not answer correctness.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0030: Claim native follow-ups before opening](./0030-claim-native-follow-ups-before-opening.md)
- [ADR 0031: Reserve worker capacity under one tree lock](./0031-reserve-worker-capacity-under-one-tree-lock.md)
