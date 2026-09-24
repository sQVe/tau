# ADR 0037: Launch native workers without parent approval

- Status: Proposed; report directory check superseded by
  [ADR 0045](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)
- Date: 2026-09-22
- Supersedes: the parent-user approval sentences in
  [ADR 0033](./0033-use-one-generic-native-worker-workflow.md)

## Context

Non-Pi workers launch with native-controls, which Tau does not certify. ADR 0033 required explicit
parent-user approval of the native argument list and the report area before each launch. Tau showed
a confirmation dialog on every launch, and the launch tool description also told the model to ask
the user first. Every launch cost two approvals for the same configuration. People approved without
reading, so the dialog no longer carried a decision.

The native harness runs its own approval dialogs for the actions the worker takes. Tau adds no
bypass flags and never answers those dialogs.

## Options considered

- Keep the dialog. It remains a formality that people click through, and it blocks unattended
  launches.
- Remember approvals per configuration tuple (kind, cwd, arguments, report area) and ask only for a
  new tuple. This adds saved state and an invalidation rule for a check the native harness already
  performs on the actions that matter.
- Remove the dialog and keep the sandbox checks. The native harness's dialogs stay the real control.

## Decision

Launch non-Pi workers without a parent approval dialog. Launch validates the configuration and
returns the loadout.

These sandbox checks remain, because they bound what Tau itself hands to the worker:

- The report directory must already exist inside the trusted cwd.
- The worker must request native-controls. Tau refuses stronger guarantees it cannot certify.
- Native arguments are a literal list, copied as given. Profiles do not add or translate them.

The native harness's own approval dialogs remain in force. Tau does not answer them and does not add
flags that skip them.

This replaces the parent-user approval sentences in
[ADR 0033](./0033-use-one-generic-native-worker-workflow.md): the approval requirement for native
launch arguments in its Decision section, and the user-approved report area. The rest of ADR 0033
stands.

## Tradeoffs

- A native launch needs one call and no user action, so unattended parents can launch workers.
- The model no longer pre-asks a question that Tau then repeats.
- Cost: the user does not see the argument list or report area before the worker starts. The launch
  tool result and saved task records still show them.
- Cost: `configurationApproved` stays optional in the saved loadout schema so older records still
  validate, although nothing writes it now.

## See also

- [ADR 0033: Use one generic native worker workflow](./0033-use-one-generic-native-worker-workflow.md)
- [ADR 0024: Commit without human approval](./0024-commit-without-human-approval.md), the earlier
  removal of a confirmation that people were not present to answer
