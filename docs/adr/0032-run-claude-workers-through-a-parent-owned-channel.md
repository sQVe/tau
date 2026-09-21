# ADR 0032: Run Claude workers through a parent-owned channel

- Status: Superseded by [ADR 0033](./0033-use-one-generic-native-worker-workflow.md)
- Date: 2026-09-18

## Context

Claude Code cannot load Pi extensions. Tau needs another way to apply its worker lifecycle without
building a second controller. Claude supports lifecycle hooks and Model Context Protocol (MCP)
servers, which let an external process provide tools.

The upstream reference launched Claude with `--dangerously-skip-permissions` and used a Stop-hook
sentinel plus transcript text as the handover. Tau must not grant permissions the user did not
choose. A finished turn also does not prove that the parent accepted a result.

## Options considered

- Put a separate controller beside Claude. This duplicates ownership of admission, records, and
  deadlines across processes.
- Use the Stop hook and transcript as the result. This cannot distinguish an idle worker from an
  accepted handover.
- Serve worker tools and hook decisions from the existing parent controller. This keeps one owner
  for task state, but requires the parent to remain alive.

## Decision

Run Claude workers through the existing lifecycle, with a parent-owned control channel.

A dependency-free script carries hook payloads and MCP messages between Claude and the parent. The
parent validates requests and owns records, admission, and deadlines. Keeping these decisions in one
process avoids a second implementation of Tau's lifecycle.

Require saved full-tool permissions rather than passing a permission flag. Refuse configurations
that would need interactive approval. Require safety-integration evidence before allowing work, not
merely an enabled plugin entry. Full tools and safety hooks are not a sandbox.

Use an explicit report tool for handover. A finished turn is lifecycle evidence, not a result. Keep
lineage in Tau's task records because Claude owns its native transcript format.

## Tradeoffs

- Both harnesses share lifecycle decisions instead of maintaining separate controllers.
- Cost: workers cannot report after their parent exits. Blocking hooks refuse further work when the
  channel is unavailable.
- Cost: saved settings and safety integration must still match before replay. Configuration changes
  can require a fresh task.
- Cost: cancellation uses terminal input, not process containment. Workers that ignore interrupts
  require manual cleanup.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0030: Claim native follow-ups before opening](./0030-claim-native-follow-ups-before-opening.md)
- [ADR 0031: Reserve worker capacity under one tree lock](./0031-reserve-worker-capacity-under-one-tree-lock.md)
