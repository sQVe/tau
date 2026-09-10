# ADR 0011: Commit preapproval at startup

- Status: Accepted
- Date: 2026-09-10

## Context

Unattended Pi workers can finish changes but wait indefinitely for Tau's commit confirmation. A
terminal UI does not mean a person is present. Task prompts cannot change the tool's approval
policy.

## Options considered

- Keep confirmation mandatory. Unattended workers cannot complete commits.
- Infer permission from herdr or a task prompt. Neither provides explicit commit authorization.
- Add a startup flag through Pi's extension API. The launcher can explicitly authorize commits
  without changes to Pi or herdr.

## Decision

Use `--auto-approve-commits` as process-scoped permission to skip normal commit confirmation. The
flag defaults to false and is not persisted in session history. A restarted process must receive it
again. It authorizes local commits, not review waivers or bypassing checks.

Keep authorization outside the model-callable tool arguments. A worker must not grant itself
permission through its commit request. Unresolved review findings and review failures return errors
rather than opening a waiver dialog in preapproved mode.

## Tradeoffs

- Launchers need only pass a flag for authorized unattended runs.
- Normal sessions retain manual confirmation.
- This is a policy for cooperative workers, not a security boundary against unrestricted shell
  access.
- Other extensions may still ask for user input. The flag does not promise a prompt-free process.
