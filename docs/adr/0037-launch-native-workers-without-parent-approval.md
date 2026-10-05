# ADR 0037: Launch native workers without parent approval

**Date**: 2026-09-22\
**Status**: Superseded\
**Superseded by**:
[ADR 0058 (Run subagents only as Pi workers)](./0058-run-subagents-only-as-pi-workers.md). Before
that, report directory check superseded by
[ADR 0045 (Keep worker records per Tau checkout and worktree files in `.tau/`)](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)\
**Supersedes**:
the parent-user approval sentences in
[ADR 0033 (Use one generic native worker workflow)](./0033-use-one-generic-native-worker-workflow.md)\
**Related**:
[ADR 0033 (Use one generic native worker workflow)](./0033-use-one-generic-native-worker-workflow.md),
[ADR 0024 (Commit without human approval)](./0024-commit-without-human-approval.md), the earlier
removal of a confirmation that people were not present to answer

## Context

Non-Pi workers launch with native-controls, which Tau does not certify. ADR 0033 required the parent
user to approve the native argument list and the report area before each launch. In practice, every
launch asked twice for the same configuration: once from the model and once in a Tau dialog. People
approved without reading, so the dialog no longer carried a decision. The native harness runs its
own approval dialogs for the actions the worker takes, and Tau never answers or bypasses them.

## Decision

Launch non-Pi workers without a parent approval dialog. Launch validates the configuration and
returns the loadout. Removing the dialog and keeping the sandbox checks leaves the native harness's
dialogs as the real control.

### Sandbox checks

These sandbox checks remain, because they bound what Tau itself hands to the worker:

- The report directory must already exist inside the trusted cwd.
- The worker must request native-controls. Tau refuses stronger guarantees it cannot certify.
- Native arguments are a literal list, copied as given. Profiles do not add or translate them.

### Native approval

The native harness's own approval dialogs remain in force. Tau does not answer them and does not add
flags that skip them.

This replaces the parent-user approval sentences in
[ADR 0033](./0033-use-one-generic-native-worker-workflow.md): the approval requirement for native
launch arguments in its Decision section, and the user-approved report area. The rest of ADR 0033
stands.

## Consequences

### Positive

- A native launch needs one call and no user action, so unattended parents can launch workers.
- The model no longer pre-asks a question that Tau then repeats.

### Negative

- The user does not see the argument list or report area before the worker starts. The launch tool
  result and saved task records still show them.
- `configurationApproved` stays optional in the saved loadout schema so older records still
  validate, although nothing writes it now.

## Alternatives considered

### Keep the dialog

Keep the approval dialog. Rejected because it remains a formality that people click through, and it
blocks unattended launches.

### Remember approvals per configuration

Remember approvals per configuration tuple (kind, cwd, arguments, report area) and ask only for a
new tuple. Rejected because this adds saved state and an invalidation rule for a check the native
harness already performs on the actions that matter.
