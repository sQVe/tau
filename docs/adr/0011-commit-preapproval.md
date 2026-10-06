# ADR 0011: Commit preapproval at startup

**Date**: 2026-09-10\
**Status**: Superseded\
**Superseded by**:
[ADR 0024 (Commit without human approval)](./0024-commit-without-human-approval.md)

## Context

Unattended Pi workers can finish changes but wait indefinitely for Tau's commit confirmation. A
terminal UI does not mean a person is present. Task prompts cannot change the tool's approval
policy.

## Decision

Use `--auto-approve-commits` as process-scoped permission to skip normal commit confirmation. A
startup flag through Pi's extension API lets the launcher explicitly authorize commits without
changes to Pi or herdr.

The flag defaults to false and is not persisted in session history. A restarted process must receive
it again. It authorizes local commits, not review waivers or bypassing checks.

Keep authorization outside the model-callable tool arguments. A worker must not grant itself
permission through its commit request. Unresolved review findings and review failures return errors
rather than opening a waiver dialog in preapproved mode.

## Consequences

### Positive

- Launchers need only pass a flag for authorized unattended runs.
- Normal sessions retain manual confirmation.

### Negative

- This is a policy for cooperative workers, not a security boundary against unrestricted shell
  access.
- Other extensions may still ask for user input. The flag does not promise a prompt-free process.

## Alternatives considered

### Mandatory confirmation

Keep confirmation mandatory. Rejected because unattended workers cannot complete commits.

### Permission from herdr or a task prompt

Infer permission from herdr or a task prompt. Rejected because neither provides explicit commit
authorization.
